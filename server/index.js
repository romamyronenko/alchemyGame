'use strict';

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const { elementMap, recipeMap, reverseRecipeMap, ELEMENTS } = require('./elements');

// ─── Init ─────────────────────────────────────────────────────────────────────
db.initDb();

const PORT    = process.env.PORT || 3000;
const TTL_MS  = (Number(process.env.ROOM_TTL_DAYS) || 7) * 86_400_000;
const OVERLAP  = 70; // px — center-to-center threshold for combination

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '../client')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, '../client/index.html')));

// ─── In-memory room state ─────────────────────────────────────────────────────
// rooms: Map<code, Room>
// Room = {
//   code, hostSocketId,
//   members: Map<socketId, {nickname, color}>,
//   discoveredIds: Set<string>,
//   canvas: Map<instanceId, {instanceId, elementId, x, y}>
// }
const rooms = new Map();

const COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63'];
let colorIdx = 0;
function nextColor() { return COLORS[(colorIdx++) % COLORS.length]; }

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function roomSnapshot(room) {
  return {
    code:        room.code,
    discovered:  [...room.discoveredIds].map(id => elementMap.get(id)).filter(Boolean),
    canvas:      [...room.canvas.values()],
    members:     [...room.members.entries()].map(([sid, m]) => ({ socketId: sid, ...m })),
    allElements: ELEMENTS.map(e => ({ id: e.id, name: e.name, tier: e.tier, isStarter: e.isStarter, icon: elementMap.get(e.id)?.icon, category: e.category })),
    // recipe lookup: elementId → sorted input ids
    recipes: Object.fromEntries(reverseRecipeMap),
  };
}

// ─── Combination logic ────────────────────────────────────────────────────────
function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [
    ...combinations(rest, k - 1).map(c => [first, ...c]),
    ...combinations(rest, k),
  ];
}

function tryRecipe(tokens) {
  // Exact match
  const key = tokens.map(t => t.elementId).sort().join('+');
  if (recipeMap.has(key)) return { output: recipeMap.get(key), used: tokens };

  // Subset match — smallest first
  for (let size = 2; size < tokens.length; size++) {
    for (const subset of combinations(tokens, size)) {
      const subKey = subset.map(t => t.elementId).sort().join('+');
      if (recipeMap.has(subKey)) return { output: recipeMap.get(subKey), used: subset };
    }
  }
  return null;
}

