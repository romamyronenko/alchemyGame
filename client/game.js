'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  socket: null,
  roomCode: null,
  myNickname: null,
  myColor: null,

  // All element definitions (from server)
  allElements: {},      // id → def

  // Discovered element ids in this room
  discovered: new Set(),

  // Canvas instances: instanceId → { instanceId, elementId, x, y, el (DOM) }
  canvasItems: new Map(),

  // Drag state
  drag: null,
  // drag = { instanceId, elementId, startX, startY, offsetX, offsetY, fromSidebar }

  // Throttle for element:move
  moveRaf: null,
  pendingMove: null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const modalOverlay   = $('modal-overlay');
const nicknameInput  = $('nickname-input');
const codeInput      = $('code-input');
const btnCreate      = $('btn-create');
const btnJoin        = $('btn-join');
const btnCopyCode    = $('btn-copy-code');
const btnClear       = $('btn-clear');
const modalError     = $('modal-error');
const app            = $('app');
const roomCodeDisplay= $('room-code-display');
const membersList    = $('members-list');
const discoveryCount = $('discovery-count');
const sidebarSearch  = $('sidebar-search');
const sidebarEl      = $('sidebar-elements');
const canvas         = $('canvas');
const canvasWrap     = $('canvas-wrap');
const toast          = $('discovery-toast');

// ─── Socket setup ─────────────────────────────────────────────────────────────
function connect() {
  state.socket = io();
  const sock = state.socket;

  sock.on('room:created', onRoomState);
  sock.on('room:joined',  onRoomState);
  sock.on('room:error',   ({ message }) => showModalError(message));

  sock.on('member:joined', ({ socketId, nickname, color }) => {
    addMemberChip(socketId, nickname, color);
  });
  sock.on('member:left', ({ socketId, nickname }) => {
    const chip = document.querySelector(`[data-sid="${socketId}"]`);
    if (chip) chip.remove();
  });

  sock.on('element:spawned', ({ instance }) => {
    if (!state.canvasItems.has(instance.instanceId)) {
      addCanvasItem(instance, false);
    }
  });
  sock.on('element:moved', ({ instanceId, x, y }) => {
    const item = state.canvasItems.get(instanceId);
    if (item && (!state.drag || state.drag.instanceId !== instanceId)) {
      item.x = x; item.y = y;
      setElPos(item.el, x, y);
    }
  });
  sock.on('element:deleted', ({ instanceId }) => {
    removeCanvasItem(instanceId);
  });
  sock.on('canvas:cleared', () => {
    for (const [id] of state.canvasItems) removeCanvasItem(id);
  });

  sock.on('combine:success', ({ consumed, result }) => {
    for (const id of consumed) removeCanvasItem(id);
    addCanvasItem(result.instance, true);
    // Update def in case it's new
    if (result.def) state.allElements[result.def.id] = result.def;
  });

  sock.on('discovery:new', ({ elementDef }) => {
    state.discovered.add(elementDef.id);
    state.allElements[elementDef.id] = elementDef;
    addSidebarCard(elementDef);
    updateDiscoveryCount();
    showToast(elementDef);
  });
}

