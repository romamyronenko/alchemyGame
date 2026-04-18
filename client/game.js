'use strict';

// ─── Icon helper ──────────────────────────────────────────────────────────────
// SVG strings go straight into innerHTML; data URIs need an <img> wrapper.
function iconHtml(icon) {
  if (!icon) return '';
  if (icon.startsWith('data:')) return `<img src="${icon}" class="el-icon-img" alt="">`;
  return icon;
}

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

  // Competition
  isCompetition:     false,
  compPhase:         '',
  hostSocketId:      null,
  currentRound:      0,
  roundStarters:     new Set(),
  compMyScore:       0,
  compTimerInterval: null,

  // Hints mode
  hintsEnabled:  false,

  // Sidebar status
  contributions:  {},   // elementId → resultIds[] (static, built on room join)
  showExhausted:  true, // show exhausted elements by default

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
const sidebarSearch       = $('sidebar-search');
const btnShowExhausted    = $('btn-show-exhausted');
const sidebarEl       = $('sidebar-elements');
const categoryTabs    = $('category-tabs');
const canvas          = $('canvas');
const canvasWrap      = $('canvas-wrap');
const sidebarContainer  = document.querySelector('.sidebar');
const sidebarOverlay    = $('sidebar-overlay');
const btnSidebarToggle  = $('btn-sidebar-toggle');
const btnMute              = $('btn-mute');
const toast                = $('discovery-toast');
const btnHints             = $('btn-hints');
const hintsPanel           = $('hints-panel');
const hintsList            = $('hints-list');
const btnCloseHints        = $('btn-close-hints');
const btnCreateComp        = $('btn-create-comp');
const compBar              = $('comp-bar');
const compBarRound         = $('comp-bar-round');
const compBarTimer         = $('comp-bar-timer');
const compBarScores        = $('comp-bar-scores');
const compOverlay          = $('comp-overlay');
const compOverlayTitle     = $('comp-overlay-title');
const compOverlayScores    = $('comp-overlay-scores');
const btnCompNext          = $('btn-comp-next');
const compOverlayWait      = $('comp-overlay-wait');
const compSidebarHeader    = $('comp-sidebar-header');
const compMyScoreEl        = $('comp-my-score');
const COMP_ROUNDS          = 5;
const recipesPanel    = $('recipes-panel');
const recipesList     = $('recipes-list');
const recipesSearch   = $('recipes-search');

// ─── Pack selector ────────────────────────────────────────────────────────────
(async () => {
  try {
    const packs = await fetch('/api/packs').then(r => r.json());
    const sel   = $('pack-select');
    if (!sel) return;
    if (packs.length === 0) return; // no packs — keep hidden
    sel.innerHTML = '<option value="">— Базова гра —</option>' +
      packs.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    sel.style.display = '';
    // Restore pack from URL
    const packFromUrl = new URLSearchParams(location.search).get('pack');
    if (packFromUrl && packs.find(p => p.id === packFromUrl)) sel.value = packFromUrl;
  } catch (_) { /* ignore — server may not have packs */ }
})();

// ─── Pre-fill from URL / localStorage ─────────────────────────────────────────
{
  const savedNick = localStorage.getItem('alchemy_nickname');
  if (savedNick) nicknameInput.value = savedNick;
  const roomFromUrl = new URLSearchParams(location.search).get('room');
  if (roomFromUrl) codeInput.value = roomFromUrl.toUpperCase();
}