// ─── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  function getRoom() {
    return socket.roomCode ? rooms.get(socket.roomCode) : null;
  }

  // ── Create room ──
  socket.on('room:create', ({ nickname }) => {
    const code = generateCode();
    db.createRoom(code);

    const room = {
      code,
      hostSocketId: socket.id,
      members: new Map([[socket.id, { nickname, color: nextColor() }]]),
      discoveredIds: new Set(ELEMENTS.filter(e => e.isStarter).map(e => e.id)),
      canvas: new Map(),
    };
    // Save starter discoveries
    for (const id of room.discoveredIds) db.saveDiscovery(code, id);
    rooms.set(code, room);

    socket.roomCode = code;
    socket.join(code);
    socket.emit('room:created', roomSnapshot(room));
  });

  // ── Join room ──
  socket.on('room:join', ({ nickname, code }) => {
    const upper = code.toUpperCase();
    if (!db.roomExists(upper)) {
      socket.emit('room:error', { message: 'Кімнату не знайдено' });
      return;
    }

    let room = rooms.get(upper);
    if (!room) {
      // Restore from DB
      const discovered = db.getRoomDiscoveries(upper);
      room = {
        code: upper,
        hostSocketId: null,
        members: new Map(),
        discoveredIds: new Set(discovered),
        canvas: new Map(),
      };
      rooms.set(upper, room);
    }

    // Check duplicate nickname
    const takenNames = [...room.members.values()].map(m => m.nickname.toLowerCase());
    let finalNickname = nickname;
    if (takenNames.includes(nickname.toLowerCase())) {
      finalNickname = nickname + '_' + Math.floor(Math.random() * 100);
    }

    room.members.set(socket.id, { nickname: finalNickname, color: nextColor() });
    socket.roomCode = upper;
    socket.join(upper);
    socket.emit('room:joined', roomSnapshot(room));
    socket.to(upper).emit('member:joined', { socketId: socket.id, nickname: finalNickname, color: room.members.get(socket.id).color });
  });

  // ── Spawn element on canvas ──
  socket.on('element:spawn', ({ elementId, x, y }) => {
    const room = getRoom();
    if (!room || !room.discoveredIds.has(elementId)) return;

    const instance = { instanceId: uuidv4(), elementId, x, y };
    room.canvas.set(instance.instanceId, instance);
    io.to(room.code).emit('element:spawned', { instance });
  });

  // ── Move element (throttled on client side) ──
  socket.on('element:move', ({ instanceId, x, y }) => {
    const room = getRoom();
    if (!room) return;
    const inst = room.canvas.get(instanceId);
    if (!inst) return;
    inst.x = x; inst.y = y;
    socket.to(room.code).emit('element:moved', { instanceId, x, y });
  });

  // ── Drop element — trigger combination check ──
  socket.on('element:drop', ({ instanceId, x, y }) => {
    const room = getRoom();
    if (!room) return;
    const inst = room.canvas.get(instanceId);
    if (!inst) return;

    inst.x = x; inst.y = y;

    // Find all overlapping tokens
    const overlapping = [];
    for (const [id, other] of room.canvas) {
      if (id === instanceId) continue;
      const dist = Math.hypot(other.x - x, other.y - y);
      if (dist < OVERLAP) overlapping.push(other);
    }

    if (overlapping.length === 0) {
      // Just broadcast position update
      io.to(room.code).emit('element:moved', { instanceId, x, y });
      return;
    }

    const candidates = [inst, ...overlapping];
    const result = tryRecipe(candidates);

    if (!result) {
      // Silent fail — broadcast position only
      io.to(room.code).emit('element:moved', { instanceId, x, y });
      return;
    }

    // Compute centroid of used tokens
    const cx = Math.round(result.used.reduce((s, t) => s + t.x, 0) / result.used.length);
    const cy = Math.round(result.used.reduce((s, t) => s + t.y, 0) / result.used.length);

    // Remove consumed tokens
    const consumed = result.used.map(t => t.instanceId);
    for (const id of consumed) room.canvas.delete(id);

    // Create result token
    const newInstance = { instanceId: uuidv4(), elementId: result.output, x: cx, y: cy };
    room.canvas.set(newInstance.instanceId, newInstance);

    const isNew = !room.discoveredIds.has(result.output);
    if (isNew) {
      room.discoveredIds.add(result.output);
      db.saveDiscovery(room.code, result.output);
    }

    const resultDef = elementMap.get(result.output);
    io.to(room.code).emit('combine:success', { consumed, result: { instance: newInstance, def: resultDef } });

    if (isNew) {
      io.to(room.code).emit('discovery:new', { elementDef: resultDef });
    }
  });

  // ── Cursor position ──
  socket.on('cursor:move', ({ x, y }) => {
    const room = getRoom();
    if (!room) return;
    socket.to(room.code).emit('cursor:moved', { socketId: socket.id, x, y });
  });

  // ── Delete element ──
  socket.on('element:delete', ({ instanceId }) => {
    const room = getRoom();
    if (!room) return;
    room.canvas.delete(instanceId);
    io.to(room.code).emit('element:deleted', { instanceId });
  });

  // ── Clear canvas ──
  socket.on('canvas:clear', () => {
    const room = getRoom();
    if (!room) return;
    room.canvas.clear();
    io.to(room.code).emit('canvas:cleared');
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const room = getRoom();
    if (!room) return;
    const member = room.members.get(socket.id);
    room.members.delete(socket.id);
    if (member) {
      io.to(room.code).emit('member:left', { socketId: socket.id, nickname: member.nickname });
    }
    // If room is empty, keep it in DB but remove from memory after a bit
    if (room.members.size === 0) {
      setTimeout(() => {
        const r = rooms.get(room.code);
        if (r && r.members.size === 0) rooms.delete(room.code);
      }, 30_000);
    }
  });
});

// ─── Cleanup old rooms periodically ──────────────────────────────────────────
setInterval(() => db.deleteOldRooms(TTL_MS), 3_600_000);

server.listen(PORT, () => console.log(`Alchemy server running on http://localhost:${PORT}`));
