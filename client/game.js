'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  socket: null,
  roomCode: null,
  myNickname: null,
  myColor: null,

  // All element definitions (from server)
  allElements: {},      // id → def

  // Recipes: elementId → inputIds[]
  recipes: {},

  // Discovered element ids in this room
  discovered: new Set(),

  // Canvas instances: instanceId → { instanceId, elementId, x, y, el (DOM) }
  canvasItems: new Map(),

  // Remote cursors: socketId → DOM element
  remoteCursors: new Map(),

  // Active category filter
  activeCategory: '',

  // Drag state
  drag: null,

  // Throttle for element:move
  moveRaf: null,
  pendingMove: null,

  // Cursor throttle
  cursorRaf: null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const modalOverlay    = $('modal-overlay');
const nicknameInput   = $('nickname-input');
const codeInput       = $('code-input');
const btnCreate       = $('btn-create');
const btnJoin         = $('btn-join');
const btnCopyCode     = $('btn-copy-code');
const btnClear        = $('btn-clear');
const btnRecipes      = $('btn-recipes');
const btnCloseRecipes = $('btn-close-recipes');
const modalError      = $('modal-error');
const app             = $('app');
const roomCodeDisplay = $('room-code-display');
const membersList     = $('members-list');
const discoveryCount  = $('discovery-count');
const sidebarSearch   = $('sidebar-search');
const sidebarEl       = $('sidebar-elements');
const categoryTabs    = $('category-tabs');
const canvas          = $('canvas');
const canvasWrap      = $('canvas-wrap');
const sidebarContainer  = document.querySelector('.sidebar');
const sidebarOverlay    = $('sidebar-overlay');
const btnSidebarToggle  = $('btn-sidebar-toggle');
const toast           = $('discovery-toast');
const recipesPanel    = $('recipes-panel');
const recipesList     = $('recipes-list');
const recipesSearch   = $('recipes-search');

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
    removeRemoteCursor(socketId);
  });

  sock.on('cursor:moved', ({ socketId, x, y }) => {
    updateRemoteCursor(socketId, x, y);
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
    if (result.def) state.allElements[result.def.id] = result.def;
    spawnParticles(result.instance.x, result.instance.y, result.def?.tier);
  });

  sock.on('discovery:new', ({ elementDef }) => {
    state.discovered.add(elementDef.id);
    state.allElements[elementDef.id] = elementDef;
    addSidebarCard(elementDef);
    updateDiscoveryCount();
    addRecipeRow(elementDef.id);
    showToast(elementDef);
  });
}

// ─── Room state handler ───────────────────────────────────────────────────────
function onRoomState(snap) {
  state.roomCode   = snap.code;
  state.discovered = new Set(snap.discovered.map(e => e.id));
  state.recipes    = snap.recipes || {};

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

  // Recipes panel
  recipesList.innerHTML = '';
  for (const e of snap.discovered) {
    if (!state.allElements[e.id]?.isStarter) addRecipeRow(e.id);
  }

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
  if (document.querySelector(`.sidebar-card[data-id="${def.id}"]`)) return;

  const card = document.createElement('div');
  card.className = 'element-card sidebar-card';
  card.dataset.id = def.id;
  card.dataset.cat = def.category || '';
  card.innerHTML = `
    ${def.icon || ''}
    <span class="card-name">${def.name}</span>
  `;

  card.addEventListener('pointerdown', (e) => onSidebarPointerDown(e, def));
  sidebarEl.appendChild(card);
}

function filterSidebar(query) {
  const q = query.toLowerCase();
  const cat = state.activeCategory;
  for (const card of sidebarEl.querySelectorAll('.sidebar-card')) {
    const name = card.querySelector('.card-name').textContent.toLowerCase();
    const matchQ = !q || name.includes(q);
    const matchCat = !cat || card.dataset.cat === cat;
    card.style.display = (matchQ && matchCat) ? '' : 'none';
  }
}

sidebarSearch.addEventListener('input', () => filterSidebar(sidebarSearch.value));

categoryTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.cat-tab');
  if (!tab) return;
  categoryTabs.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  state.activeCategory = tab.dataset.cat;
  filterSidebar(sidebarSearch.value);
});

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