// ─── Room state handler ───────────────────────────────────────────────────────
function onRoomState(snap) {
  state.roomCode   = snap.code;
  state.discovered = new Set(snap.discovered.map(e => e.id));

  // Register all element defs
  for (const e of snap.allElements) state.allElements[e.id] = e;

  // Find my color
  const me = snap.members.find(m => m.socketId === state.socket.id);
  if (me) { state.myColor = me.color; }

  // Show app
  modalOverlay.classList.add('hidden');
  app.classList.remove('hidden');
  roomCodeDisplay.textContent = snap.code;

  // Members
  membersList.innerHTML = '';
  for (const m of snap.members) addMemberChip(m.socketId, m.nickname, m.color);

  // Sidebar
  sidebarEl.innerHTML = '';
  for (const e of snap.discovered) {
    const def = state.allElements[e.id];
    if (def) addSidebarCard(def);
  }
  updateDiscoveryCount();

  // Canvas items
  canvas.innerHTML = '';
  state.canvasItems.clear();
  for (const inst of snap.canvas) addCanvasItem(inst, false);

  // Scroll canvas to centre-ish
  canvasWrap.scrollLeft = 600;
  canvasWrap.scrollTop  = 400;
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function addSidebarCard(def) {
  // Avoid duplicates
  if (document.querySelector(`.sidebar-card[data-id="${def.id}"]`)) return;

  const card = document.createElement('div');
  card.className = 'element-card sidebar-card';
  card.dataset.id = def.id;
  card.innerHTML = `
    ${def.icon || ''}
    <span class="card-name">${def.name}</span>
    <span class="tier-badge">T${def.tier || '?'}</span>
  `;

  card.addEventListener('pointerdown', (e) => onSidebarPointerDown(e, def));
  sidebarEl.appendChild(card);
}

function filterSidebar(query) {
  const q = query.toLowerCase();
  for (const card of sidebarEl.querySelectorAll('.sidebar-card')) {
    const name = card.querySelector('.card-name').textContent.toLowerCase();
    card.style.display = (!q || name.includes(q)) ? '' : 'none';
  }
}

sidebarSearch.addEventListener('input', () => filterSidebar(sidebarSearch.value));

// ─── Canvas items ─────────────────────────────────────────────────────────────
function addCanvasItem(instance, animate) {
  const def = state.allElements[instance.elementId];
  if (!def) return;

  const el = document.createElement('div');
  el.className = 'canvas-element';
  el.dataset.instanceId = instance.instanceId;
  el.innerHTML = `
    ${def.icon || ''}
    <span class="card-name">${def.name}</span>
  `;
  setElPos(el, instance.x, instance.y);

  if (animate) {
    el.classList.add('new-pop');
    el.addEventListener('animationend', () => el.classList.remove('new-pop'), { once: true });
  }

  el.addEventListener('pointerdown', (e) => onCanvasPointerDown(e, instance.instanceId));

  canvas.appendChild(el);
  state.canvasItems.set(instance.instanceId, { ...instance, el });
}

function removeCanvasItem(instanceId) {
  const item = state.canvasItems.get(instanceId);
  if (!item) return;
  item.el.remove();
  state.canvasItems.delete(instanceId);
}

function setElPos(el, x, y) {
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
}

// ─── Drag & drop ──────────────────────────────────────────────────────────────

// Ghost element that follows cursor when dragging from sidebar
let ghost = null;

function createGhost(def) {
  const el = document.createElement('div');
  el.className = 'element-card ghost-drag';
  el.innerHTML = `${def.icon || ''}<span class="card-name">${def.name}</span>`;
  el.style.cssText = 'position:fixed;pointer-events:none;opacity:.75;z-index:9999;';
  document.body.appendChild(el);
  return el;
}

function moveGhost(e) {
  if (!ghost) return;
  ghost.style.left = (e.clientX - 43) + 'px';
  ghost.style.top  = (e.clientY - 48) + 'px';
}

function removeGhost() {
  if (ghost) { ghost.remove(); ghost = null; }
}

// From sidebar — creates a ghost, spawns on drop over canvas
function onSidebarPointerDown(e, def) {
  if (e.button !== 0) return;
  e.preventDefault();

  ghost = createGhost(def);
  moveGhost(e);

  function onMove(ev) { moveGhost(ev); }

  function onUp(ev) {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    removeGhost();

    // Check if dropped over canvas area
    const rect = canvasWrap.getBoundingClientRect();
    if (ev.clientX >= rect.left && ev.clientX <= rect.right &&
        ev.clientY >= rect.top  && ev.clientY <= rect.bottom) {
      const x = Math.max(0, ev.clientX - rect.left + canvasWrap.scrollLeft - 43);
      const y = Math.max(0, ev.clientY - rect.top  + canvasWrap.scrollTop  - 48);
      state.socket.emit('element:spawn', { elementId: def.id, x, y });
    }
  }

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

// From canvas — drags existing element
function onCanvasPointerDown(e, instanceId) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const item = state.canvasItems.get(instanceId);
  if (!item) return;

  const rect = canvasWrap.getBoundingClientRect();
  const cx = e.clientX - rect.left + canvasWrap.scrollLeft;
  const cy = e.clientY - rect.top  + canvasWrap.scrollTop;

  state.drag = {
    instanceId,
    elementId: item.elementId,
    offsetX: cx - item.x,
    offsetY: cy - item.y,
  };

  item.el.classList.add('dragging');
  item.el.style.zIndex = 500;
}

document.addEventListener('pointermove', (e) => {
  if (!state.drag) return;

  const rect = canvasWrap.getBoundingClientRect();
  const cx = e.clientX - rect.left + canvasWrap.scrollLeft;
  const cy = e.clientY - rect.top  + canvasWrap.scrollTop;

  const x = Math.max(0, cx - state.drag.offsetX);
  const y = Math.max(0, cy - state.drag.offsetY);

  const item = state.canvasItems.get(state.drag.instanceId);
  if (!item) return;

  item.x = x; item.y = y;
  setElPos(item.el, x, y);

  // Throttle server move updates
  state.pendingMove = { instanceId: state.drag.instanceId, x, y };
  if (!state.moveRaf) {
    state.moveRaf = requestAnimationFrame(() => {
      if (state.pendingMove) {
        state.socket.emit('element:move', state.pendingMove);
        state.pendingMove = null;
      }
      state.moveRaf = null;
    });
  }
});

document.addEventListener('pointerup', (e) => {
  if (!state.drag) return;

  const { instanceId } = state.drag;
  const item = state.canvasItems.get(instanceId);

  if (item) {
    item.el.classList.remove('dragging');
    item.el.style.zIndex = '';

    // Check if dropped outside canvas-wrap (delete)
    const rect = canvasWrap.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top  || e.clientY > rect.bottom) {
      state.socket.emit('element:delete', { instanceId });
    } else {
      state.socket.emit('element:drop', { instanceId, x: item.x, y: item.y });
    }
  }

  state.drag = null;
});

