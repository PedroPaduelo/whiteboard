/**
 * shortcuts.js — the keyboard map, as data.
 *
 * ONE table (`SHORTCUTS`) drives both the global keydown handler (App.jsx →
 * `runShortcut`) and the help dialog (`groupedShortcuts`), and the tool rows
 * are derived from editor/tools.js TOOLBAR, so the digit badge on a tool
 * button, the help sheet and the key that actually selects the tool cannot
 * disagree.
 *
 * A binding is:
 *   { id, group, label, keys: string[], handler({store, ui, actions, event}),
 *     when?(ctx) => boolean, native?: true, hold?: true, allowInInput?: true,
 *     inModal?: true | (ctx) => boolean, repeat?: false, display?: string[] }
 * `keys` lists alternative chords like 'Mod+Shift+Z' or '?'. A handler may
 * return `false` to say "not handled" — the event then keeps its default and
 * the next binding gets a chance. `native` bindings (Ctrl+C/X/V) are shown in
 * help but never run from keydown: the real copy/cut/paste events do the work,
 * so this handler must not preventDefault them. `hold` rows are help-only.
 * While a modal dialog is open only `inModal` bindings run (Escape, and '?'
 * to close the help it opened); every other key belongs to the dialog.
 *
 * Key matching (`matchesEvent`):
 *   - letters: `event.key` when it is a Latin letter, else `event.code`
 *     (`KeyZ`), so Cyrillic/Greek/… layouts and Alt/Option-mangled keys
 *     (⌥D = "∂") still hit the right binding;
 *   - digits: `event.code` (`Digit1`/`Numpad1`) first, so Shift+1 (= "!")
 *     and AZERTY's unshifted digit row work;
 *   - symbols: the character itself or its shifted twin (`[`/`{`); Shift is
 *     ignored for '?', '=' and '-', which need Shift on many layouts;
 *   - modifiers are exact: 'Mod' is Ctrl or ⌘, and an unnamed modifier held
 *     down means no match (Ctrl+Z is not Z).
 */

import { TOOLBAR } from '../editor/tools.js';
import { actions as editorActions, nudgeStep } from '../editor/actions.js';
import { t } from './strings.js';

const DEV = (() => {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
})();

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/** Symbol tokens: accepted characters, physical-code fallback, Shift policy. */
const SYMBOLS = {
  '?': { chars: ['?'], codes: ['Slash', 'IntlRo'], shiftAgnostic: true },
  '=': { chars: ['=', '+'], codes: ['Equal', 'NumpadAdd'], shiftAgnostic: true },
  '-': { chars: ['-', '_'], codes: ['Minus', 'NumpadSubtract'], shiftAgnostic: true },
  '[': { chars: ['[', '{'], codes: ['BracketLeft'] },
  ']': { chars: [']', '}'], codes: ['BracketRight'] },
  "'": { chars: ["'", '"'], codes: ['Quote'] },
};

const MODIFIER_TOKENS = new Set(['Mod', 'Shift', 'Alt']);

/** True when the event target is a text-entry surface (keys belong to it). */
export function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String(target.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file', 'image'].includes(type);
  }
  return false;
}

/**
 * True when the target is a focused control that owns Enter/Space/arrows
 * itself: a button (Enter clicks it), a slider, a menu or radio group (arrows
 * move within it). Shortcuts on those keys must not steal them.
 */
export function isControlTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return true;
  const role = typeof target.getAttribute === 'function' ? target.getAttribute('role') : null;
  if (role && /^(button|menuitem|menuitemradio|menuitemcheckbox|option|radio|slider|tab|switch|checkbox)$/.test(role)) return true;
  return typeof target.closest === 'function' && Boolean(target.closest('[role="menu"],[role="listbox"],[role="radiogroup"],[role="dialog"] [role="slider"]'));
}

