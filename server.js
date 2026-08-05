const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: 5e6
});

app.use(express.static(__dirname));

const DAILY_COINS = 5;
const COIN_RESET_MS = 24 * 60 * 60 * 1000;
const DATABASE_FILE = path.join(__dirname, 'database.json');
const LEGACY_USERS_FILE = path.join(__dirname, 'users.json');
const waitingQueue = [];

/** @type {Map<string, object>} deviceId -> user record loaded from database.json */
const profiles = new Map();
/** @type {Map<string, object>} socketId -> { socket, deviceId } */
const sockets = new Map();

function createEmptyDatabase() {
    return { users: {} };
}

function profileFromRecord(deviceId, record) {
    return {
        deviceId,
        name: record.name || 'Stranger',
        avatar: record.avatar || '',
        location: record.location || 'Unknown',
        createdAt: record.createdAt || Date.now(),
        likes: typeof record.likes === 'number' ? record.likes : 0,
        coins: typeof record.coins === 'number' ? record.coins : DAILY_COINS,
        lastCoinDailyClaim: record.lastCoinDailyClaim || Date.now()
    };
}

function recordFromProfile(profile) {
    return {
        deviceId: profile.deviceId,
        name: profile.name,
        avatar: profile.avatar,
        createdAt: profile.createdAt,
        likes: profile.likes || 0,
        coins: profile.coins ?? DAILY_COINS,
        lastCoinDailyClaim: profile.lastCoinDailyClaim || Date.now()
    };
}

function loadProfilesIntoMemory(usersObject) {
    profiles.clear();
    for (const [deviceId, record] of Object.entries(usersObject || {})) {
        if (!record || typeof record !== 'object') continue;
        profiles.set(deviceId, profileFromRecord(deviceId, record));
    }
}

function migrateLegacyUsersFile() {
    if (!fs.existsSync(LEGACY_USERS_FILE)) return false;
    try {
        const legacy = JSON.parse(fs.readFileSync(LEGACY_USERS_FILE, 'utf8'));
        const users = {};
        for (const [deviceId, record] of Object.entries(legacy)) {
            if (!record || typeof record !== 'object') continue;
            users[deviceId] = {
                deviceId,
                name: record.name || 'Stranger',
                avatar: record.avatar || '',
                createdAt: record.createdAt || Date.now(),
                likes: typeof record.likes === 'number' ? record.likes : 0,
                coins: typeof record.coins === 'number' ? record.coins : DAILY_COINS,
                lastCoinDailyClaim: record.lastCoinDailyClaim || Date.now()
            };
        }
        const database = { users };
        fs.writeFileSync(DATABASE_FILE, JSON.stringify(database, null, 2), 'utf8');
        loadProfilesIntoMemory(users);
        console.log(`Migrated ${profiles.size} user(s) from users.json to database.json`);
        return true;
    } catch (err) {
        console.error('Failed to migrate users.json:', err.message);
        return false;
    }
}

function loadDatabase() {
    try {
        if (!fs.existsSync(DATABASE_FILE)) {
            const empty = createEmptyDatabase();
            fs.writeFileSync(DATABASE_FILE, JSON.stringify(empty, null, 2), 'utf8');
            console.log('Created empty database.json');
            if (migrateLegacyUsersFile()) return;
            loadProfilesIntoMemory(empty.users);
            return;
        }

        const raw = fs.readFileSync(DATABASE_FILE, 'utf8').trim();
        if (!raw) {
            const empty = createEmptyDatabase();
            fs.writeFileSync(DATABASE_FILE, JSON.stringify(empty, null, 2), 'utf8');
            loadProfilesIntoMemory(empty.users);
            return;
        }

        const database = JSON.parse(raw);
        const users = database && database.users ? database.users : database;
        if (!database.users && database && typeof database === 'object') {
            const normalized = { users };
            fs.writeFileSync(DATABASE_FILE, JSON.stringify(normalized, null, 2), 'utf8');
        }
        loadProfilesIntoMemory(users);
        console.log(`Loaded ${profiles.size} user(s) from database.json`);
    } catch (err) {
        console.error('Failed to load database.json:', err.message);
        const empty = createEmptyDatabase();
        fs.writeFileSync(DATABASE_FILE, JSON.stringify(empty, null, 2), 'utf8');
        loadProfilesIntoMemory(empty.users);
    }
}

function saveDatabase() {
    const users = {};
    for (const [deviceId, profile] of profiles) {
        users[deviceId] = recordFromProfile(profile);
    }
    fs.writeFileSync(DATABASE_FILE, JSON.stringify({ users }, null, 2), 'utf8');
}

function ensureDailyCoins(profile) {
    const now = Date.now();
    if (!profile.lastCoinDailyClaim || now - profile.lastCoinDailyClaim >= COIN_RESET_MS) {
        profile.coins = DAILY_COINS;
        profile.lastCoinDailyClaim = now;
    }
}

function resolveDeviceId(payload) {
    return payload.deviceId || payload.persistentId;
}