// ─── UI helpers ───────────────────────────────────────────────────────────────
function addMemberChip(socketId, nickname, color) {
  // Remove existing if rejoining
  const existing = membersList.querySelector(`[data-sid="${socketId}"]`);
  if (existing) existing.remove();

  const chip = document.createElement('div');
  chip.className = 'member-chip';
  chip.dataset.sid = socketId;
  chip.textContent = nickname;
  chip.style.background = color;
  membersList.appendChild(chip);

  if (state.socket && socketId === state.socket.id) {
    state.myNickname = nickname;
  }
}

function updateDiscoveryCount() {
  const total = Object.keys(state.allElements).length;
  discoveryCount.textContent = `${state.discovered.size} / ${total}`;
}

function showModalError(msg) {
  modalError.textContent = msg;
  setTimeout(() => { modalError.textContent = ''; }, 4000);
}

// ─── Toast notification ───────────────────────────────────────────────────────
let toastTimer = null;
function showToast(def) {
  toast.querySelector('.toast-icon').innerHTML = def.icon || '';
  toast.querySelector('.toast-name').textContent = def.name;
  toast.classList.remove('hidden');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

// ─── Header buttons ───────────────────────────────────────────────────────────
btnCopyCode.addEventListener('click', () => {
  if (!state.roomCode) return;
  navigator.clipboard.writeText(state.roomCode).then(() => {
    btnCopyCode.textContent = '✅';
    setTimeout(() => { btnCopyCode.textContent = '📋'; }, 1500);
  });
});

btnClear.addEventListener('click', () => {
  if (confirm('Очистити поле?')) state.socket.emit('canvas:clear');
});

// ─── Modal buttons ────────────────────────────────────────────────────────────
function getNickname() {
  const n = nicknameInput.value.trim();
  if (!n) { showModalError('Введіть нікнейм'); return null; }
  return n;
}

btnCreate.addEventListener('click', () => {
  const nickname = getNickname();
  if (!nickname) return;
  state.socket.emit('room:create', { nickname });
});

btnJoin.addEventListener('click', () => {
  const nickname = getNickname();
  if (!nickname) return;
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 6) { showModalError('Введіть 6-значний код'); return; }
  state.socket.emit('room:join', { nickname, code });
});

nicknameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnCreate.click(); });
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnJoin.click(); });
codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase(); });

// ─── Boot ─────────────────────────────────────────────────────────────────────
connect();
