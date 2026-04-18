'use strict';

const fs   = require('fs');
const path = require('path');

const EDITOR_PATH = path.resolve(process.env.EDITOR_PATH || './server/data/editor.json');

let editorData = { icons: {}, recipesAdd: [], recipesRemove: [], elementsAdd: [], packs: {} };

// Snapshots of base state taken at initEditor time (before any mutations)
let baseElementEntries = []; // [[id, def], ...]
let baseRecipeEntries  = []; // [[key, output], ...]

// ─── Persistence ──────────────────────────────────────────────────────────────
function save() {
  try {
    const dir = path.dirname(EDITOR_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(EDITOR_PATH, JSON.stringify(editorData, null, 2));
  } catch (e) {
    console.error('[editor] save failed:', e.message);
  }
}

// ─── Map helpers ──────────────────────────────────────────────────────────────
function rebuildReverseMap(recipeMap, reverseRecipeMap) {
  reverseRecipeMap.clear();
  for (const [key, output] of recipeMap) {
    if (!reverseRecipeMap.has(output)) {
      reverseRecipeMap.set(output, key.split('+'));
    }
  }
}

// Restore maps to base state, then apply editorData on top
function applyToMaps(elementMap, recipeMap, reverseRecipeMap) {
  // Reset elementMap to base
  elementMap.clear();
  for (const [id, def] of baseElementEntries) elementMap.set(id, { ...def });

  // Reset recipeMap to base
  recipeMap.clear();
  for (const [key, output] of baseRecipeEntries) recipeMap.set(key, output);

  // Apply custom elements
  for (const el of (editorData.elementsAdd || [])) {
    if (!elementMap.has(el.id)) elementMap.set(el.id, { ...el });
  }

  // Apply custom icons
  for (const [id, dataUri] of Object.entries(editorData.icons)) {
    const def = elementMap.get(id);
    if (def) def.icon = dataUri;
  }

  // Apply recipe removals
  for (const key of (editorData.recipesRemove || [])) recipeMap.delete(key);

  // Apply recipe additions
  for (const r of (editorData.recipesAdd || [])) {
    const key = [...r.inputs].sort().join('+');
    recipeMap.set(key, r.output);
  }

  rebuildReverseMap(recipeMap, reverseRecipeMap);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function initEditor(elementMap, recipeMap, reverseRecipeMap) {
  // Snapshot base state BEFORE any mutations
  baseElementEntries = [...elementMap.entries()].map(([id, def]) => [id, { ...def }]);
  baseRecipeEntries  = [...recipeMap.entries()];

  try {
    const raw = fs.readFileSync(EDITOR_PATH, 'utf8');
    editorData = { icons: {}, recipesAdd: [], recipesRemove: [], elementsAdd: [], packs: {}, ...JSON.parse(raw) };
    if (!editorData.packs) editorData.packs = {};
  } catch (_) {
    // File missing or invalid — start fresh
  }

  applyToMaps(elementMap, recipeMap, reverseRecipeMap);

  const packCount = Object.keys(editorData.packs).length;
  console.log(`[editor] loaded: ${(editorData.elementsAdd || []).length} custom elements, ` +
    `${Object.keys(editorData.icons).length} custom icons, ` +
    `${editorData.recipesAdd.length} added recipes, ${editorData.recipesRemove.length} removed recipes, ` +
    `${packCount} packs`);
}

// ─── Import / Reset ───────────────────────────────────────────────────────────
function importData(data, elementMap, recipeMap, reverseRecipeMap) {
  // Basic shape validation
  if (typeof data !== 'object' || data === null) throw new Error('Invalid data');
  editorData = {
    icons:         data.icons        || {},
    recipesAdd:    data.recipesAdd   || [],
    recipesRemove: data.recipesRemove|| [],
    elementsAdd:   data.elementsAdd  || [],
    packs:         data.packs        || {},
  };
  applyToMaps(elementMap, recipeMap, reverseRecipeMap);
  save();
}

function resetToDefaults(elementMap, recipeMap, reverseRecipeMap) {
  importData({}, elementMap, recipeMap, reverseRecipeMap);
}

// ─── Icons ────────────────────────────────────────────────────────────────────
function setIcon(id, dataUri, elementMap) {
  if (!dataUri || !dataUri.startsWith('data:image/')) throw new Error('Invalid image data URI');
  const def = elementMap.get(id);
  if (!def) return null;
  def.icon = dataUri;
  editorData.icons[id] = dataUri;
  save();
  return def;
}

function removeIcon(id, elementMap, ICONS) {
  const def = elementMap.get(id);
  if (!def) return null;
  def.icon = ICONS[id] || '';
  delete editorData.icons[id];
  save();
  return def;
}

// ─── Elements ─────────────────────────────────────────────────────────────────
const VALID_CATEGORIES = ['nature','materials','flora','civilization','technology','magic','food','fauna','other'];

function validateElementDef(def, existingIds) {
  const { id, name, tier, category, icon } = def || {};
  if (!id || !/^[a-z0-9_]+$/.test(id))
    throw new Error('ID must contain only lowercase letters, digits, underscores');
  if (existingIds && existingIds.has(id))
    throw new Error(`Element already exists: ${id}`);
  if (!name || !name.trim())
    throw new Error('Name is required');
  const tierNum = Number(tier);
  if (!Number.isInteger(tierNum) || tierNum < 1 || tierNum > 5)
    throw new Error('Tier must be 1–5');
  if (!VALID_CATEGORIES.includes(category))
    throw new Error(`Unknown category: ${category}`);
  if (!icon || !icon.startsWith('data:image/'))
    throw new Error('Icon image is required');
  return { id, name: name.trim(), tier: tierNum, category, isStarter: !!def.isStarter, icon };
}

function addElement(def, elementMap) {
  const el = validateElementDef(def, elementMap);
  elementMap.set(el.id, { ...el });
  editorData.elementsAdd.push(el);
  save();
  return el;
}

function removeElement(id, elementMap) {
  if (!elementMap.has(id)) return null;
  const idx = editorData.elementsAdd.findIndex(el => el.id === id);
  if (idx === -1) return null; // base element — refuse
  editorData.elementsAdd.splice(idx, 1);
  elementMap.delete(id);
  delete editorData.icons[id];
  save();
  return id;
}

// ─── Recipes ──────────────────────────────────────────────────────────────────
function addRecipe(inputs, output, elementMap, recipeMap, reverseRecipeMap) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 3)
    throw new Error('inputs must be an array of 1–3 element IDs');
  if (!output) throw new Error('output is required');
  for (const id of [...inputs, output])
    if (!elementMap.has(id)) throw new Error(`Unknown element: ${id}`);

  const key = [...inputs].sort().join('+');
  if (recipeMap.has(key))
    throw new Error(`Recipe already exists: ${key} → ${recipeMap.get(key)}`);

  const removeIdx = editorData.recipesRemove.indexOf(key);
  if (removeIdx !== -1) {
    editorData.recipesRemove.splice(removeIdx, 1);
  } else {
    editorData.recipesAdd.push({ inputs: [...inputs], output });
  }

  recipeMap.set(key, output);
  if (!reverseRecipeMap.has(output)) reverseRecipeMap.set(output, [...inputs].sort());
  save();
  return { key, output };
}

