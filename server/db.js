'use strict';

// Pure-JS persistence via JSON file — no native compilation needed.
// Stores: rooms (code → {createdAt, lastActive, discoveredIds[]})

const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const DB_PATH = path.resolve(process.env.DB_PATH || './server/alchemy.json');

// ─── Load / save ──────────────────────────────────────────────────────────────
let data = { rooms: {} };

function load() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    data = JSON.parse(raw);
    data.rooms = data.rooms || {};
  } catch {
    data = { rooms: {} };
  }
}

function save() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('DB save error:', e.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
function initDb() {
  load();
}

function createRoom(code) {
  const now = Date.now();
  if (!data.rooms[code]) {
    data.rooms[code] = { createdAt: now, lastActive: now, discoveries: [] };
    save();
  }
}

function getRoomDiscoveries(code) {
  return (data.rooms[code]?.discoveries) || [];
}

function saveDiscovery(roomCode, elementId) {
  const room = data.rooms[roomCode];
  if (!room) return;
  if (!room.discoveries.includes(elementId)) {
    room.discoveries.push(elementId);
    room.lastActive = Date.now();
    save();
  }
}

function roomExists(code) {
  return !!data.rooms[code];
}

function deleteOldRooms(olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  let changed = false;
  for (const code of Object.keys(data.rooms)) {
    if (data.rooms[code].lastActive < cutoff) {
      delete data.rooms[code];
      changed = true;
    }
  }
  if (changed) save();
}

module.exports = { initDb, createRoom, getRoomDiscoveries, saveDiscovery, roomExists, deleteOldRooms };
