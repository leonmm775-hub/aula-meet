(() => {
  const $ = (id) => document.getElementById(id);

  // Servidores STUN públicos. Para redes muy restrictivas añade un TURN (ver README).
  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];

  const state = {
    socket: null,
    myId: null,
    name: '',
    room: '',
    localStream: new MediaStream(),
    camTrack: null,
    micTrack: null,
    screenTrack: null,
    micOn: true,
    camOn: true,
    peers: new Map(), // id -> { pc, name, tile, stream, pendingIce: [] }
    chatOpen: false,
  };

  // ---------- Utilidades ----------
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  function randomRoom() {
    const part = () => Math.random().toString(36).slice(2, 6);
    return `clase-${part()}-${part()}`;
  }

  function roomFromUrl() {
    const m = location.pathname.match(/^\/sala\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : new URLSearchParams(location.search).get('sala') || '';
  }

  // ---------- Medios locales ----------
  async function getMedia() {
    const tries = [
      { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
      { video: false, audio: true },
      { video: true, audio: false },
    ];
    for (const c of tries) {
      try { return await navigator.mediaDevices.getUserMedia(c); } catch { /* siguiente */ }
    }
    return new MediaStream();
  }

  async function initPreview() {
    if (!navigator.mediaDevices?.getUserMedia) {
      $('lobbyError').textContent = 'Tu navegador no permite cámara/micrófono (¿estás usando https?).';
      return;
    }
    const stream = await getMedia();
    state.camTrack = stream.getVideoTracks()[0] || null;
    state.micTrack = stream.getAudioTracks()[0] || null;
    state.camOn = !!state.camTrack;
    state.micOn = !!state.micTrack;
    state.localStream = stream;
    $('previewVideo').srcObject = stream;
    $('previewOff').classList.toggle('hidden', !!state.camTrack);
    if (!state.camTrack && !state.micTrack) {
      $('lobbyError').textContent = 'No se pudo acceder a cámara ni micrófono. Podrás entrar igualmente y usar el chat.';
    }
  }

  // ---------- Mosaico de vídeos ----------
  function createTile(id, name, isLocal) {
    const tile = document.createElement('div');
    tile.className = 'tile' + (isLocal ? ' local' : '');
    tile.dataset.id = id;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (isLocal) video.muted = true;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    const initial = document.createElement('b');
    initial.textContent = (name[0] || '?').toUpperCase();
    avatar.appendChild(initial);
    const label = document.createElement('div');
    label.className = 'label';
    label.innerHTML = '<span class="mic-off">🔇 </span>';
    label.append(document.createTextNode(isLocal ? `${name} (tú)` : name));
    tile.append(video, avatar, label);
    $('grid').appendChild(tile);
    layoutGrid();
    return tile;
  }

  function layoutGrid() {
    const n = $('grid').children.length;
    const wide = window.innerWidth > 720;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : wide ? (n <= 9 ? 3 : 4) : 2;
    $('grid').style.setProperty('--cols', wide || n > 1 ? cols : 1);
    $('peopleCount').textContent = `${n} ${n === 1 ? 'persona' : 'personas'}`;
  }
  window.addEventListener('resize', layoutGrid);

  function setTileState(tile, { mic, cam }) {
    if (!tile) return;
    tile.classList.toggle('muted', !mic);
    tile.classList.toggle('cam-off', !cam);
  }

  // ---------- WebRTC ----------
  function currentVideoTrack() {
    return state.screenTrack || state.camTrack;
  }

  function createPeer(id, name, initiator) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { pc, name, stream: new MediaStream(), pendingIce: [], tile: createTile(id, name, false) };
    peer.tile.querySelector('video').srcObject = peer.stream;
    state.peers.set(id, peer);

    if (initiator) {
      // Transceptores fijos (audio + vídeo) para poder cambiar pistas sin renegociar
      pc.addTransceiver('audio', { direction: 'sendrecv' }).sender.replaceTrack(state.micTrack);
      pc.addTransceiver('video', { direction: 'sendrecv' }).sender.replaceTrack(currentVideoTrack());
    }

    pc.ontrack = (e) => {
      peer.stream.addTrack(e.track);
      const v = peer.tile.querySelector('video');
      v.srcObject = peer.stream;
      v.play().catch(() => {});
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) state.socket.emit('signal', { to: id, data: { candidate: e.candidate } });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce?.();
    };

    return peer;
  }

  async function callPeer(id, name) {
    const { pc } = createPeer(id, name, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
  }

  async function handleSignal({ from, data }) {
    let peer = state.peers.get(from);

    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        if (!peer) {
          const info = state.info.get(from) || {};
          peer = createPeer(from, info.name || 'Participante', false);
          if ('mic' in info) setTileState(peer.tile, info);
        }
        const { pc } = peer;
        await pc.setRemoteDescription(data.sdp);
        for (const t of pc.getTransceivers()) {
          t.direction = 'sendrecv';
          const kind = t.receiver.track.kind;
          await t.sender.replaceTrack(kind === 'audio' ? state.micTrack : currentVideoTrack());
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        state.socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
      } else if (peer) {
        await peer.pc.setRemoteDescription(data.sdp);
      }
      if (peer) {
        for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
      }
    } else if (data.candidate && peer) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pendingIce.push(data.candidate);
    }
  }

  function removePeer(id) {
    const peer = state.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    peer.tile.remove();
    state.peers.delete(id);
    layoutGrid();
  }

  function replaceVideoForAll(track) {
    for (const { pc } of state.peers.values()) {
      const sender = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender;
      sender?.replaceTrack(track);
    }
  }

  // ---------- Controles ----------
  function updateButtons() {
    $('micBtn').classList.toggle('off', !state.micOn);
    $('micBtn').firstChild.textContent = state.micOn ? '🎤' : '🔇';
    $('camBtn').classList.toggle('off', !state.camOn);
    $('screenBtn').classList.toggle('active', !!state.screenTrack);
    const local = $('grid').querySelector('.tile.local');
    setTileState(local, { mic: state.micOn, cam: state.camOn || !!state.screenTrack });
    local?.classList.toggle('screen', !!state.screenTrack);
  }

  function broadcastMedia() {
    state.socket.emit('media-state', { mic: state.micOn, cam: state.camOn || !!state.screenTrack });
  }

  $('micBtn').onclick = () => {
    if (!state.micTrack) return toast('No hay micrófono disponible');
    state.micOn = !state.micOn;
    state.micTrack.enabled = state.micOn;
    updateButtons();
    broadcastMedia();
  };

  $('camBtn').onclick = () => {
    if (!state.camTrack) return toast('No hay cámara disponible');
    state.camOn = !state.camOn;
    state.camTrack.enabled = state.camOn;
    updateButtons();
    broadcastMedia();
  };

  $('screenBtn').onclick = async () => {
    if (state.screenTrack) return stopScreen();
    if (!navigator.mediaDevices.getDisplayMedia) return toast('Tu dispositivo no permite compartir pantalla');
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      state.screenTrack = s.getVideoTracks()[0];
      state.screenTrack.onended = stopScreen;
      replaceVideoForAll(state.screenTrack);
      setLocalVideo(state.screenTrack);
      updateButtons();
      broadcastMedia();
    } catch { /* cancelado */ }
  };

  function stopScreen() {
    if (!state.screenTrack) return;
    state.screenTrack.stop();
    state.screenTrack = null;
    replaceVideoForAll(state.camTrack);
    setLocalVideo(state.camTrack);
    updateButtons();
    broadcastMedia();
  }

  function setLocalVideo(videoTrack) {
    const v = $('grid').querySelector('.tile.local video');
    v.srcObject = new MediaStream(videoTrack ? [videoTrack] : []);
  }

  $('chatBtn').onclick = () => toggleChat();
  $('closeChatBtn').onclick = () => toggleChat(false);
  function toggleChat(open = !state.chatOpen) {
    state.chatOpen = open;
    $('chatPanel').classList.toggle('hidden', !open);
    $('chatBtn').classList.toggle('active', open);
    if (open) {
      $('unread').classList.add('hidden');
      $('chatInput').focus();
    }
  }

  $('leaveBtn').onclick = () => {
    state.socket?.disconnect();
    for (const t of state.localStream.getTracks()) t.stop();
    state.screenTrack?.stop();
    location.href = '/';
  };

  const roomLink = () => `${location.origin}/sala/${state.room}`;

  async function copyLink() {
    try { await navigator.clipboard.writeText(roomLink()); toast('Enlace copiado. ¡Pégalo donde quieras!'); }
    catch { prompt('Copia este enlace:', roomLink()); }
  }

  $('copyLinkBtn').onclick = copyLink;
  $('inviteCopyBtn').onclick = copyLink;
  $('inviteCloseBtn').onclick = () => $('invite').classList.add('hidden');

  function showInvite() {
    $('inviteLink').value = roomLink();
    $('invite').classList.remove('hidden');
  }

  // ---------- Chat ----------
  function addMessage({ name, text, time, mine, system }) {
    const li = document.createElement('li');
    if (system) {
      li.className = 'system';
      li.textContent = text;
    } else {
      const meta = document.createElement('div');
      meta.className = 'meta';
      const who = document.createElement('b');
      who.textContent = mine ? 'Tú' : name;
      meta.append(who, ' ', new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      const body = document.createElement('div');
      body.textContent = text;
      li.append(meta, body);
    }
    const list = $('messages');
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
    if (!state.chatOpen && !mine && !system) $('unread').classList.remove('hidden');
  }

  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;
    state.socket.emit('chat', text);
    $('chatInput').value = '';
  };

  // ---------- Entrar a la sala ----------
  $('roomInput').oninput = () => {
    $('joinBtn').textContent = $('roomInput').value.trim() ? 'Unirse a la clase' : 'Crear clase nueva';
  };

  $('joinForm').onsubmit = (e) => {
    e.preventDefault();
    state.name = $('nameInput').value.trim();
    const typed = $('roomInput').value.trim().toLowerCase().replace(/\s+/g, '-');
    state.creating = !typed;
    const room = typed || randomRoom();
    try { localStorage.setItem('aula-meet-name', state.name); } catch {}
    $('joinBtn').disabled = true;
    $('lobbyError').textContent = '';
    join(room);
  };

  function join(room) {
    const socket = io();
    state.socket = socket;
    state.info = new Map(); // id -> { name, mic, cam }

    socket.on('connect_error', () => {
      $('lobbyError').textContent = 'No se pudo conectar con el servidor.';
      $('joinBtn').disabled = false;
    });

    socket.emit('join', { room, name: state.name }, (res) => {
      if (res.error) {
        $('lobbyError').textContent = res.error;
        $('joinBtn').disabled = false;
        socket.disconnect();
        return;
      }
      state.myId = res.id;
      state.room = res.room;
      history.replaceState(null, '', `/sala/${res.room}`);
      $('roomName').textContent = res.room;
      $('lobby').classList.add('hidden');
      $('room').classList.remove('hidden');

      createTile(res.id, state.name, true);
      setLocalVideo(state.camTrack);
      updateButtons();
      broadcastMedia();

      addMessage({ system: true, text: 'Has entrado a la clase. Usa «Copiar enlace» para invitar a más personas.' });
      if (state.creating) showInvite();
      for (const p of res.peers) {
        callPeer(p.id, p.name).catch(console.error);
        setTileState(state.peers.get(p.id)?.tile, p);
      }
    });

    socket.on('peer-joined', ({ id, name, mic, cam }) => {
      state.info.set(id, { name, mic, cam });
      addMessage({ system: true, text: `${name} se ha unido` });
    });

    socket.on('signal', (msg) => handleSignal(msg).catch(console.error));

    socket.on('media-state', ({ id, mic, cam }) => {
      state.info.set(id, { ...state.info.get(id), mic, cam });
      setTileState(state.peers.get(id)?.tile, { mic, cam });
    });

    socket.on('peer-left', ({ id }) => {
      const name = state.peers.get(id)?.name || state.info.get(id)?.name;
      state.info.delete(id);
      removePeer(id);
      if (name) addMessage({ system: true, text: `${name} ha salido` });
    });

    socket.on('chat', (m) => addMessage({ ...m, mine: m.id === state.myId }));

    socket.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') toast('Conexión perdida. Recarga la página para volver a entrar.');
    });
  }

  // ---------- Inicio ----------
  try { $('nameInput').value = localStorage.getItem('aula-meet-name') || ''; } catch {}
  const urlRoom = roomFromUrl();
  if (urlRoom) {
    // Llegó por enlace: solo hace falta el nombre
    $('roomInput').value = urlRoom;
    $('roomInfoName').textContent = urlRoom;
    $('roomInfo').classList.remove('hidden');
    $('roomField').classList.add('hidden');
    $('joinBtn').textContent = 'Entrar a la clase';
  }
  $('nameInput').focus();
  initPreview();
})();