// ─── Socket setup ─────────────────────────────────────────────────────────────
function connect() {
  state.socket = io();
  const sock = state.socket;

  // Auto-join if room code is in URL and nickname is known
  sock.on('connect', () => {
    const roomFromUrl = new URLSearchParams(location.search).get('room');
    const savedNick   = localStorage.getItem('alchemy_nickname');
    if (roomFromUrl && savedNick && !state.roomCode) {
      sock.emit('room:join', { nickname: savedNick, code: roomFromUrl.toUpperCase() });
    }
  });

  sock.on('room:created', onRoomState);
  sock.on('room:joined',  snap => snap.isCompetition ? onCompRoomState(snap) : onRoomState(snap));
  sock.on('room:error',   ({ message }) => showModalError(message));

  sock.on('member:joined', ({ socketId, nickname, color }) => {
    addMemberChip(socketId, nickname, color);
    if (state.isCompetition && state.compPhase === 'lobby') refreshCompLobbyMembers();
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
    if (!result.def || state.discovered.has(result.def.id)) playCombine();
  });

  sock.on('discovery:new', ({ elementDef }) => {
    state.discovered.add(elementDef.id);
    state.allElements[elementDef.id] = elementDef;
    addSidebarCard(elementDef);
    updateDiscoveryCount();
    addRecipeRow(elementDef.id);
    showToast(elementDef);
    playDiscovery();
    updateSidebarStatuses();
    renderHints();
  });

  sock.on('hints:state', ({ enabled }) => {
    state.hintsEnabled = enabled;
    applyHintsMode();
  });

  sock.on('host:changed', ({ socketId }) => {
    state.hostSocketId = socketId;
    applyHintsMode();
  });

  // ── Competition events ──
  sock.on('comp:round:start', onCompRoundStart);
  sock.on('comp:round:end',   onCompRoundEnd);
  sock.on('comp:host:changed', ({ socketId }) => { state.hostSocketId = socketId; });

  sock.on('comp:spawned', ({ instance }) => {
    if (!state.canvasItems.has(instance.instanceId)) addCanvasItem(instance, false);
  });
  sock.on('comp:moved', ({ instanceId, x, y }) => {
    const item = state.canvasItems.get(instanceId);
    if (item && (!state.drag || state.drag.instanceId !== instanceId)) {
      item.x = x; item.y = y; setElPos(item.el, x, y);
    }
  });
  sock.on('comp:deleted', ({ instanceId }) => removeCanvasItem(instanceId));

  sock.on('comp:combine:success', ({ consumed, result, isNew }) => {
    for (const id of consumed) removeCanvasItem(id);
    addCanvasItem(result.instance, true);
    if (result.def) state.allElements[result.def.id] = result.def;
    spawnParticles(result.instance.x, result.instance.y, result.def?.tier);
    if (isNew) {
      state.compMyScore++;
      compMyScoreEl.textContent = `${state.compMyScore} відкрито`;
      addSidebarCard(result.def);
      showToast(result.def);
      playDiscovery();
    } else {
      playCombine();
    }
  });
}

// ─── Room state handler ───────────────────────────────────────────────────────
function onRoomState(snap) {
  state.roomCode     = snap.code;
  state.hostSocketId = snap.hostSocketId || null;
  state.hintsEnabled = snap.hintsEnabled || false;
  state.discovered   = new Set(snap.discovered.map(e => e.id));
  state.recipes      = snap.recipes || {};

  // Register all element defs
  for (const e of snap.allElements) state.allElements[e.id] = e;

  // Find my color / nickname
  const me = snap.members.find(m => m.socketId === state.socket.id);
  if (me) { state.myColor = me.color; state.myNickname = me.nickname; }
  if (state.myNickname) localStorage.setItem('alchemy_nickname', state.myNickname);

  // Push room code to URL
  const url = new URL(location.href);
  url.searchParams.set('room', snap.code);
  const packSel = $('pack-select');
  if (packSel?.value) url.searchParams.set('pack', packSel.value);
  else url.searchParams.delete('pack');
  history.replaceState({}, '', url);

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

  // Element statuses + hints
  buildContributions();
  updateSidebarStatuses();
  applyHintsMode();

  // Canvas items
  canvas.innerHTML = '';
  state.canvasItems.clear();
  for (const inst of snap.canvas) addCanvasItem(inst, false);

  // Scroll canvas to centre-ish
  canvasWrap.scrollLeft = 600;
  canvasWrap.scrollTop  = 400;
}

// ─── Element status (dead / exhausted / active) ───────────────────────────────
function buildContributions() {
  // elementId → array of resultIds where this element is used as input
  state.contributions = {};
  for (const [resultId, inputs] of Object.entries(state.recipes)) {
    for (const inputId of new Set(inputs)) {
      (state.contributions[inputId] ??= []).push(resultId);
    }
  }
}

