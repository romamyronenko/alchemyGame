'use strict';

const fs   = require('fs');
const path = require('path');

const EDITOR_PATH = path.resolve(process.env.EDITOR_PATH || './server/data/editor.json');

let editorData = { icons: {}, recipesAdd: [], recipesRemove: [] };

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
    editorData = { icons: {}, recipesAdd: [], recipesRemove: [], ...JSON.parse(raw) };
  } catch (_) {
    // File missing or invalid — start fresh
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

  console.log(`[editor] loaded: ${Object.keys(editorData.icons).length} custom icons, ` +
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
  };
}

module.exports = { initEditor, setIcon, removeIcon, addRecipe, removeRecipe, getEditorData, save };
