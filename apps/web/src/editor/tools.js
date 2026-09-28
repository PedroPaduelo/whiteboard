/**
 * tools.js — the toolbar, in Excalidraw's order, as data.
 *
 * The digit shortcuts are derived from this order, and the tool island, the
 * help dialog and the keyboard handler all read it, so the badge on a button
 * can never disagree with the key that selects it.
 *
 * Tool ids are the shared TOOLS values (the server checks presence `activity`
 * against that list), so nothing here is a web-only name.
 */

/**
 * @typedef {Object} ToolDef
 * @property {string} id        shared TOOLS value
 * @property {string} key       single-letter shortcut (lowercase)
 * @property {string|null} digit number-row shortcut, null for none
 * @property {string} icon      name of the icon component in ui/Icons.jsx
 * @property {boolean} [more]   lives in the "more tools" dropdown
 */

/** @type {ToolDef[]} */
export const TOOLBAR = Object.freeze([
  { id: 'hand', key: 'h', digit: null, icon: 'Hand' },
  { id: 'select', key: 'v', digit: '1', icon: 'Pointer' },
  { id: 'rect', key: 'r', digit: '2', icon: 'Square' },
  { id: 'diamond', key: 'd', digit: '3', icon: 'Diamond' },
  { id: 'ellipse', key: 'o', digit: '4', icon: 'Circle' },
  { id: 'arrow', key: 'a', digit: '5', icon: 'ArrowRight' },
  { id: 'line', key: 'l', digit: '6', icon: 'Line' },
  { id: 'pen', key: 'p', digit: '7', icon: 'Pencil' },
  { id: 'text', key: 't', digit: '8', icon: 'Text' },
  { id: 'image', key: null, digit: '9', icon: 'Image' },
  { id: 'eraser', key: 'e', digit: '0', icon: 'Eraser' },
  { id: 'sticky', key: 's', digit: null, icon: 'Sticky', more: true },
  { id: 'cylinder', key: 'c', digit: null, icon: 'Cylinder', more: true },
]);

export const TOOL_BY_ID = Object.freeze(Object.fromEntries(TOOLBAR.map((t) => [t.id, t])));

/** Tools that create an element by dragging a box. */
export const BOX_TOOLS = Object.freeze(['rect', 'diamond', 'ellipse', 'cylinder', 'sticky']);
/** Tools that create a connector by dragging or clicking points. */
export const LINEAR_TOOLS = Object.freeze(['arrow', 'line']);

/** Tool for a keyboard event (letter or digit, no modifiers), or null. */
export function toolForKey(key) {
  if (!key || key.length !== 1) return null;
  const k = key.toLowerCase();
  const byKey = TOOLBAR.find((t) => t.key === k || t.digit === k);
  return byKey ? byKey.id : null;
}
