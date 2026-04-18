'use strict';

const fs   = require('fs');
const path = require('path');

const EDITOR_PATH = path.resolve(process.env.EDITOR_PATH || './server/data/editor.json');

let editorData = { icons: {}, recipesAdd: [], recipesRemove: [], elementsAdd: [] };

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

// ─── Reverse map helpers ───────────────────────────────────────────────────────
function rebuildReverseMap(recipeMap, reverseRecipeMap) {
  reverseRecipeMap.clear();
  for (const [key, output] of recipeMap) {
    if (!reverseRecipeMap.has(output)) {
      reverseRecipeMap.set(output, key.split('+'));
    }
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function initEditor(elementMap, recipeMap, reverseRecipeMap) {
  try {
    const raw = fs.readFileSync(EDITOR_PATH, 'utf8');
    editorData = { icons: {}, recipesAdd: [], recipesRemove: [], elementsAdd: [], ...JSON.parse(raw) };
  } catch (_) {
    // File missing or invalid — start fresh
  }

  // Apply custom elements first (so icons/recipes can reference them)
  for (const el of (editorData.elementsAdd || [])) {
    if (!elementMap.has(el.id)) {
      elementMap.set(el.id, { ...el });
    }
  }

  // Apply custom icons
  for (const [id, dataUri] of Object.entries(editorData.icons)) {
    const def = elementMap.get(id);
    if (def) def.icon = dataUri;
  }

  // Apply removals
  for (const key of editorData.recipesRemove) {
    recipeMap.delete(key);
  }

  // Apply additions
  for (const r of editorData.recipesAdd) {
    const key = [...r.inputs].sort().join('+');
    recipeMap.set(key, r.output);
  }

  // Rebuild reverse map from effective recipeMap
  rebuildReverseMap(recipeMap, reverseRecipeMap);

  console.log(`[editor] loaded: ${(editorData.elementsAdd || []).length} custom elements, ` +
    `${Object.keys(editorData.icons).length} custom icons, ` +
    `${editorData.recipesAdd.length} added recipes, ${editorData.recipesRemove.length} removed recipes`);
}

// ─── Icons ────────────────────────────────────────────────────────────────────
function setIcon(id, dataUri, elementMap) {
  if (!dataUri || !dataUri.startsWith('data:image/')) {
    throw new Error('Invalid image data URI');
  }
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
  const originalIcon = ICONS[id] || '';
  def.icon = originalIcon;
  delete editorData.icons[id];
  save();
  return def;
}

// ─── Elements ─────────────────────────────────────────────────────────────────
const VALID_CATEGORIES = ['nature','materials','flora','civilization','technology','magic','food','fauna','other'];

function addElement(def, elementMap) {
  const { id, name, tier, category, isStarter, icon } = def || {};

  if (!id || !/^[a-z0-9_]+$/.test(id))
    throw new Error('ID must contain only lowercase letters, digits, underscores');
  if (elementMap.has(id))
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

  const el = {
    id,
    name: name.trim(),
    tier: tierNum,
    category,
    isStarter: !!isStarter,
    icon,
  };

  elementMap.set(id, { ...el });
  editorData.elementsAdd.push(el);
  save();
  return el;
}

function removeElement(id, elementMap) {
  if (!elementMap.has(id)) return null;
  // Only allow removing custom elements
  const idx = editorData.elementsAdd.findIndex(el => el.id === id);
  if (idx === -1) return null; // base element — refuse
  editorData.elementsAdd.splice(idx, 1);
  elementMap.delete(id);
  // Also clean up its custom icon entry if any
  delete editorData.icons[id];
  save();
  return id;
}

// ─── Recipes ──────────────────────────────────────────────────────────────────
function addRecipe(inputs, output, elementMap, recipeMap, reverseRecipeMap) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 3) {
    throw new Error('inputs must be an array of 1–3 element IDs');
  }
  if (!output) throw new Error('output is required');

  for (const id of [...inputs, output]) {
    if (!elementMap.has(id)) throw new Error(`Unknown element: ${id}`);
  }

  const key = [...inputs].sort().join('+');

  if (recipeMap.has(key)) {
    throw new Error(`Recipe already exists: ${key} → ${recipeMap.get(key)}`);
  }

  // If this key was previously removed, re-enable it instead of adding to recipesAdd
  const removeIdx = editorData.recipesRemove.indexOf(key);
  if (removeIdx !== -1) {
    editorData.recipesRemove.splice(removeIdx, 1);
  } else {
    editorData.recipesAdd.push({ inputs: [...inputs], output });
  }

  recipeMap.set(key, output);
  if (!reverseRecipeMap.has(output)) {
    reverseRecipeMap.set(output, [...inputs].sort());
  }
  save();
  return { key, output };
}

function removeRecipe(key, recipeMap, reverseRecipeMap) {
  if (!key || !recipeMap.has(key)) return null;

  recipeMap.delete(key);

  // Track removal only if it was a base recipe (not in recipesAdd)
  const addIdx = editorData.recipesAdd.findIndex(
    r => [...r.inputs].sort().join('+') === key
  );
  if (addIdx !== -1) {
    editorData.recipesAdd.splice(addIdx, 1);
  } else {
    if (!editorData.recipesRemove.includes(key)) {
      editorData.recipesRemove.push(key);
    }
  }

  rebuildReverseMap(recipeMap, reverseRecipeMap);
  save();
  return key;
}

// ─── Query ────────────────────────────────────────────────────────────────────
function getEditorData() {
  return {
    icons:          { ...editorData.icons },
    recipesAdd:     [...editorData.recipesAdd],
    recipesRemove:  [...editorData.recipesRemove],
    elementsAdd:    [...(editorData.elementsAdd || [])],
  };
}

module.exports = { initEditor, setIcon, removeIcon, addElement, removeElement, addRecipe, removeRecipe, getEditorData, save };