// From sidebar — on touch: tap to spawn at canvas center; on mouse: ghost drag
function onSidebarPointerDown(e, def) {
  if (e.button !== 0) return;
  e.preventDefault();

  if (e.pointerType === 'touch') {
    // Tap-to-spawn: place at center of visible canvas viewport
    const rect = canvasWrap.getBoundingClientRect();
    const x = Math.max(0, canvasWrap.scrollLeft + rect.width  / 2 - 43);
    const y = Math.max(0, canvasWrap.scrollTop  + rect.height / 2 - 48);
    state.socket.emit('element:spawn', { elementId: def.id, x, y });
    closeMobileSidebar();
    return;
  }

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

// ─── Remote cursors ───────────────────────────────────────────────────────────
function getOrCreateCursor(socketId) {
  if (state.remoteCursors.has(socketId)) return state.remoteCursors.get(socketId);

  const members = [...document.querySelectorAll('[data-sid]')];
  const chip = members.find(el => el.dataset.sid === socketId);
  const color = chip ? chip.style.background : '#fff';
  const nickname = chip ? chip.textContent : '?';

  const el = document.createElement('div');
  el.className = 'remote-cursor';
  el.innerHTML = `
    <svg width="16" height="20" viewBox="0 0 16 20">
      <path d="M0,0 L0,16 L4,12 L7,18 L9,17 L6,11 L12,11Z" fill="${color}" stroke="#000" stroke-width="1"/>
    </svg>
    <div class="remote-cursor-label" style="background:${color}">${nickname}</div>
  `;
  canvas.appendChild(el);
  state.remoteCursors.set(socketId, el);
  return el;
}

function updateRemoteCursor(socketId, x, y) {
  const el = getOrCreateCursor(socketId);
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
}

function removeRemoteCursor(socketId) {
  const el = state.remoteCursors.get(socketId);
  if (el) { el.remove(); state.remoteCursors.delete(socketId); }
}

// Emit own cursor position (throttled)
canvasWrap.addEventListener('pointermove', (e) => {
  if (!state.roomCode || !state.socket) return;
  if (state.cursorRaf) return;
  state.cursorRaf = requestAnimationFrame(() => {
    state.cursorRaf = null;
    const rect = canvasWrap.getBoundingClientRect();
    const x = e.clientX - rect.left + canvasWrap.scrollLeft;
    const y = e.clientY - rect.top  + canvasWrap.scrollTop;
    state.socket.emit('cursor:move', { x, y });
  });
});

// ─── Recipes panel ────────────────────────────────────────────────────────────
function addRecipeRow(elementId) {
  if (document.querySelector(`.recipe-row[data-id="${elementId}"]`)) return;
  const inputs = state.recipes[elementId];
  if (!inputs) return;
  const def = state.allElements[elementId];
  if (!def) return;

  const row = document.createElement('div');
  row.className = 'recipe-row';
  row.dataset.id = elementId;
  row.dataset.name = def.name.toLowerCase();

  const inputsHtml = inputs.map((id, i) => {
    const d = state.allElements[id];
    return `${i > 0 ? '<span class="recipe-plus">+</span>' : ''}
      <span class="recipe-input">${d?.icon || ''}<span>${d?.name || id}</span></span>`;
  }).join('');

  row.innerHTML = `
    <div class="recipe-result">${def.icon || ''}<span>${def.name}</span></div>
    <span class="recipe-eq">=</span>
    <div class="recipe-inputs">${inputsHtml}</div>
  `;
  recipesList.appendChild(row);
}

function filterRecipes(query) {
  const q = query.toLowerCase();
  for (const row of recipesList.querySelectorAll('.recipe-row')) {
    row.style.display = (!q || row.dataset.name.includes(q)) ? '' : 'none';
  }
}

btnRecipes.addEventListener('click', () => recipesPanel.classList.toggle('hidden'));
btnCloseRecipes.addEventListener('click', () => recipesPanel.classList.add('hidden'));
recipesSearch.addEventListener('input', () => filterRecipes(recipesSearch.value));

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

// ─── Mobile sidebar ───────────────────────────────────────────────────────────
function openMobileSidebar() {
  sidebarContainer.classList.add('mobile-open');
  sidebarOverlay.classList.add('visible');
}

function closeMobileSidebar() {
  sidebarContainer.classList.remove('mobile-open');
  sidebarOverlay.classList.remove('visible');
}

btnSidebarToggle.addEventListener('click', () => {
  if (sidebarContainer.classList.contains('mobile-open')) closeMobileSidebar();
  else openMobileSidebar();
});

sidebarOverlay.addEventListener('click', closeMobileSidebar);

// ─── Particle effects ─────────────────────────────────────────────────────────
const TIER_COLORS = ['#f9c23c', '#4ecdc4', '#a855f7', '#e94560'];

function spawnParticles(canvasX, canvasY, tier) {
  const rect = canvasWrap.getBoundingClientRect();
  const sx = rect.left + canvasX - canvasWrap.scrollLeft + 43;
  const sy = rect.top  + canvasY - canvasWrap.scrollTop  + 48;

  const color = TIER_COLORS[Math.min((tier || 1) - 1, TIER_COLORS.length - 1)];
  const count = 8 + (tier || 1) * 2;

  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const angle = (i / count) * Math.PI * 2;
    const dist = 40 + Math.random() * 40;
    p.style.cssText = `left:${sx}px;top:${sy}px;background:${color};--dx:${Math.cos(angle) * dist}px;--dy:${Math.sin(angle) * dist}px;`;
    document.body.appendChild(p);
    p.addEventListener('animationend', () => p.remove(), { once: true });
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
connect();