function getCardStatus(elementId) {
  const results = state.contributions[elementId];
  if (!results || results.length === 0) return 'dead';
  if (results.every(r => state.discovered.has(r))) return 'exhausted';
  return 'active';
}

function updateSidebarStatuses() {
  for (const card of sidebarEl.querySelectorAll('.sidebar-card')) {
    const status = getCardStatus(card.dataset.id);
    card.classList.toggle('dead',      status === 'dead');
    card.classList.toggle('exhausted', status === 'exhausted');
  }
  filterSidebar(sidebarSearch.value);
}

btnShowExhausted.addEventListener('click', () => {
  state.showExhausted = !state.showExhausted;
  btnShowExhausted.classList.toggle('active', state.showExhausted);
  filterSidebar(sidebarSearch.value);
});

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function addSidebarCard(def) {
  if (document.querySelector(`.sidebar-card[data-id="${def.id}"]`)) return;

  const card = document.createElement('div');
  card.className = 'element-card sidebar-card';
  card.dataset.id = def.id;
  card.dataset.cat = def.category || '';
  card.innerHTML = `
    ${iconHtml(def.icon)}
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
    const matchQ   = !q || name.includes(q);
    const matchCat = !cat || card.dataset.cat === cat;
    const isDim = card.classList.contains('exhausted') || card.classList.contains('dead');
    card.style.display = (matchQ && matchCat && (!isDim || state.showExhausted)) ? '' : 'none';
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
    ${iconHtml(def.icon)}
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
  el.innerHTML = `${iconHtml(def.icon)}<span class="card-name">${def.name}</span>`;
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

// From sidebar — mouse: ghost on pointerdown; touch: ghost after 8px move, tap if no move
function onSidebarPointerDown(e, def) {
  if (e.button !== 0) return;
  e.preventDefault();

  if (state.isCompetition && state.compPhase !== 'round') return;
  const spawnEvent = state.isCompetition ? 'comp:spawn' : 'element:spawn';
  const isTouch = e.pointerType === 'touch';
  const startX = e.clientX, startY = e.clientY;
  let dragStarted = false;

  if (!isTouch) {
    dragStarted = true;
    ghost = createGhost(def);
    moveGhost(e);
  }

  function onMove(ev) {
    if (!dragStarted && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) {
      dragStarted = true;
      ghost = createGhost(def);
    }
    if (dragStarted) moveGhost(ev);
  }

  function onUp(ev) {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);

    const rect = canvasWrap.getBoundingClientRect();
    const overCanvas = ev.clientX >= rect.left && ev.clientX <= rect.right &&
                       ev.clientY >= rect.top  && ev.clientY <= rect.bottom;

    if (dragStarted) {
      removeGhost();
      if (overCanvas) {
        const x = Math.max(0, ev.clientX - rect.left + canvasWrap.scrollLeft - 43);
        const y = Math.max(0, ev.clientY - rect.top  + canvasWrap.scrollTop  - 48);
        state.socket.emit(spawnEvent, { elementId: def.id, x, y });
        playSpawn();
      }
    } else {
      // Touch tap (no drag): spawn at canvas centre
      const x = Math.max(0, canvasWrap.scrollLeft + rect.width  / 2 - 43);
      const y = Math.max(0, canvasWrap.scrollTop  + rect.height / 2 - 48);
      state.socket.emit(spawnEvent, { elementId: def.id, x, y });
      playSpawn();
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
        const ev = state.isCompetition ? 'comp:move' : 'element:move';
        state.socket.emit(ev, state.pendingMove);
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
    const delEv  = state.isCompetition ? 'comp:delete' : 'element:delete';
    const dropEv = state.isCompetition ? 'comp:drop'   : 'element:drop';
    if (e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top  || e.clientY > rect.bottom) {
      state.socket.emit(delEv, { instanceId });
    } else {
      state.socket.emit(dropEv, { instanceId, x: item.x, y: item.y });
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
      <span class="recipe-input">${iconHtml(d?.icon)}<span>${d?.name || id}</span></span>`;
  }).join('');

  row.innerHTML = `
    <div class="recipe-result">${iconHtml(def.icon)}<span>${def.name}</span></div>
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
  toast.querySelector('.toast-icon').innerHTML = iconHtml(def.icon);
  toast.querySelector('.toast-name').textContent = def.name;
  toast.classList.remove('hidden');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

// ─── Header buttons ───────────────────────────────────────────────────────────
function copyToClipboard(text) {
  const done = () => {
    btnCopyCode.textContent = '✅';
    setTimeout(() => { btnCopyCode.textContent = '📋'; }, 1500);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done).catch(() => execCopy(text, done));
  } else {
    execCopy(text, done);
  }
}

function execCopy(text, cb) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); cb(); } catch (_) {}
  ta.remove();
}

btnCopyCode.addEventListener('click', () => {
  if (state.roomCode) copyToClipboard(state.roomCode);
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
  const packSel = document.getElementById('pack-select');
  const packId  = packSel?.value || null;
  state.socket.emit('room:create', { nickname, packId: packId || null });
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

// ─── Hints mode ───────────────────────────────────────────────────────────────
function computeHints() {
  const hints = [];
  for (const [resultId, inputs] of Object.entries(state.recipes)) {
    if (state.discovered.has(resultId)) continue;               // already found
    if (!inputs.every(id => state.discovered.has(id))) continue; // missing ingredient
    hints.push({ resultId, inputs });
  }
  // Sort by tier so lower-tier discoveries surface first
  hints.sort((a, b) => {
    const ta = state.allElements[a.resultId]?.tier ?? 99;
    const tb = state.allElements[b.resultId]?.tier ?? 99;
    return ta - tb;
  });
  return hints;
}

function renderHints() {
  hintsList.innerHTML = '';
  if (!state.hintsEnabled) return;

  const hints = computeHints();
  if (!hints.length) {
    hintsList.innerHTML = '<p class="no-hints">Немає доступних підказок</p>';
    return;
  }

  for (const { resultId, inputs } of hints) {
    const def = state.allElements[resultId];
    if (!def) continue;

    // Group consecutive identical inputs → touching squares; different → separated by +
    const groups = [];
    for (const id of inputs) {
      if (groups.length && groups[groups.length - 1].id === id) groups[groups.length - 1].count++;
      else groups.push({ id, count: 1 });
    }
    const slotsHtml = groups.map((g, gi) =>
      (gi > 0 ? '<span class="hint-plus">+</span>' : '') +
      Array.from({ length: g.count }, (_, si) =>
        `<div class="hint-slot${si > 0 ? ' same' : ''}"></div>`
      ).join('')
    ).join('');

    const row = document.createElement('div');
    row.className = 'hint-row';
    row.innerHTML = `
      <div class="hint-inputs">${slotsHtml}</div>
      <span class="hint-eq">=</span>
      <div class="hint-result">${iconHtml(def.icon)}<span>${def.name}</span></div>
    `;
    hintsList.appendChild(row);
  }
}

function applyHintsMode() {
  const isHost = state.socket && state.socket.id === state.hostSocketId;

  // Button: host sees it always; others only when hints are on
  btnHints.classList.toggle('hidden', !isHost && !state.hintsEnabled);
  btnHints.classList.toggle('hints-active', state.hintsEnabled);
  btnHints.title = state.hintsEnabled ? 'Вимкнути підказки' : 'Увімкнути підказки';

  if (state.hintsEnabled) {
    hintsPanel.classList.remove('hidden');
    renderHints();
  } else {
    hintsPanel.classList.add('hidden');
  }
}

btnHints.addEventListener('click', () => {
  if (!state.socket) return;
  if (state.socket.id !== state.hostSocketId) return; // only host toggles
  state.socket.emit('hints:toggle');
});

btnCloseHints.addEventListener('click', () => {
  // Non-host can close locally (but mode stays on server)
  hintsPanel.classList.add('hidden');
});

// ─── Competition ──────────────────────────────────────────────────────────────
const RANK_ICONS = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣'];

function onCompRoomState(snap) {
  state.roomCode      = snap.code;
  state.isCompetition = true;
  state.compPhase     = snap.compPhase;
  state.hostSocketId  = snap.hostSocketId;
  state.currentRound  = snap.currentRound;
  state.recipes       = snap.recipes || {};
  state.compMyScore   = 0;

  for (const e of snap.allElements) state.allElements[e.id] = e;

  const me = snap.members.find(m => m.socketId === state.socket.id);
  if (me) { state.myColor = me.color; state.myNickname = me.nickname; }
  if (state.myNickname) localStorage.setItem('alchemy_nickname', state.myNickname);

  // Push room code to URL
  const url = new URL(location.href);
  url.searchParams.set('room', snap.code);
  url.searchParams.delete('pack'); // competition rooms don't use packs
  history.replaceState({}, '', url);

  modalOverlay.classList.add('hidden');
  app.classList.remove('hidden');
  app.classList.add('comp-active');
  roomCodeDisplay.textContent = snap.code;
  compBar.classList.remove('hidden');

  membersList.innerHTML = '';
  for (const m of snap.members) addMemberChip(m.socketId, m.nickname, m.color);

  compSidebarHeader.classList.remove('hidden');
  sidebarEl.innerHTML = '';
  canvas.innerHTML = '';
  state.canvasItems.clear();

  compBarRound.textContent = `Раунд ${snap.currentRound} / ${COMP_ROUNDS}`;
  renderCompBarScores(snap.members.map(m => ({
    socketId: m.socketId, nickname: m.nickname, color: m.color,
    totalScore: snap.scores[m.socketId] || 0,
  })));

  canvasWrap.scrollLeft = 600;
  canvasWrap.scrollTop  = 400;

  if (snap.compPhase === 'lobby') showCompLobby(snap);
}

function showCompLobby(snap) {
  compOverlayTitle.textContent = '🏆 Змагальна кімната';
  compOverlayScores.innerHTML = snap.members.map(m =>
    `<div class="comp-score-row">
       <div class="player-label">
         <span class="member-chip" style="background:${m.color}">${m.nickname}</span>
       </div>
     </div>`
  ).join('');
  const isHost = state.socket.id === snap.hostSocketId;
  btnCompNext.textContent = 'Почати гру →';
  btnCompNext.classList.toggle('hidden', !isHost);
  compOverlayWait.classList.toggle('hidden', isHost);
  compOverlayWait.textContent = 'Очікуємо хоста...';
  compOverlay.classList.remove('hidden');
}

function onCompRoundStart({ round, totalRounds, starterIds, duration }) {
  state.compPhase    = 'round';
  state.currentRound = round;
  state.roundStarters = new Set(starterIds);
  state.compMyScore  = 0;
  compMyScoreEl.textContent = '0 відкрито';

  compOverlay.classList.add('hidden');
  compBarRound.textContent = `Раунд ${round} / ${totalRounds}`;

  // Reset canvas
  canvas.innerHTML = '';
  state.canvasItems.clear();

  // Populate sidebar with starter elements
  sidebarEl.innerHTML = '';
  for (const id of starterIds) {
    const def = state.allElements[id];
    if (def) addSidebarCard(def);
  }

  startCompTimer(duration);
  playSpawn();
}

function onCompRoundEnd({ round, totalRounds, scores, isLast }) {
  state.compPhase = isLast ? 'finished' : 'roundEnd';
  stopCompTimer();

  renderCompBarScores(scores);

  const isHost = state.socket.id === state.hostSocketId;
  compOverlayTitle.textContent = isLast
    ? '🏆 Гра завершена!'
    : `Раунд ${round} завершено!`;

  compOverlayScores.innerHTML = scores.map((s, i) =>
    `<div class="comp-score-row ${i === 0 ? 'winner' : ''}">
       <div class="player-label">
         <span class="rank">${RANK_ICONS[i] || (i+1)+'.'}</span>
         <span class="member-chip" style="background:${s.color}">${s.nickname}</span>
       </div>
       <div style="display:flex;gap:10px;align-items:center;">
         ${!isLast ? `<span class="round-pts">+${s.roundScore}</span>` : ''}
         <span class="total-pts">${s.totalScore} pts</span>
       </div>
     </div>`
  ).join('');

  if (isLast) {
    btnCompNext.classList.add('hidden');
    compOverlayWait.classList.add('hidden');
  } else {
    btnCompNext.textContent = 'Наступний раунд →';
    btnCompNext.classList.toggle('hidden', !isHost);
    compOverlayWait.classList.toggle('hidden', isHost);
    compOverlayWait.textContent = 'Очікуємо хоста...';
  }
  compOverlay.classList.remove('hidden');
}

function renderCompBarScores(scores) {
  compBarScores.innerHTML = scores
    .sort((a, b) => b.totalScore - a.totalScore)
    .map(s => `<span class="comp-score-chip" style="background:${s.color}">${s.nickname} ${s.totalScore}</span>`)
    .join('');
}

function startCompTimer(seconds) {
  stopCompTimer();
  let left = seconds;
  compBarTimer.textContent = formatTime(left);
  compBarTimer.classList.remove('urgent');
  state.compTimerInterval = setInterval(() => {
    left--;
    compBarTimer.textContent = formatTime(left);
    if (left <= 10) compBarTimer.classList.add('urgent');
    if (left <= 0) stopCompTimer();
  }, 1000);
}

function stopCompTimer() {
  if (state.compTimerInterval) {
    clearInterval(state.compTimerInterval);
    state.compTimerInterval = null;
  }
}

function formatTime(s) {
  const m = Math.floor(Math.max(s, 0) / 60);
  const sec = Math.max(s, 0) % 60;
  return `⏱ ${m}:${String(sec).padStart(2,'0')}`;
}

btnCompNext.addEventListener('click', () => {
  if (state.compPhase === 'lobby') {
    state.socket.emit('comp:start');
  } else if (state.compPhase === 'roundEnd') {
    state.socket.emit('comp:next:round');
  }
});

function refreshCompLobbyMembers() {
  const members = [...document.querySelectorAll('[data-sid]')].map(el => ({
    nickname: el.textContent, color: el.style.background,
  }));
  compOverlayScores.innerHTML = members.map(m =>
    `<div class="comp-score-row">
       <div class="player-label">
         <span class="member-chip" style="background:${m.color}">${m.nickname}</span>
       </div>
     </div>`
  ).join('');
}

btnCreateComp.addEventListener('click', () => {
  const nickname = getNickname();
  if (!nickname) return;
  state.socket.emit('comp:room:create', { nickname });
});

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

// ─── Audio ────────────────────────────────────────────────────────────────────
let audioCtx = null;
let muted = localStorage.getItem('alchemy-muted') === '1';

function syncMuteBtn() {
  btnMute.textContent = muted ? '🔇' : '🔊';
}
syncMuteBtn();

btnMute.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('alchemy-muted', muted ? '1' : '0');
  syncMuteBtn();
});

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTone({ freq = 440, freq2 = null, type = 'sine', duration = 0.15, gain = 0.25, delay = 0 }) {
  if (muted) return;
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const g   = ctx.createGain();
  osc.connect(g);
  g.connect(ctx.destination);
  osc.type = type;
  const t = ctx.currentTime + delay;
  osc.frequency.setValueAtTime(freq, t);
  if (freq2) osc.frequency.linearRampToValueAtTime(freq2, t + duration);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.start(t);
  osc.stop(t + duration);
}

function playSpawn() {
  playTone({ freq: 320, freq2: 440, duration: 0.08, gain: 0.12 });
}

function playCombine() {
  playTone({ freq: 523, duration: 0.10, gain: 0.18 });
  playTone({ freq: 659, delay: 0.09, duration: 0.13, gain: 0.18 });
}

function playDiscovery() {
  playTone({ freq: 523, duration: 0.09, gain: 0.22 });
  playTone({ freq: 659, delay: 0.09, duration: 0.09, gain: 0.22 });
  playTone({ freq: 784, delay: 0.18, duration: 0.10, gain: 0.22 });
  playTone({ freq: 1047, delay: 0.28, duration: 0.22, gain: 0.18 });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
connect();