function removeRecipe(key, recipeMap, reverseRecipeMap) {
  if (!key || !recipeMap.has(key)) return null;
  recipeMap.delete(key);

  const addIdx = editorData.recipesAdd.findIndex(r => [...r.inputs].sort().join('+') === key);
  if (addIdx !== -1) {
    editorData.recipesAdd.splice(addIdx, 1);
  } else {
    if (!editorData.recipesRemove.includes(key)) editorData.recipesRemove.push(key);
  }

  rebuildReverseMap(recipeMap, reverseRecipeMap);
  save();
  return key;
}

// ─── Packs ────────────────────────────────────────────────────────────────────
function getPack(packId) {
  const pack = editorData.packs[packId];
  if (!pack) throw new Error(`Pack not found: ${packId}`);
  return pack;
}

function getPackList() {
  return Object.entries(editorData.packs).map(([id, p]) => ({
    id,
    name:         p.name || id,
    recipeCount:  (p.recipes     || []).length,
    elementCount: (p.elementsAdd || []).length,
    iconCount:    Object.keys(p.icons || {}).length,
    starterIds:   p.starterIds   || [],
  }));
}

function addPack(def) {
  const { id, name } = def || {};
  if (!id || !/^[a-z0-9_]+$/.test(id))
    throw new Error('Pack ID must contain only lowercase letters, digits, underscores');
  if (editorData.packs[id]) throw new Error(`Pack already exists: ${id}`);
  if (!name || !name.trim()) throw new Error('Pack name is required');
  editorData.packs[id] = { name: name.trim(), recipes: [], icons: {}, elementsAdd: [], starterIds: [] };
  save();
  return { id, ...editorData.packs[id] };
}

function removePack(packId) {
  if (!editorData.packs[packId]) return null;
  delete editorData.packs[packId];
  save();
  return packId;
}