const CONTROL_KEYS = new Set(['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

/** Split 'Mod+Shift+Z' into modifiers and the key token. '+' alone is not used. */
export function parseChord(chord) {
  const parts = String(chord).split('+');
  const mods = new Set();
  let key = '';
  for (const p of parts) {
    if (MODIFIER_TOKENS.has(p)) mods.add(p);
    else key = p;
  }
  return { mods, key };
}

const isPrintableAscii = (k) => typeof k === 'string' && k.length === 1 && k >= ' ' && k <= '~';

/** The Latin letter an event stands for, by key or (non-Latin layouts) by code. */
function letterOf(event) {
  const k = event.key;
  if (typeof k === 'string' && /^[a-zA-Z]$/.test(k)) return k.toLowerCase();
  const m = /^Key([A-Z])$/.exec(event.code || '');
  return m ? m[1].toLowerCase() : null;
}

function keyMatches(event, key) {
  if (!key) return false;
  if (/^[a-zA-Z]$/.test(key)) return letterOf(event) === key.toLowerCase();
  if (/^[0-9]$/.test(key)) {
    const code = event.code || '';
    if (code === `Digit${key}` || code === `Numpad${key}`) return true;
    return !code && event.key === key;
  }
  const sym = SYMBOLS[key];
  if (sym) {
    if (sym.chars.includes(event.key)) return true;
    return !isPrintableAscii(event.key) && sym.codes.includes(event.code);
  }
  return event.key === key; // named keys: Delete, Escape, ArrowUp…
}

/** Does `event` match one chord ('Mod+Z', '?', 'Shift+1', 'Delete')? */
export function matchesChord(event, chord) {
  if (!event) return false;
  const { mods, key } = parseChord(chord);
  const mod = Boolean(event.ctrlKey || event.metaKey);
  if (mods.has('Mod') !== mod) return false;
  if (mods.has('Alt') !== Boolean(event.altKey)) return false;
  const shiftAgnostic = Boolean(SYMBOLS[key]?.shiftAgnostic) && !mods.has('Shift');
  if (!shiftAgnostic && mods.has('Shift') !== Boolean(event.shiftKey)) return false;
  return keyMatches(event, key);
}

/** Does `event` match any of `keys` (a chord or a list of alternative chords)? */
export function matchesEvent(event, keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  return list.some((chord) => matchesChord(event, chord));
}

/* ------------------------------------------------------------------ *
 * Display
 * ------------------------------------------------------------------ */

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

const KEY_NAMES = {
  Mod: IS_MAC ? '⌘' : 'Ctrl',
  Shift: 'Shift',
  Alt: IS_MAC ? '⌥' : 'Alt',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Escape: 'Esc',
  Enter: 'Enter',
  Space: 'Espaço',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  '=': '+',
};

/** 'Mod+Shift+Z' -> ['Ctrl', 'Shift', 'Z'] (the key caps the help dialog draws). */
export function formatChord(chord) {
  return String(chord)
    .split('+')
    .filter(Boolean)
    .map((p) => KEY_NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p));
}

/** 'Mod+Shift+Z' -> 'Ctrl+Shift+Z' (tooltips). */
export function formatKeys(chord) {
  return formatChord(chord).join('+');
}

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

const GROUP = { tools: 'tools', edit: 'edit', view: 'view', board: 'board' };

/** The chords that select a TOOLBAR tool: its letter, then its digit. */
export function toolChords(tool) {
  return [tool.key, tool.digit].filter(Boolean).map((k) => k.toUpperCase());
}

const toolBindings = TOOLBAR.map((tool) => ({
  id: `tool.${tool.id}`,
  group: GROUP.tools,
  label: t.tools[tool.id] ?? tool.id,
  keys: toolChords(tool),
  repeat: false,
  handler: ({ actions }) => actions.selectTool(tool.id),
}));

const ARROW_DELTAS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

export const SHORTCUTS = [
  /* --- tools ------------------------------------------------------------- */
  ...toolBindings,
  {
    id: 'tool.lock',
    group: GROUP.tools,
    label: t.actions.toggleToolLock,
    keys: ['Q'],
    repeat: false,
    handler: ({ store }) => store.toggleToolLocked(),
  },
  { id: 'view.pan.space', group: GROUP.tools, label: t.actions.pan, keys: ['Space'], hold: true, handler: () => false },

  /* --- editing ------------------------------------------------------------ */
  { id: 'edit.undo', group: GROUP.edit, label: t.actions.undo, keys: ['Mod+Z'], handler: ({ store }) => store.undo() },
  { id: 'edit.redo', group: GROUP.edit, label: t.actions.redo, keys: ['Mod+Shift+Z', 'Mod+Y'], handler: ({ store }) => store.redo() },
  { id: 'edit.selectAll', group: GROUP.edit, label: t.actions.selectAll, keys: ['Mod+A'], handler: ({ actions }) => void actions.selectAll() },
  { id: 'edit.duplicate', group: GROUP.edit, label: t.actions.duplicate, keys: ['Mod+D'], handler: ({ actions }) => void actions.duplicateSelection() },
  { id: 'edit.copy', group: GROUP.edit, label: t.actions.copy, keys: ['Mod+C'], native: true, handler: () => false },
  { id: 'edit.cut', group: GROUP.edit, label: t.actions.cut, keys: ['Mod+X'], native: true, handler: () => false },
  { id: 'edit.paste', group: GROUP.edit, label: t.actions.paste, keys: ['Mod+V'], native: true, handler: () => false },
  {
    id: 'edit.delete',
    group: GROUP.edit,
    label: t.actions.delete,
    keys: ['Delete', 'Backspace'],
    // commit('delete') -> removeElements(ids) -> clearSelection(): undoable,
    // and never leaves a stale selection behind.
    handler: ({ store }) => void editorActions.deleteSelection(store),
  },
  {
    id: 'edit.nudge',
    group: GROUP.edit,
    label: t.actions.nudge,
    keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift+ArrowUp', 'Shift+ArrowDown', 'Shift+ArrowLeft', 'Shift+ArrowRight'],
    display: ['ArrowUp', 'Shift+ArrowUp'],
    // One grid cell per press in grid mode (Shift: 1 unit), else 1 (Shift ×10).
    handler: ({ store, actions, event }) => {
      const d = ARROW_DELTAS[event?.key];
      if (!d) return false;
      const step = nudgeStep(event.shiftKey, store?.getState?.());
      return actions.nudge(d[0] * step, d[1] * step);
    },
  },
  { id: 'edit.group', group: GROUP.edit, label: t.actions.group, keys: ['Mod+G'], handler: ({ actions }) => void actions.group() },
  { id: 'edit.ungroup', group: GROUP.edit, label: t.actions.ungroup, keys: ['Mod+Shift+G'], handler: ({ actions }) => void actions.ungroup() },
  {
    id: 'edit.lock',
    group: GROUP.edit,
    label: `${t.actions.lock} / ${t.actions.unlock}`,
    keys: ['Mod+Shift+L'],
    repeat: false,
    handler: ({ actions }) => void actions.toggleLock(),
  },
  { id: 'edit.forward', group: GROUP.edit, label: t.actions.bringForward, keys: ['Mod+]'], handler: ({ actions }) => void actions.bringForward() },
  { id: 'edit.backward', group: GROUP.edit, label: t.actions.sendBackward, keys: ['Mod+['], handler: ({ actions }) => void actions.sendBackward() },
  { id: 'edit.front', group: GROUP.edit, label: t.actions.bringToFront, keys: ['Mod+Shift+]'], handler: ({ actions }) => void actions.bringToFront() },
  { id: 'edit.back', group: GROUP.edit, label: t.actions.sendToBack, keys: ['Mod+Shift+['], handler: ({ actions }) => void actions.sendToBack() },
  {
    id: 'edit.enter',
    group: GROUP.edit,
    label: t.actions.editText,
    keys: ['Enter'],
    handler: ({ actions }) => actions.editSelected(),
  },
  {
    id: 'edit.escape',
    group: GROUP.edit,
    label: t.actions.escape,
    keys: ['Escape'],
    allowInInput: true,
    inModal: true,
    // Close overlay -> finish text edit -> clear selection -> select tool.
    handler: ({ store, ui, event }) => {
      if (ui?.closeTopOverlay?.()) return true;
      // Escape inside a field (board title, library search) belongs to it.
      if (isTypingTarget(event?.target)) return false;
      const s = store.getState();
      if (s.editingId) {
        // Blur the editor so it COMMITS what was typed (TextEditor commits on
        // blur); only without one on screen is the stale edit state dropped.
        const editor = globalThis.document?.querySelector?.('[data-testid="text-editor"]');
        if (editor) editor.blur();
        else store.setEditing(null);
        return true;
      }
      if (s.selection && s.selection.size > 0) {
        store.clearSelection();
        return true;
      }
      if (s.tool !== 'select') {
        store.setTool('select');
        return true;
      }
      return false;
    },
  },

  /* --- view ------------------------------------------------------------- */
  { id: 'view.zoomIn', group: GROUP.view, label: t.actions.zoomIn, keys: ['Mod+='], handler: ({ actions }) => actions.zoomIn() },
  { id: 'view.zoomOut', group: GROUP.view, label: t.actions.zoomOut, keys: ['Mod+-'], handler: ({ actions }) => actions.zoomOut() },
  { id: 'view.zoomReset', group: GROUP.view, label: t.actions.resetZoom, keys: ['Mod+0'], handler: ({ actions }) => actions.resetZoom() },
  { id: 'view.zoomFit', group: GROUP.view, label: t.actions.zoomToFit, keys: ['Shift+1'], handler: ({ actions }) => actions.zoomToFit() },
  { id: 'view.zoomSelection', group: GROUP.view, label: t.actions.zoomToSelection, keys: ['Shift+2'], handler: ({ actions }) => actions.zoomToSelection() },
  { id: 'view.wheel', group: GROUP.view, label: t.actions.wheelZoom, keys: ['Mod+Wheel'], hold: true, display: ['Mod+Roda'], handler: () => false },
  { id: 'view.grid', group: GROUP.view, label: t.actions.toggleGrid, keys: ["Mod+'"], repeat: false, handler: ({ actions }) => actions.toggleGrid() },
  { id: 'view.theme', group: GROUP.view, label: t.actions.toggleTheme, keys: ['Alt+Shift+D'], repeat: false, handler: ({ ui }) => ui.toggleTheme() },
  {
    id: 'view.help',
    group: GROUP.view,
    label: t.actions.help,
    keys: ['?'],
    repeat: false,
    // '?' toggles, as in Excalidraw: with the help sheet open (a modal) it is
    // the one other key that still runs — only to close that sheet.
    inModal: ({ ui }) => Boolean(ui?.isOpen?.('helpOpen')),
    handler: ({ ui }) => ui.toggle('helpOpen'),
  },

  /* --- board -------------------------------------------------------------- */
  { id: 'board.export', group: GROUP.board, label: t.actions.exportImage, keys: ['Mod+Shift+E'], repeat: false, handler: ({ ui }) => ui.toggle('exportOpen') },
  { id: 'board.save', group: GROUP.board, label: t.actions.save, keys: ['Mod+S'], repeat: false, handler: ({ actions }) => actions.saveToFile() },
  { id: 'board.open', group: GROUP.board, label: t.actions.open, keys: ['Mod+O'], repeat: false, handler: ({ ui }) => (ui.openFile ? ui.openFile() : false) },
];

/** Binding by id. */
export const SHORTCUT_BY_ID = Object.freeze(Object.fromEntries(SHORTCUTS.map((s) => [s.id, s])));

/** Help dialog order. */
export const SHORTCUT_GROUPS = [GROUP.tools, GROUP.edit, GROUP.view, GROUP.board];

/**
 * Bindings grouped for the help dialog: `{group, title, items: [{id, label,
 * chords: string[][]}]}` — each chord already formatted into key caps.
 */
export function groupedShortcuts() {
  return SHORTCUT_GROUPS.map((group) => ({
    group,
    title: t.help.groups[group] ?? group,
    items: SHORTCUTS.filter((s) => s.group === group).map((s) => ({
      id: s.id,
      label: s.label,
      chords: (s.display ?? s.keys).map(formatChord),
    })),
  }));
}

/** The first chord of a binding, formatted for a tooltip ('Ctrl+D'). */
export function shortcutHint(id) {
  const s = SHORTCUT_BY_ID[id];
  if (!s || !s.keys.length) return '';
  return (s.display ?? s.keys).map(formatKeys).join(` ${t.help.or} `);
}

/**
 * Run the first binding matching `event`. Returns the binding id when a
 * handler handled it (the caller then preventDefaults), else null — so a key
 * nothing handled keeps its browser default.
 *
 * `ctx` = `{store, ui, actions}`; `actions` defaults to editor/actions.js.
 * A handler that throws is reported with console.error (never silently) and
 * counts as not handled; in development it is re-thrown so it cannot hide.
 * `modal`: a modal dialog is open, so only `inModal` bindings may run.
 *
 * @param {KeyboardEvent} event
 * @param {{store:object, ui?:object, actions?:object}} ctx
 * @param {{dev?: boolean, modal?: boolean}} [opts]
 * @returns {string|null}
 */
export function runShortcut(event, ctx, { dev = DEV, modal = false } = {}) {
  if (!event || event.isComposing) return null;
  const typing = isTypingTarget(event.target);
  // Enter/Space/arrows on a focused button, slider or menu are that control's.
  if (!typing && CONTROL_KEYS.has(event.key) && !(event.ctrlKey || event.metaKey) && isControlTarget(event.target)) return null;
  const full = { actions: editorActions, ...ctx, event };
  for (const s of SHORTCUTS) {
    if (s.hold || s.native) continue;
    if (typing && !s.allowInInput) continue;
    if (event.repeat && s.repeat === false) continue;
    if (!matchesEvent(event, s.keys)) continue;
    if (modal && !(typeof s.inModal === 'function' ? s.inModal(full) : s.inModal)) continue;
    if (s.when && !s.when(full)) continue;
    let result;
    try {
      result = s.handler(full);
    } catch (err) {
      console.error(`[shortcuts] "${s.id}" failed`, err);
      if (dev) throw err;
      return null;
    }
    if (result === false) continue;
    return s.id;
  }
  return null;
}