function getOrCreateProfile(deviceId, seed = {}) {
    let profile = profiles.get(deviceId);
    let changed = false;

    if (!profile) {
        profile = {
            deviceId,
            name: seed.name || 'Stranger',
            avatar: seed.avatar || '',
            location: seed.location || 'Unknown',
            likes: typeof seed.likes === 'number' ? seed.likes : 0,
            coins: DAILY_COINS,
            lastCoinDailyClaim: Date.now()
        };
        profiles.set(deviceId, profile);
        changed = true;
    }

    if (seed.name && seed.name !== profile.name) {
        profile.name = seed.name;
        changed = true;
    }
    if (seed.avatar && seed.avatar !== profile.avatar) {
        profile.avatar = seed.avatar;
        changed = true;
    }
    if (seed.location && seed.location !== profile.location) {
        profile.location = seed.location;
        changed = true;
    }

    const coinsBefore = profile.coins;
    ensureDailyCoins(profile);
    if (profile.coins !== coinsBefore) changed = true;

    if (changed) scheduleSaveProfiles();
    return profile;
}

function socketProfileView(socketId) {
    const entry = sockets.get(socketId);
    if (!entry) return null;
    const profile = profiles.get(entry.deviceId);
    if (!profile) return null;
    return {
        socketId,
        deviceId: entry.deviceId,
        persistentId: entry.deviceId,
        name: profile.name,
        avatar: profile.avatar,
        location: profile.location,
        likes: profile.likes,
        coins: profile.coins,
        lastCoinDailyClaim: profile.lastCoinDailyClaim
    };
}

function buildOnlineList(forSocketId) {
    const myEntry = sockets.get(forSocketId);
    const myDeviceId = myEntry ? myEntry.deviceId : null;
    const list = [];

    for (const [socketId, entry] of sockets) {
        const sock = entry.socket;
        if (!sock || !sock.connected) continue;
        const profile = profiles.get(entry.deviceId);
        if (!profile) continue;
        list.push({
            socketId,
            deviceId: entry.deviceId,
            persistentId: entry.deviceId,
            name: profile.name,
            avatar: profile.avatar,
            location: profile.location,
            likes: profile.likes,
            isYou: entry.deviceId === myDeviceId
        });
    }

    list.sort((a, b) => {
        if (a.isYou) return -1;
        if (b.isYou) return 1;
        return a.name.localeCompare(b.name);
    });

    return list;
}

function broadcastOnlineList() {
    for (const [socketId, entry] of sockets) {
        if (entry.socket && entry.socket.connected) {
            entry.socket.emit('online-users-update', buildOnlineList(socketId));
        }
    }
}

function buildTopFour() {
    const ranked = [];
    for (const profile of profiles.values()) {
        ranked.push({
            deviceId: profile.deviceId,
            persistentId: profile.deviceId,
            name: profile.name,
            avatar: profile.avatar,
            likes: profile.likes || 0
        });
    }
    ranked.sort((a, b) => {
        if (b.likes !== a.likes) return b.likes - a.likes;
        return a.name.localeCompare(b.name);
    });
    return ranked.slice(0, 4).map((user, index) => ({
        ...user,
        rank: index + 1
    }));
}

function sendLeaderboardToSocket(socket) {
    if (socket && socket.connected) {
        socket.emit('leaderboard-update', buildTopFour());
    }
}

function broadcastLeaderboard() {
    const top = buildTopFour();
    io.emit('leaderboard-update', top);
}

function removeFromQueue(socketId) {
    const idx = waitingQueue.indexOf(socketId);
    if (idx !== -1) waitingQueue.splice(idx, 1);
}

function leaveRoom(socket) {
    if (!socket.room) return;

    const room = socket.room;
    socket.to(room).emit('peer-left');
    socket.leave(room);
    socket.room = null;
    socket.partnerId = null;
}

function pairUsers(userA, userB) {
    const roomName = `room-${userA.id}-${userB.id}`;

    userA.join(roomName);
    userB.join(roomName);

    userA.room = roomName;
    userB.room = roomName;
    userA.partnerId = userB.id;
    userB.partnerId = userA.id;

    const dataA = socketProfileView(userB.id);
    const dataB = socketProfileView(userA.id);

    userA.emit('match-found', {
        peerId: userB.id,
        peerPersistentId: dataA ? dataA.persistentId : null,
        peerData: dataA
            ? { name: dataA.name, avatar: dataA.avatar, likes: dataA.likes }
            : { name: 'Stranger', avatar: '', likes: 0 },
        isInitiator: true
    });

    userB.emit('match-found', {
        peerId: userA.id,
        peerPersistentId: dataB ? dataB.persistentId : null,
        peerData: dataB
            ? { name: dataB.name, avatar: dataB.avatar, likes: dataB.likes }
            : { name: 'Stranger', avatar: '', likes: 0 },
        isInitiator: false
    });

    console.log(`Matched ${userA.id} with ${userB.id} (FIFO)`);
}

function tryMatch(socket) {
    removeFromQueue(socket.id);
    leaveRoom(socket);

    while (waitingQueue.length > 0) {
        const partnerId = waitingQueue.shift();
        const partner = io.sockets.sockets.get(partnerId);

        if (!partner || !partner.connected || partner.id === socket.id) {
            continue;
        }

        pairUsers(socket, partner);
        return;
    }

    waitingQueue.push(socket.id);
    socket.emit('waiting');
    console.log(`User ${socket.id} waiting (queue: ${waitingQueue.length})`);
}

