(function () {
    'use strict';

    const DAILY_COINS = 5;
    const COIN_RESET_MS = 24 * 60 * 60 * 1000;
    const VISITORS_SESSION_KEY = 'profileVisitors';
    const defaultAvatarUrl = 'https://api.dicebear.com/7.x/adventurer/svg?seed=Faris';

    let finalUserPictureBase64 = defaultAvatarUrl;
    let userLocation = localStorage.getItem('userLocation') || 'Unknown';

    let deviceId = localStorage.getItem('deviceId');
    if (!deviceId) {
        deviceId = typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : 'd-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('deviceId', deviceId);
    }
    const persistentId = deviceId;

    (function migrateLegacyStorageKeys() {
        if (!localStorage.getItem(`userLikes_${deviceId}`) && localStorage.getItem('userLikes')) {
            localStorage.setItem(`userLikes_${deviceId}`, localStorage.getItem('userLikes'));
        }
        if (!localStorage.getItem(`userCoins_${deviceId}`) && localStorage.getItem('userCoins')) {
            localStorage.setItem(`userCoins_${deviceId}`, localStorage.getItem('userCoins'));
        }
        const legacyClaim = localStorage.getItem('lastCoinResetTimestamp');
        if (!localStorage.getItem(`lastCoinDailyClaim_${deviceId}`) && legacyClaim) {
            localStorage.setItem(`lastCoinDailyClaim_${deviceId}`, legacyClaim);
        }
    })();

    let localStream = null;
    let remoteStream = null;
    let pendingIceCandidates = [];
    let likeFeedbackTimer = null;
    let isCamOn = true;
    let isMicOn = true;

    let socket = null;
    let peerConnection = null;
    let peerId = null;
    let peerPersistentId = null;
    let currentStrangerData = null;
    let isInitiator = false;
    let matchSessionActive = false;
    let onlineUsers = [];
    let leaderboard = [];
    let profileVisitors = [];
    let cropperInstance = null;

    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getStoredLikes() {
        return parseInt(localStorage.getItem(`userLikes_${deviceId}`) || '0', 10) || 0;
    }

    function syncLikesToStorage(likes) {
        localStorage.setItem(`userLikes_${deviceId}`, String(likes));
        const el = document.getElementById('heartCount');
        if (el) el.textContent = String(likes);
    }

    function syncCoinsToUI(coins) {
        localStorage.setItem(`userCoins_${deviceId}`, String(coins));
        const el = document.getElementById('coinCount');
        if (el) el.textContent = String(coins);
    }

    function checkAndResetDailyCoins() {
        const claimKey = `lastCoinDailyClaim_${deviceId}`;
        const coinsKey = `userCoins_${deviceId}`;
        const lastClaim = parseInt(localStorage.getItem(claimKey) || '0', 10);
        const now = Date.now();

        if (!lastClaim || now - lastClaim >= COIN_RESET_MS) {
            localStorage.setItem(coinsKey, String(DAILY_COINS));
            localStorage.setItem(claimKey, String(now));
        }

        syncCoinsToUI(parseInt(localStorage.getItem(coinsKey) || String(DAILY_COINS), 10));
    }

    function loadVisitorsFromSession() {
        try {
            const raw = sessionStorage.getItem(VISITORS_SESSION_KEY);
            profileVisitors = raw ? JSON.parse(raw) : [];
        } catch (_) {
            profileVisitors = [];
        }
    }

    function saveVisitorsToSession() {
        sessionStorage.setItem(VISITORS_SESSION_KEY, JSON.stringify(profileVisitors));
    }

    function addProfileVisitor(visit) {
        if (!visit) return;
        profileVisitors.unshift(visit);
        if (profileVisitors.length > 50) profileVisitors.length = 50;
        saveVisitorsToSession();
        renderProfileVisitors();
    }

    function getUserProfilePayload() {
        let avatar = finalUserPictureBase64 || defaultAvatarUrl;
        if (avatar.startsWith('data:') && avatar.length > 500000) {
            avatar = defaultAvatarUrl;
        }
        return {
            deviceId,
            persistentId: deviceId,
            name: localStorage.getItem('storedName') || 'Stranger',
            avatar,
            location: userLocation,
            likes: getStoredLikes()
        };
    }

    async function resolveUserLocation() {
        if (localStorage.getItem('userLocation')) {
            userLocation = localStorage.getItem('userLocation');
            return;
        }
        try {
            const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(4000) });
            if (res.ok) {
                const data = await res.json();
                if (data.city && data.country_name) {
                    userLocation = `${data.city}, ${data.country_name}`;
                    localStorage.setItem('userLocation', userLocation);
                }
            }
        } catch (_) {
            userLocation = 'Online';
        }
    }

    function renderOnlineUsers() {
        const container = document.getElementById('onlineUsersList');
        const countEl = document.getElementById('online-count');
        if (!container) return;

        container.innerHTML = '';
        const list = onlineUsers.length ? onlineUsers : [];

        if (list.length === 0) {
            container.innerHTML =
                '<p style="color:#666;font-size:14px;padding:20px;text-align:center;">No one online yet. Save your profile to appear here.</p>';
            if (countEl) countEl.textContent = '0 Online';
            return;
        }

        list.forEach((user) => {
            const youBadge = user.isYou
                ? ' <span style="font-size: 10px; color: #00b894; background: rgba(0,184,148,0.1); padding: 2px 6px; border-radius: 4px; margin-left: 5px;">You</span>'
                : '';
            const border = user.isYou ? 'border-left: 3px solid #00b894; background: rgba(0, 184, 148, 0.03);' : '';
            const loc = escapeHtml(user.location || 'Online');
            const name = escapeHtml(user.name);
            const avatar = escapeHtml(user.avatar || defaultAvatarUrl);

            const card = document.createElement('div');
            card.className = 'online-user-card';
            card.style.cssText = border;
            card.innerHTML = `
                <div class="user-info-block">
                    <img src="${avatar}" class="user-avatar-styled" alt="">
                    <div>
                        <h4 style="font-size: 15px; color: #fff; font-weight: bold;">${name}${youBadge}</h4>
                        <p style="font-size: 12px; color: #666; margin-top: 2px;">${loc}</p>
                    </div>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="pulse-dot"></span>
                    <span style="font-size: 12px; color: #00b894; font-weight: bold;">Active</span>
                </div>`;

            if (!user.isYou) {
                card.addEventListener('click', () => openProfileView(user, 'home'));
            } else {
                card.addEventListener('click', () => {
                    document.getElementById('modalTargetImg').src = finalUserPictureBase64;
                    document.getElementById('imageViewerModal').classList.remove('hidden');
                });
            }

            container.appendChild(card);
        });

        if (countEl) countEl.textContent = `${list.length} Online`;
    }

    function openProfileView(user, source) {
        document.getElementById('modalTargetImg').src = user.avatar || defaultAvatarUrl;
        document.getElementById('imageViewerModal').classList.remove('hidden');

        if (source === 'home' && socket && socket.connected && user.persistentId) {
            socket.emit('profile-view', {
                targetDeviceId: user.persistentId,
                targetPersistentId: user.persistentId,
                source: 'home'
            });
        }
    }

    function openImageViewerOnly(avatarUrl) {
        document.getElementById('modalTargetImg').src = avatarUrl || defaultAvatarUrl;
        document.getElementById('imageViewerModal').classList.remove('hidden');
    }

    function closeImageViewer(event) {
        if (event) event.stopPropagation();
        document.getElementById('imageViewerModal').classList.add('hidden');
    }

    function rankStyle(rank) {
        const styles = [
            { icon: 'fa-crown', color: '#ffd32a', border: 'border: 1px solid #ffd32a; box-shadow: 0 0 10px rgba(255, 211, 42, 0.15);' },
            { icon: 'fa-crown', color: '#d2dae2', border: '' },
            { icon: 'fa-crown', color: '#eccc68', border: '' },
            { icon: 'fa-medal', color: '#ff7f50', border: '' }
        ];
        return styles[rank - 1] || { icon: 'fa-medal', color: '#888', border: '' };
    }

    function requestLeaderboard() {
        if (socket && socket.connected) {
            socket.emit('request-leaderboard');
        }
    }

    function renderTopFourRanks() {
        const container = document.getElementById('ranksListContainer');
        if (!container) return;
        container.innerHTML = '';

        if (!leaderboard.length) {
            container.innerHTML = '<p style="color:#666;font-size:12px;text-align:center;padding:10px;">No top stars yet — create a profile and collect likes!</p>';
            return;
        }

        leaderboard.forEach((user) => {
            const st = rankStyle(user.rank);
            const avatarUrl = user.avatar || defaultAvatarUrl;
            const div = document.createElement('div');
            div.className = 'rank-pop-card';
            div.style.cssText = st.border;
            div.innerHTML = `
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="font-size: 16px; font-weight: bold; color: ${st.color}; width: 20px; text-align: center;">
                        <i class="fa-solid ${st.icon}"></i>
                    </div>
                    <img src="${escapeHtml(avatarUrl)}" style="width: 38px; height: 38px; border-radius: 50%; object-fit: cover; background: #141414; border: 1px solid ${st.color};" alt="">
                    <div>
                        <p style="color: #fff; font-size: 13px; font-weight: bold; margin: 0;">${escapeHtml(user.name)}</p>
                        <p style="color: #666; font-size: 11px; margin-top: 1px;">Rank #${user.rank}</p>
                    </div>
                </div>
                <div style="display: flex; align-items: center; gap: 5px; color: #ff4757; font-size: 12px; font-weight: bold; background: rgba(255, 71, 87, 0.08); padding: 4px 8px; border-radius: 6px;">
                    <i class="fa-solid fa-heart"></i>
                    <span>${user.likes}</span>
                </div>`;

            const rankImg = div.querySelector('img');
            if (rankImg) {
                rankImg.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openImageViewerOnly(avatarUrl);
                });
            }

            container.appendChild(div);
        });
    }

    function renderProfileVisitors() {
        const container = document.getElementById('visitorsListContainer');
        if (!container) return;
        container.innerHTML = '';

        if (!profileVisitors.length) {
            container.innerHTML = '<p style="color:#666;font-size:12px;text-align:center;padding:10px;">No profile visitors yet.</p>';
            return;
        }

        profileVisitors.forEach((visitor) => {
            const avatarUrl = visitor.avatar || defaultAvatarUrl;
            const div = document.createElement('div');
            div.style.cssText =
                'display: flex; align-items: center; justify-content: space-between; background: #222; padding: 10px; border-radius: 8px; border-left: 3px solid #a29bfe;';
            div.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <img src="${escapeHtml(avatarUrl)}" style="width: 38px; height: 38px; border-radius: 50%; object-fit: cover; background: #141414; border: 1px solid #444;" alt="">
                    <div>
                        <p style="color: #fff; font-size: 13px; font-weight: bold; margin: 0;">${escapeHtml(visitor.name)}</p>
                        <p style="font-size: 11px; color: #888; margin-top: 2px;"><i class="fa-solid fa-location-arrow" style="font-size:10px;"></i> ${escapeHtml(visitor.source)}</p>
                    </div>
                </div>
                <span style="color: #666; font-size: 11px;">${escapeHtml(visitor.time || 'Just now')}</span>`;

            const visitorImg = div.querySelector('img');
            if (visitorImg) {
                visitorImg.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openImageViewerOnly(avatarUrl);
                });
            }

            container.appendChild(div);
        });
    }

    function showLikeFeedback(message, isError) {
        const toast = document.getElementById('likeFeedbackToast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.remove('hidden');
        toast.classList.toggle('error', !!isError);
        clearTimeout(likeFeedbackTimer);
        likeFeedbackTimer = setTimeout(() => {
            toast.classList.add('hidden');
            toast.classList.remove('error');
        }, 2200);
    }

    function emitSelfStateFromServer() {
        if (socket && socket.connected) {
            socket.emit('register-online', getUserProfilePayload());
        }
    }

    function bindRemoteVideoStream(event) {
        const remoteVideoElem = document.getElementById('remoteVideo');
        if (!remoteVideoElem) return;

        if (!remoteStream) {
            if (event.streams && event.streams[0]) {
                remoteStream = event.streams[0];
            } else {
                remoteStream = new MediaStream();
            }
            remoteVideoElem.srcObject = remoteStream;
        }

        if (event.track) {
            const exists = remoteStream.getTracks().some((t) => t.id === event.track.id);
            if (!exists) remoteStream.addTrack(event.track);
        }

        remoteVideoElem.setAttribute('autoplay', '');
        remoteVideoElem.setAttribute('playsinline', '');
        remoteVideoElem.muted = false;

        const playPromise = remoteVideoElem.play();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch((err) => console.warn('Remote video play:', err));
        }

        hideSearchingState();
    }

    async function flushPendingIceCandidates() {
        if (!peerConnection || !peerConnection.remoteDescription) return;

        while (pendingIceCandidates.length) {
            const candidate = pendingIceCandidates.shift();
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.warn('ICE candidate flush error:', err);
            }
        }
    }

    async function addRemoteIceCandidate(candidate) {
        if (!peerConnection || !candidate) return;

        if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.warn('ICE candidate error:', err);
            }
        } else {
            pendingIceCandidates.push(candidate);
        }
    }

    function showViewsBadge() {
        const badge = document.getElementById('nav-views-badge');
        if (badge) badge.classList.remove('hidden');
    }

    function clearViewsBadge() {
        const badge = document.getElementById('nav-views-badge');
        if (badge) badge.classList.add('hidden');
    }

    function openCropModal(dataUrl) {
        const modal = document.getElementById('cropModal');
        const img = document.getElementById('cropTargetImage');
        if (!modal || !img) return;

        if (cropperInstance) {
            cropperInstance.destroy();
            cropperInstance = null;
        }

        img.src = dataUrl;
        modal.classList.remove('hidden');

        cropperInstance = new Cropper(img, {
            aspectRatio: 1,
            viewMode: 1,
            dragMode: 'move',
            autoCropArea: 1,
            responsive: true,
            background: false
        });
    }

    function closeCropModal() {
        const modal = document.getElementById('cropModal');
        if (cropperInstance) {
            cropperInstance.destroy();
            cropperInstance = null;
        }
        if (modal) modal.classList.add('hidden');
    }

    function applyCrop() {
        if (!cropperInstance) return;
        const canvas = cropperInstance.getCroppedCanvas({
            maxWidth: 1200,
            maxHeight: 1200,
            imageSmoothingEnabled: true,
            imageSmoothingQuality: 'high'
        });
        if (!canvas) return;

        finalUserPictureBase64 = canvas.toDataURL('image/jpeg', 0.92);
        document.getElementById('myAvatar').src = finalUserPictureBase64;
        closeCropModal();
    }

    function previewAndProcessImage(input) {
        if (!input.files || !input.files[0]) return;
        const reader = new FileReader();
        reader.onload = function (e) {
            openCropModal(e.target.result);
        };
        reader.readAsDataURL(input.files[0]);
        input.value = '';
    }

    async function saveProfileData() {
        const nameVal = document.getElementById('usernameInput').value.trim();
        if (!nameVal) {
            alert('Please type a display name first!');
            return;
        }
        localStorage.setItem('storedName', nameVal);
        localStorage.setItem('userRealPicture', finalUserPictureBase64);

        await resolveUserLocation();
        await connectSocketIfNeeded();
        socket.emit('update-profile', getUserProfilePayload());
        socket.emit('register-online', getUserProfilePayload());

        renderOnlineUsers();
        switchPage('home');
    }

    function attachSocketListeners() {
        if (!socket || socket.__listenersAttached) return;
        socket.__listenersAttached = true;

        socket.on('connect', () => {
            console.log('Socket connected:', socket.id);
            socket.emit('register-online', getUserProfilePayload());
            requestLeaderboard();
        });

        socket.on('online-users-update', (list) => {
            onlineUsers = list || [];
            renderOnlineUsers();
        });

        socket.on('leaderboard-update', (top) => {
            leaderboard = top || [];
            renderTopFourRanks();
        });

        socket.on('user-state', (state) => {
            if (state && typeof state.likes === 'number') syncLikesToStorage(state.likes);
            if (state && typeof state.coins === 'number') {
                syncCoinsToUI(state.coins);
                if (typeof state.lastCoinDailyClaim === 'number') {
                    localStorage.setItem(`lastCoinDailyClaim_${deviceId}`, String(state.lastCoinDailyClaim));
                }
            }
        });

        socket.on('likes-sent', (data) => {
            if (typeof data.remainingCoins === 'number') {
                syncCoinsToUI(data.remainingCoins);
            }
            if (currentStrangerData && typeof data.peerLikes === 'number') {
                currentStrangerData.likes = data.peerLikes;
            }
            showLikeFeedback(`Sent ${data.amount} likes!`);
            showAndRenderRatingBox();
        });

        socket.on('likes-error', (data) => {
            emitSelfStateFromServer();
            showLikeFeedback(data?.message || 'Not enough coins!', true);
            showAndRenderRatingBox();
        });

        socket.on('peer-likes-updated', (data) => {
            if (typeof data.totalLikes === 'number') {
                syncLikesToStorage(data.totalLikes);
            }
        });

        socket.on('profile-visitor', (visit) => {
            showViewsBadge();
            addProfileVisitor(visit);
        });

        socket.on('waiting', () => {
            showSearchingState();
            setMatchStatusMessage('Searching for a stranger match around the globe...');
        });

        socket.on('match-found', (data) => {
            handleMatchFound(data);
        });

        socket.on('signal', (data) => {
            handleIncomingSignal(data);
        });

        socket.on('peer-left', () => {
            handlePeerLeft();
        });

        socket.on('connect_error', (err) => {
            console.error('Socket error:', err);
            setMatchStatusMessage('Cannot connect to server. Run node server.js');
        });
    }

    function initSocket() {
        if (socket) return socket;
        if (window.location.protocol === 'file:') {
            alert('Open the site through the server (http://localhost:3000)');
            return null;
        }

        socket = io({
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 15
        });

        attachSocketListeners();
        return socket;
    }

    function connectSocketIfNeeded() {
        initSocket();
        if (!socket) return Promise.reject(new Error('No socket'));
        if (socket.connected) return Promise.resolve();

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('timeout')), 12000);
            socket.once('connect', () => {
                clearTimeout(timeout);
                resolve();
            });
            socket.once('connect_error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    function setMatchStatusMessage(message) {
        const loader = document.getElementById('searchingStateLoader');
        if (!loader) return;
        const textEl = loader.querySelector('p');
        if (textEl) textEl.textContent = message;
    }

    async function startStrangerSearch() {
        showSearchingState();
        setMatchStatusMessage('Connecting to match server...');
        try {
            await connectSocketIfNeeded();
            matchSessionActive = false;
            socket.emit('search-stranger');
            setMatchStatusMessage('Searching for a stranger match around the globe...');
        } catch (err) {
            setMatchStatusMessage('Connection failed. Start: node server.js');
        }
    }

    function showSearchingState() {
        const loader = document.getElementById('searchingStateLoader');
        if (loader) loader.style.display = 'block';
        hideStrangerUI();
    }

    function hideSearchingState() {
        const loader = document.getElementById('searchingStateLoader');
        if (loader) loader.style.display = 'none';
    }

    function hideStrangerUI() {
        document.getElementById('strangerRatingBox')?.classList.add('hidden');
        document.getElementById('strangerSmallAvatarBox')?.classList.add('hidden');
    }

    function updateStrangerUI(peerData) {
        if (!peerData) return;
        const avatarImg = document.getElementById('strangerSmallAvatarImg');
        if (avatarImg && peerData.avatar) avatarImg.src = peerData.avatar;
        document.getElementById('strangerSmallAvatarBox')?.classList.remove('hidden');
        showAndRenderRatingBox();
    }

    async function handleReadyResponse(ready) {
        if (!ready) {
            switchPage('home');
            return;
        }
        document.getElementById('readinessOverlay').classList.add('hidden');

        const cameraReady = await initiateLocalCameraStream();
        if (!cameraReady) {
            setMatchStatusMessage('Camera unavailable — still searching...');
        }

        await startStrangerSearch();
    }

    async function handleMatchFound(data) {
        peerId = data.peerId;
        peerPersistentId = data.peerPersistentId;
        currentStrangerData = data.peerData;
        isInitiator = data.isInitiator;
        matchSessionActive = true;

        hideSearchingState();
        updateStrangerUI(data.peerData);

        await createPeerConnection();

        if (localStream) {
            localStream.getTracks().forEach((track) => {
                peerConnection.addTrack(track, localStream);
            });
        }

        if (isInitiator) {
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            await peerConnection.setLocalDescription(offer);
            socket.emit('signal', { to: peerId, signal: { type: 'offer', sdp: offer } });
        }
    }

    async function handleIncomingSignal({ from, signal }) {
        if (!signal) return;
        try {
            if (!peerConnection) {
                peerId = from;
                await createPeerConnection();
                if (localStream) {
                    localStream.getTracks().forEach((track) => {
                        peerConnection.addTrack(track, localStream);
                    });
                }
            }

            if (signal.type === 'offer') {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                await flushPendingIceCandidates();
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.emit('signal', { to: from, signal: { type: 'answer', sdp: answer } });
            } else if (signal.type === 'answer') {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                await flushPendingIceCandidates();
            } else if (signal.candidate) {
                await addRemoteIceCandidate(signal.candidate);
            }
        } catch (err) {
            console.error('WebRTC signal error:', err);
        }
    }

    function closePeerConnectionOnly(clearRemoteVideo) {
        if (peerConnection) {
            peerConnection.ontrack = null;
            peerConnection.onicecandidate = null;
            peerConnection.onconnectionstatechange = null;
            peerConnection.oniceconnectionstatechange = null;
            peerConnection.close();
            peerConnection = null;
        }

        pendingIceCandidates = [];

        if (clearRemoteVideo) {
            const remoteVideoElem = document.getElementById('remoteVideo');
            if (remoteVideoElem) remoteVideoElem.srcObject = null;
            remoteStream = null;
        }
    }

    async function createPeerConnection() {
        closePeerConnectionOnly(false);
        remoteStream = null;

        peerConnection = new RTCPeerConnection(rtcConfig);

        peerConnection.ontrack = (event) => {
            bindRemoteVideoStream(event);
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate && peerId && socket) {
                socket.emit('signal', {
                    to: peerId,
                    signal: { candidate: event.candidate }
                });
            }
        };

        peerConnection.onconnectionstatechange = () => {
            if (!peerConnection) return;
            if (peerConnection.connectionState === 'failed') {
                handlePeerLeft();
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            if (!peerConnection) return;
            if (peerConnection.iceConnectionState === 'failed') {
                handlePeerLeft();
            }
        };
    }

    async function attachLocalStreamToPeer() {
        if (!peerConnection || !localStream) return;
        const senders = peerConnection.getSenders();
        for (const track of localStream.getTracks()) {
            const existing = senders.find((s) => s.track && s.track.kind === track.kind);
            if (existing) await existing.replaceTrack(track);
            else peerConnection.addTrack(track, localStream);
        }
        if (isInitiator && peerId && peerConnection.signalingState === 'stable') {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('signal', { to: peerId, signal: { type: 'offer', sdp: offer } });
        }
    }

    function cleanupPeerConnection(clearRemoteVideo) {
        closePeerConnectionOnly(clearRemoteVideo);
        peerId = null;
        peerPersistentId = null;
        isInitiator = false;
    }

    function handlePeerLeft() {
        const videoPage = document.getElementById('page-video-chat');
        if (!videoPage || videoPage.classList.contains('hidden')) return;
        if (!matchSessionActive) return;

        matchSessionActive = false;
        cleanupPeerConnection();
        currentStrangerData = null;
        showSearchingState();

        if (socket && socket.connected) startStrangerSearch();
    }

    function leaveVideoChatMedia() {
        matchSessionActive = false;
        if (socket) socket.emit('leave-room');
        cleanupPeerConnection();
        currentStrangerData = null;

        if (localStream) {
            localStream.getTracks().forEach((t) => t.stop());
            localStream = null;
        }
        const localVideoElem = document.getElementById('localVideo');
        const remoteVideoElem = document.getElementById('remoteVideo');
        if (localVideoElem) localVideoElem.srcObject = null;
        if (remoteVideoElem) remoteVideoElem.srcObject = null;
        hideStrangerUI();
    }

    function triggerStrangerPhotoView(event) {
        if (event) event.stopPropagation();
        if (!currentStrangerData) return;

        document.getElementById('modalTargetImg').src =
            currentStrangerData.avatar || defaultAvatarUrl;
        document.getElementById('imageViewerModal').classList.remove('hidden');

        if (peerPersistentId && socket && socket.connected) {
            socket.emit('profile-view', {
                targetDeviceId: peerPersistentId,
                targetPersistentId: peerPersistentId,
                source: 'video_chat'
            });
        }
    }

    function showAndRenderRatingBox() {
        const ratingBox = document.getElementById('strangerRatingBox');
        const buttonsContainer = document.getElementById('ratingButtonsContainer');
        const questionText = document.getElementById('ratingQuestionText');
        if (!ratingBox || !buttonsContainer || !questionText) return;

        ratingBox.classList.remove('hidden');
        buttonsContainer.innerHTML = '';

        const coins = parseInt(localStorage.getItem(`userCoins_${deviceId}`) || String(DAILY_COINS), 10);
        questionText.style.display = 'block';
        questionText.textContent = 'How many likes does this person deserve?';

        for (let i = 1; i <= 5; i++) {
            const btn = document.createElement('button');
            btn.className = 'btn-rate-num';
            btn.textContent = String(i);
            if (coins < i) {
                btn.style.opacity = '0.35';
                btn.style.cursor = 'not-allowed';
            } else {
                btn.addEventListener('click', () => sendLikesAmount(i));
            }
            buttonsContainer.appendChild(btn);
        }

        if (coins <= 0) {
            questionText.style.display = 'none';
            buttonsContainer.innerHTML = '<span class="no-likes-msg">No likes left today!</span>';
        }
    }

    function sendLikesAmount(amount) {
        if (!peerId || !socket || !socket.connected) return;

        const coins = parseInt(localStorage.getItem(`userCoins_${deviceId}`) || String(DAILY_COINS), 10);
        if (coins < amount) {
            showLikeFeedback('Not enough coins!', true);
            showAndRenderRatingBox();
            return;
        }

        syncCoinsToUI(coins - amount);
        socket.emit('send-likes', { targetSocketId: peerId, amount });
    }

    async function initiateLocalCameraStream() {
        try {
            if (localStream) localStream.getTracks().forEach((t) => t.stop());
            localStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: true
            });
            const localVideoElem = document.getElementById('localVideo');
        if (localVideoElem) {
            localVideoElem.srcObject = localStream;
            localVideoElem.setAttribute('autoplay', '');
            localVideoElem.setAttribute('playsinline', '');
            const localPlay = localVideoElem.play();
            if (localPlay && typeof localPlay.catch === 'function') {
                localPlay.catch(() => {});
            }
        }
            isCamOn = true;
            isMicOn = true;
            updateControlsUI();
            return true;
        } catch (err) {
            console.error(err);
            alert('Could not access camera or microphone.');
            return false;
        }
    }

    function toggleMic() {
        if (!localStream) return;
        isMicOn = !isMicOn;
        localStream.getAudioTracks().forEach((t) => (t.enabled = isMicOn));
        updateControlsUI();
    }

    function toggleCamera() {
        if (!localStream) return;
        isCamOn = !isCamOn;
        localStream.getVideoTracks().forEach((t) => (t.enabled = isCamOn));
        updateControlsUI();
    }

    function updateControlsUI() {
        const micBtn = document.getElementById('toggleMicBtn');
        const camBtn = document.getElementById('toggleCamBtn');
        if (micBtn) {
            micBtn.classList.toggle('disabled-state', !isMicOn);
            micBtn.innerHTML = isMicOn
                ? '<i class="fa-solid fa-microphone"></i>'
                : '<i class="fa-solid fa-microphone-slash"></i>';
        }
        if (camBtn) {
            camBtn.classList.toggle('disabled-state', !isCamOn);
            camBtn.innerHTML = isCamOn
                ? '<i class="fa-solid fa-video"></i>'
                : '<i class="fa-solid fa-video-slash"></i>';
        }
    }

    async function triggerNextStrangerMatch() {
        matchSessionActive = false;
        cleanupPeerConnection();
        currentStrangerData = null;
        try {
            await connectSocketIfNeeded();
            socket.emit('next-stranger');
            showSearchingState();
            setMatchStatusMessage('Searching for a stranger match around the globe...');
            await attachLocalStreamToPeer();
        } catch (err) {
            await startStrangerSearch();
        }
    }

    function exitVideoChatFlow() {
        leaveVideoChatMedia();
        switchPage('home');
    }

    function toggleRanksPopup(event) {
        event.stopPropagation();
        const popup = document.getElementById('ranksPopup');
        if (popup) {
            const opening = popup.style.display === 'none' || popup.style.display === '';
            popup.style.display = opening ? 'block' : 'none';
            if (opening) requestLeaderboard();
        }
        document.getElementById('viewsPopup').style.display = 'none';
    }

    function toggleViewsPopup(event) {
        event.stopPropagation();
        const popup = document.getElementById('viewsPopup');
        if (popup) {
            popup.style.display =
                popup.style.display === 'none' || popup.style.display === '' ? 'block' : 'none';
        }
        document.getElementById('ranksPopup').style.display = 'none';
    }

    function switchPage(pageName) {
        document.getElementById('page-home').classList.add('hidden');
        document.getElementById('page-me').classList.add('hidden');
        document.getElementById('page-video-chat').classList.add('hidden');

        const targetPage = document.getElementById('page-' + pageName);
        if (targetPage) targetPage.classList.remove('hidden');

        document.querySelectorAll('.nav-links .nav-item').forEach((item) => item.classList.remove('active'));
        const activeNav = document.getElementById('nav-' + pageName);
        if (activeNav) activeNav.classList.add('active');

        if (pageName === 'video-chat') {
            document.getElementById('readinessOverlay').classList.remove('hidden');
            showSearchingState();
            setMatchStatusMessage('Click Yes to start matching with another user...');
            initSocket();
        } else if (pageName !== 'home') {
            leaveVideoChatMedia();
        } else {
            leaveVideoChatMedia();
        }

        document.getElementById('viewsPopup').style.display = 'none';
        document.getElementById('ranksPopup').style.display = 'none';
    }

    document.addEventListener('DOMContentLoaded', async function () {
        checkAndResetDailyCoins();
        syncLikesToStorage(getStoredLikes());
        loadVisitorsFromSession();

        if (localStorage.getItem('storedName')) {
            document.getElementById('usernameInput').value = localStorage.getItem('storedName');
        }
        if (localStorage.getItem('userRealPicture')) {
            finalUserPictureBase64 = localStorage.getItem('userRealPicture');
            document.getElementById('myAvatar').src = finalUserPictureBase64;
        }

        await resolveUserLocation();
        initSocket();
        requestLeaderboard();
        if (localStorage.getItem('storedName')) {
            connectSocketIfNeeded().catch(() => {});
        }

        renderOnlineUsers();
        renderTopFourRanks();
        renderProfileVisitors();

        const badge = document.getElementById('nav-views-badge');
        if (badge) badge.classList.add('hidden');
    });

    document.addEventListener('click', function () {
        document.getElementById('viewsPopup').style.display = 'none';
        document.getElementById('ranksPopup').style.display = 'none';
    });

    window.switchPage = switchPage;
    window.toggleRanksPopup = toggleRanksPopup;
    window.toggleViewsPopup = toggleViewsPopup;
    window.clearViewsBadge = clearViewsBadge;
    window.saveProfileData = saveProfileData;
    window.previewAndProcessImage = previewAndProcessImage;
    window.closeCropModal = closeCropModal;
    window.applyCrop = applyCrop;
    window.closeImageViewer = closeImageViewer;
    window.openImageViewerOnly = openImageViewerOnly;
    window.handleReadyResponse = handleReadyResponse;
    window.toggleMic = toggleMic;
    window.toggleCamera = toggleCamera;
    window.triggerNextStrangerMatch = triggerNextStrangerMatch;
    window.exitVideoChatFlow = exitVideoChatFlow;
    window.triggerStrangerPhotoView = triggerStrangerPhotoView;
    // Check and Handle First-Time Visitor Rules Modal
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('rulesModal');
  const acceptBtn = document.getElementById('acceptRulesBtn');

  const hasAcceptedRules = localStorage.getItem('hasAcceptedRules');

  if (!hasAcceptedRules && modal) {
    modal.style.display = 'flex';
  }

  if (acceptBtn && modal) {
    acceptBtn.addEventListener('click', () => {
      localStorage.setItem('hasAcceptedRules', 'true');
      modal.style.display = 'none';
    });
  }
});
})();
