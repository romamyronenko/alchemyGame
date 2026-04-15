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

// ─── Competition helpers ──────────────────────────────────────────────────────
const COMP_ROUNDS   = 5;
const COMP_DURATION = 90; // seconds per round
const COMP_STARTERS = 10; // starter elements per round

function pickRandom(arr, n) {
  const copy = [...arr];
  const out  = [];
  while (out.length < n && copy.length > 0) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

const ALL_EL_DEFS = () => ELEMENTS.map(e => ({
  id: e.id, name: e.name, tier: e.tier, isStarter: e.isStarter,
  icon: elementMap.get(e.id)?.icon, category: e.category,
}));

function compRoomSnapshot(room) {
  return {
    code:          room.code,
    isCompetition: true,
    compPhase:     room.compPhase,
    currentRound:  room.currentRound,
    hostSocketId:  room.hostSocketId,
    members:       [...room.members.entries()].map(([sid, m]) => ({ socketId: sid, ...m })),
    scores:        Object.fromEntries(room.scores),
    allElements:   ALL_EL_DEFS(),
    recipes:       Object.fromEntries(reverseRecipeMap),
  };
}

function startCompRound(room) {
  room.compPhase      = 'round';
  room.currentRound  += 1;
  room.roundStarterIds = pickRandom(ELEMENTS, COMP_STARTERS).map(e => e.id);

  for (const sid of room.members.keys()) {
    room.playerCanvases.set(sid, new Map());
    room.playerRoundDiscoveries.set(sid, new Set());
  }

  io.to(room.code).emit('comp:round:start', {
    round:       room.currentRound,
    totalRounds: COMP_ROUNDS,
    starterIds:  room.roundStarterIds,
    duration:    COMP_DURATION,
  });

  room.roundTimer = setTimeout(() => endCompRound(room), COMP_DURATION * 1000);
}

function endCompRound(room) {
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
  room.compPhase = 'roundEnd';

  const roundScores = [...room.members.entries()].map(([sid, m]) => {
    const disc       = room.playerRoundDiscoveries.get(sid) || new Set();
    const roundScore = disc.size;
    const total      = (room.scores.get(sid) || 0) + roundScore;
    room.scores.set(sid, total);
    return { socketId: sid, nickname: m.nickname, color: m.color, roundScore, totalScore: total };
  });
  roundScores.sort((a, b) => b.totalScore - a.totalScore);

  const isLast = room.currentRound >= COMP_ROUNDS;
  if (isLast) room.compPhase = 'finished';

  io.to(room.code).emit('comp:round:end', {
    round: room.currentRound, totalRounds: COMP_ROUNDS,
    scores: roundScores, isLast,
  });
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

  // ── Create competition room ──
  socket.on('comp:room:create', ({ nickname }) => {
    const code = generateCode();
    db.createRoom(code);
    const room = {
      code,
      hostSocketId:            socket.id,
      isCompetition:           true,
      compPhase:               'lobby',
      currentRound:            0,
      roundStarterIds:         [],
      playerCanvases:          new Map(),
      playerRoundDiscoveries:  new Map(),
      scores:                  new Map([[socket.id, 0]]),
      roundTimer:              null,
      members:                 new Map([[socket.id, { nickname, color: nextColor() }]]),
      discoveredIds:           new Set(),
      canvas:                  new Map(),
    };
    rooms.set(code, room);
    socket.roomCode = code;
    socket.join(code);
    socket.emit('room:joined', compRoomSnapshot(room));
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
      // Restore from DB (coop only)
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

    if (room.isCompetition && room.compPhase !== 'lobby') {
      socket.emit('room:error', { message: 'Гра вже почалась' });
      return;
    }

    // Check duplicate nickname
    const takenNames = [...room.members.values()].map(m => m.nickname.toLowerCase());
    let finalNickname = nickname;
    if (takenNames.includes(nickname.toLowerCase())) {
      finalNickname = nickname + '_' + Math.floor(Math.random() * 100);
    }

    room.members.set(socket.id, { nickname: finalNickname, color: nextColor() });
    if (room.isCompetition) {
      room.scores.set(socket.id, 0);
      room.playerCanvases.set(socket.id, new Map());
      room.playerRoundDiscoveries.set(socket.id, new Set());
    }

    socket.roomCode = upper;
    socket.join(upper);
    const snap = room.isCompetition ? compRoomSnapshot(room) : roomSnapshot(room);
    socket.emit('room:joined', snap);
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

  // ── Competition controls ──
  socket.on('comp:start', () => {
    const room = getRoom();
    if (!room?.isCompetition || room.compPhase !== 'lobby') return;
    if (socket.id !== room.hostSocketId) return;
    startCompRound(room);
  });

  socket.on('comp:next:round', () => {
    const room = getRoom();
    if (!room?.isCompetition || room.compPhase !== 'roundEnd') return;
    if (socket.id !== room.hostSocketId) return;
    startCompRound(room);
  });

  // ── Competition canvas (private per player) ──
  socket.on('comp:spawn', ({ elementId, x, y }) => {
    const room = getRoom();
    if (!room?.isCompetition || room.compPhase !== 'round') return;
    const allowed = new Set(room.roundStarterIds);
    for (const id of (room.playerRoundDiscoveries.get(socket.id) || [])) allowed.add(id);
    if (!allowed.has(elementId)) return;
    const canvas   = room.playerCanvases.get(socket.id);
    if (!canvas) return;
    const instance = { instanceId: uuidv4(), elementId, x, y };
    canvas.set(instance.instanceId, instance);
    socket.emit('comp:spawned', { instance });
  });

  socket.on('comp:move', ({ instanceId, x, y }) => {
    const room = getRoom();
    if (!room?.isCompetition) return;
    const inst = room.playerCanvases.get(socket.id)?.get(instanceId);
    if (inst) { inst.x = x; inst.y = y; }
  });

  socket.on('comp:drop', ({ instanceId, x, y }) => {
    const room = getRoom();
    if (!room?.isCompetition || room.compPhase !== 'round') return;
    const canvas = room.playerCanvases.get(socket.id);
    if (!canvas) return;
    const inst = canvas.get(instanceId);
    if (!inst) return;
    inst.x = x; inst.y = y;

    const overlapping = [...canvas.values()].filter(o =>
      o.instanceId !== instanceId && Math.hypot(o.x - x, o.y - y) < OVERLAP
    );

    if (!overlapping.length) { socket.emit('comp:moved', { instanceId, x, y }); return; }

    const result = tryRecipe([inst, ...overlapping]);
    if (!result) { socket.emit('comp:moved', { instanceId, x, y }); return; }

    const cx = Math.round(result.used.reduce((s, t) => s + t.x, 0) / result.used.length);
    const cy = Math.round(result.used.reduce((s, t) => s + t.y, 0) / result.used.length);
    for (const id of result.used.map(t => t.instanceId)) canvas.delete(id);

    const newInst = { instanceId: uuidv4(), elementId: result.output, x: cx, y: cy };
    canvas.set(newInst.instanceId, newInst);

    const disc      = room.playerRoundDiscoveries.get(socket.id) || new Set();
    const isStarter = room.roundStarterIds.includes(result.output);
    const isNew     = !isStarter && !disc.has(result.output);
    if (isNew) { disc.add(result.output); room.playerRoundDiscoveries.set(socket.id, disc); }

    socket.emit('comp:combine:success', {
      consumed: result.used.map(t => t.instanceId),
      result:   { instance: newInst, def: elementMap.get(result.output) },
      isNew,
    });
  });

  socket.on('comp:delete', ({ instanceId }) => {
    const room = getRoom();
    if (!room?.isCompetition) return;
    room.playerCanvases.get(socket.id)?.delete(instanceId);
    socket.emit('comp:deleted', { instanceId });
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
    // Transfer host in competition
    if (room.isCompetition && socket.id === room.hostSocketId && room.members.size > 0) {
      room.hostSocketId = [...room.members.keys()][0];
      io.to(room.code).emit('comp:host:changed', { socketId: room.hostSocketId });
    }
    // If room is empty, keep it in DB but remove from memory after a bit
    if (room.members.size === 0) {
      if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }
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