// Build temporary Maps for a specific pack (called at room creation)
// Returns { recipeMap, reverseMap, elements }
function buildPackMaps(packId) {
  const pack = editorData.packs[packId];
  if (!pack) return null;

  // Elements: base + pack custom, with pack icon overrides
  const elements = [];
  const seenIds = new Set();
  for (const [id, def] of baseElementEntries) {
    const icon = (pack.icons || {})[id] || def.icon;
    elements.push({ ...def, icon });
    seenIds.add(id);
  }
  for (const el of (pack.elementsAdd || [])) {
    if (!seenIds.has(el.id)) {
      elements.push({ ...el });
      seenIds.add(el.id);
    }
  }

  // Recipes: only pack recipes
  const rMap = new Map();
  const revMap = new Map();
  for (const r of (pack.recipes || [])) {
    const key = [...r.inputs].sort().join('+');
    rMap.set(key, r.output);
    if (!revMap.has(r.output)) revMap.set(r.output, [...r.inputs].sort());
  }

  return { recipeMap: rMap, reverseMap: revMap, elements };
}

// ── Pack recipes ──
function addPackRecipe(packId, inputs, output) {
  const pack = getPack(packId);
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 3)
    throw new Error('inputs must be an array of 1–3 element IDs');
  if (!output) throw new Error('output is required');

  // Validate elements exist (base + pack custom)
  const validIds = new Set([
    ...baseElementEntries.map(([id]) => id),
    ...(pack.elementsAdd || []).map(e => e.id),
  ]);
  for (const id of [...inputs, output])
    if (!validIds.has(id)) throw new Error(`Unknown element: ${id}`);

  const key = [...inputs].sort().join('+');
  if ((pack.recipes || []).some(r => [...r.inputs].sort().join('+') === key))
    throw new Error(`Recipe already exists in pack: ${key}`);

  pack.recipes = pack.recipes || [];
  pack.recipes.push({ inputs: [...inputs], output });
  save();
  return { key, output };
}

function removePackRecipe(packId, key) {
  const pack = getPack(packId);
  const idx = (pack.recipes || []).findIndex(r => [...r.inputs].sort().join('+') === key);
  if (idx === -1) return null;
  pack.recipes.splice(idx, 1);
  save();
  return key;
}

// ── Pack icons ──
function setPackIcon(packId, elId, dataUri) {
  if (!dataUri || !dataUri.startsWith('data:image/')) throw new Error('Invalid image data URI');
  const pack = getPack(packId);
  pack.icons = pack.icons || {};
  pack.icons[elId] = dataUri;
  save();
  return elId;
}

function removePackIcon(packId, elId) {
  const pack = getPack(packId);
  if (!pack.icons || !pack.icons[elId]) return null;
  delete pack.icons[elId];
  save();
  return elId;
}

// ── Pack elements ──
function addPackElement(packId, def) {
  const pack = getPack(packId);
  const existingIds = new Set([
    ...baseElementEntries.map(([id]) => id),
    ...(pack.elementsAdd || []).map(e => e.id),
  ]);
  const el = validateElementDef(def, existingIds);
  pack.elementsAdd = pack.elementsAdd || [];
  pack.elementsAdd.push(el);
  save();
  return el;
}

function removePackElement(packId, elId) {
  const pack = getPack(packId);
  const idx = (pack.elementsAdd || []).findIndex(e => e.id === elId);
  if (idx === -1) return null;
  pack.elementsAdd.splice(idx, 1);
  delete (pack.icons || {})[elId];
  save();
  return elId;
}

// ── Pack starters ──
function setPackStarters(packId, starterIds) {
  const pack = getPack(packId);
  if (!Array.isArray(starterIds)) throw new Error('starterIds must be an array');
  pack.starterIds = starterIds;
  save();
  return starterIds;
}

// ─── Query ────────────────────────────────────────────────────────────────────
function getEditorData() {
  return {
    icons:         { ...editorData.icons },
    recipesAdd:    [...editorData.recipesAdd],
    recipesRemove: [...editorData.recipesRemove],
    elementsAdd:   [...(editorData.elementsAdd || [])],
    packs:         JSON.parse(JSON.stringify(editorData.packs || {})),
  };
}

module.exports = {
  initEditor, importData, resetToDefaults,
  setIcon, removeIcon,
  addElement, removeElement,
  addRecipe, removeRecipe,
  getPackList, addPack, removePack, buildPackMaps,
  addPackRecipe, removePackRecipe,
  setPackIcon, removePackIcon,
  addPackElement, removePackElement,
  setPackStarters,
  getEditorData, save,
};