function emitSelfState(socket) {
    const view = socketProfileView(socket.id);
    if (!view) return;
    socket.emit('user-state', {
        likes: view.likes,
        coins: view.coins,
        lastCoinDailyClaim: view.lastCoinDailyClaim,
        deviceId: view.deviceId,
        persistentId: view.deviceId
    });
}

function pushVisitor(targetDeviceId, visitorProfile, sourceLabel) {
    if (!profiles.get(targetDeviceId)) return;

    const visit = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        visitorDeviceId: visitorProfile.deviceId,
        name: visitorProfile.name,
        avatar: visitorProfile.avatar,
        source: sourceLabel,
        time: 'Just now',
        at: Date.now()
    };

    for (const [, entry] of sockets) {
        if (entry.deviceId === targetDeviceId && entry.socket && entry.socket.connected) {
            entry.socket.emit('profile-visitor', visit);
        }
    }
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    sendLeaderboardToSocket(socket);

    socket.on('register-online', (payload) => {
        const deviceId = resolveDeviceId(payload);
        if (!payload || !deviceId) return;

        getOrCreateProfile(deviceId, {
            name: payload.name,
            avatar: payload.avatar,
            location: payload.location,
            likes: typeof payload.likes === 'number' ? payload.likes : undefined
        });

        sockets.set(socket.id, { socket, deviceId });
        socket.deviceId = deviceId;

        emitSelfState(socket);
        broadcastOnlineList();
        broadcastLeaderboard();
    });

    socket.on('request-leaderboard', () => {
        sendLeaderboardToSocket(socket);
    });

    socket.on('update-profile', (payload) => {
        const deviceId = resolveDeviceId(payload);
        if (!payload || !deviceId) return;

        getOrCreateProfile(deviceId, {
            name: payload.name,
            avatar: payload.avatar,
            location: payload.location
        });

        if (!sockets.has(socket.id)) {
            sockets.set(socket.id, { socket, deviceId });
            socket.deviceId = deviceId;
        }

        emitSelfState(socket);
        broadcastOnlineList();
        broadcastLeaderboard();
    });

    socket.on('send-likes', ({ targetSocketId, amount }) => {
        const senderEntry = sockets.get(socket.id);
        const targetEntry = sockets.get(targetSocketId);
        if (!senderEntry || !targetEntry) return;

        const senderProfile = profiles.get(senderEntry.deviceId);
        const targetProfile = profiles.get(targetEntry.deviceId);
        if (!senderProfile || !targetProfile) return;

        const n = parseInt(amount, 10);
        if (!n || n < 1 || n > 5) return;

        ensureDailyCoins(senderProfile);
        if (senderProfile.coins < n) {
            socket.emit('likes-error', { message: 'Not enough coins' });
            emitSelfState(socket);
            return;
        }

        senderProfile.coins -= n;
        targetProfile.likes += n;
        scheduleSaveProfiles();

        emitSelfState(socket);
        targetEntry.socket.emit('user-state', {
            likes: targetProfile.likes,
            coins: targetProfile.coins,
            lastCoinDailyClaim: targetProfile.lastCoinDailyClaim,
            deviceId: targetProfile.deviceId,
            persistentId: targetProfile.deviceId
        });

        socket.emit('likes-sent', {
            amount: n,
            peerLikes: targetProfile.likes,
            remainingCoins: senderProfile.coins
        });

        targetEntry.socket.emit('peer-likes-updated', {
            amount: n,
            totalLikes: targetProfile.likes,
            fromName: senderProfile.name
        });

        broadcastLeaderboard();
    });

    socket.on('profile-view', ({ targetPersistentId, targetDeviceId, source }) => {
        const viewerEntry = sockets.get(socket.id);
        const targetId = targetDeviceId || targetPersistentId;
        if (!viewerEntry || !targetId) return;
        if (viewerEntry.deviceId === targetId) return;

        const allowed = source === 'home' || source === 'video_chat';
        if (!allowed) return;

        const viewerProfile = profiles.get(viewerEntry.deviceId);
        if (!viewerProfile) return;

        const label =
            source === 'home' ? 'Viewed from Home' : 'Viewed from Video Chat';

        pushVisitor(targetId, viewerProfile, label);
    });

    socket.on('search-stranger', () => {
        console.log(`search-stranger from ${socket.id}`);
        tryMatch(socket);
    });

    socket.on('next-stranger', () => {
        leaveRoom(socket);
        tryMatch(socket);
    });

    socket.on('signal', (data) => {
        if (!data || !data.to) return;
        io.to(data.to).emit('signal', {
            from: socket.id,
            signal: data.signal
        });
    });

    socket.on('leave-room', () => {
        leaveRoom(socket);
        removeFromQueue(socket.id);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        leaveRoom(socket);
        removeFromQueue(socket.id);
        sockets.delete(socket.id);
        broadcastOnlineList();
    });
});

loadProfilesFromDisk();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
