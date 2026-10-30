const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = Number(process.env.MAX_PER_ROOM || 12);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
// Cualquier ruta /sala/<codigo> sirve la misma app
app.get('/sala/:room', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// rooms: Map<roomId, Map<socketId, { name, mic, cam }>>
const rooms = new Map();

const clean = (s, max) => String(s || '').trim().slice(0, max);

io.on('connection', (socket) => {
  let roomId = null;

  socket.on('join', ({ room, name }, ack) => {
    room = clean(room, 40).toLowerCase().replace(/[^a-z0-9-]/g, '');
    name = clean(name, 30) || 'Invitado';
    if (!room) return ack?.({ error: 'Código de sala no válido' });

    const members = rooms.get(room) || new Map();
    if (members.size >= MAX_PER_ROOM) {
      return ack?.({ error: `La sala está llena (máximo ${MAX_PER_ROOM})` });
    }

    roomId = room;
    members.set(socket.id, { name, mic: true, cam: true });
    rooms.set(room, members);
    socket.join(room);

    const peers = [...members]
      .filter(([id]) => id !== socket.id)
      .map(([id, info]) => ({ id, ...info }));
    ack?.({ ok: true, id: socket.id, room, peers });

    socket.to(room).emit('peer-joined', { id: socket.id, name, mic: true, cam: true });
  });

  // Reenvío de señalización WebRTC (offer / answer / ice)
  socket.on('signal', ({ to, data }) => {
    if (!roomId || !rooms.get(roomId)?.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('media-state', ({ mic, cam }) => {
    const me = rooms.get(roomId)?.get(socket.id);
    if (!me) return;
    me.mic = !!mic;
    me.cam = !!cam;
    socket.to(roomId).emit('media-state', { id: socket.id, mic: me.mic, cam: me.cam });
  });

  socket.on('chat', (text) => {
    const me = rooms.get(roomId)?.get(socket.id);
    text = clean(text, 1000);
    if (!me || !text) return;
    io.to(roomId).emit('chat', { id: socket.id, name: me.name, text, time: Date.now() });
  });

  socket.on('disconnect', () => {
    const members = rooms.get(roomId);
    if (!members) return;
    members.delete(socket.id);
    if (members.size === 0) rooms.delete(roomId);
    socket.to(roomId).emit('peer-left', { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Aula Meet escuchando en http://localhost:${PORT}`);
});
