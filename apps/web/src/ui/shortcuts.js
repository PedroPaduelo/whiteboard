/**
 * shortcuts.js — the single source of truth for keyboard behaviour.
 *
 * Every key binding in the app lives in `SHORTCUTS` as data. The global
 * handler installed by App.jsx walks this array; Toolbar.jsx reads it to draw
 * the hint badge next to each tool button; HelpOverlay.jsx renders it as the
 * shortcut sheet. None of those three can drift from the bindings, because
 * none of them own a key.
 *
 * A handler is `({ store, ui, event }) => void`, where:
 *   store  — the board store: `getState()` plus every documented action
 *   ui     — shell-level intents App owns (open help, export, theme, …)
 *   event  — the original KeyboardEvent, for `preventDefault` decisions
 *
 * Handlers must be defensive: the store may not be hydrated yet, and a
 * binding must never throw just because there is nothing selected.
 */

import { TOOLS } from '@whiteboard/shared';

/* --- key normalisation ----------------------------------------------------- */

/** Canonical name for a modifier flag, whatever the event actually reports. */
const MODS = {
  ctrl: (e) => e.ctrlKey,
  // Cmd on macOS is the same intent as Ctrl everywhere else; `matchesEvent`
  // treats them as interchangeable so a Mac user does not have to learn a
  // second vocabulary.
  mod: (e) => e.ctrlKey || e.metaKey,
  meta: (e) => e.metaKey,
  shift: (e) => e.shiftKey,
  alt: (e) => e.altKey,
};

/** Human-facing names for the keys we actually bind. */
const KEY_ALIASES = {
  Mod: 'Ctrl',
  Ctrl: 'Ctrl',
  Meta: 'Cmd',
  Cmd: 'Cmd',
  Shift: 'Shift',
  Alt: 'Alt',
  Esc: 'Esc',
  Escape: 'Esc',
  Del: 'Delete',
  Delete: 'Delete',
  Backspace: 'Delete',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Question: '?',
};

function isModifier(key) {
  return Object.prototype.hasOwnProperty.call(MODS, key);
}

/** "Escape" / "?" / "A" all reduce to a single comparable token. */
function keyToken(event) {
  const k = event.key;
  if (!k) return '';
  return k.length === 1 ? k.toLowerCase() : k.toLowerCase();
}

/* --- helpers ---------------------------------------------------------------- */

/** True when the event target is a text-entry surface. */
export function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable === true;
}

/**
 * Does `event` match the `keys` chord?
 *
 * A chord is a list like `['Mod', 'z']` or `['Shift', '?']` or `['1']`.
 * Modifier requirements are exact: a binding on `['z']` does NOT fire on
 * Ctrl+Z, because that would shadow the undo binding. Conversely a binding on
 * `['Mod','z']` requires at least one of Ctrl/Meta and nothing more.
 *
 * `allowInInput` opts a binding into firing while someone is typing — only
 * Escape ever sets it, and only because it must also dismiss a dialog.
 */
export function matchesEvent(event, keys, { allowInInput = false } = {}) {
  if (!event || !Array.isArray(keys) || keys.length === 0) return false;
  if (!allowInInput && isTypingTarget(event.target)) return false;

  const wanted = keys.map((k) => (isModifier(k) ? k : String(k).toLowerCase()));
  const wantKey = wanted.find((k) => !isModifier(k));
  const wantMods = wanted.filter(isModifier);

  // Every modifier the binding names must be physically down…
  for (const m of wantMods) {
    if (!MODS[m](event)) return false;
  }
  // …and no *extra* modifier may be down. `mod` is satisfied by either Ctrl
  // or Meta, so pressing both is still not "extra".
  for (const m of ['ctrl', 'meta', 'shift', 'alt']) {
    const named = wantMods.includes(m) || (wantMods.includes('mod') && m !== 'shift' && m !== 'alt');
    if (MODS[m](event) && !named) return false;
  }

  if (!wantKey) return true; // a pure modifier chord
  return keyToken(event) === wantKey;
}

/** `['Mod','z']` → `"Ctrl+Z"`, `['Shift','?']` → `"Shift+?"`. */
export function formatKeys(keys) {
  if (!Array.isArray(keys)) return '';
  return keys
    .map((k) => {
      if (isModifier(k)) return KEY_ALIASES[k] ?? k;
      return KEY_ALIASES[k] ?? String(k);
    })
    .join('+');
}

/* --- the table --------------------------------------------------------------
   Order within a group is the order the help sheet shows. `id` is unique and
   is what Toolbar looks up when it wants a hint badge.
   -------------------------------------------------------------------------- */

const TOOL_KEY_BY_TOOL = {
  select: 'v',
  hand: 'h',
  pen: 'p',
  rect: 'r',
  ellipse: 'o',
  diamond: 'd',
  cylinder: 'c',
  sticky: 's',
  text: 't',
  arrow: 'a',
  line: 'l',
  eraser: 'e',
};

const TOOL_LABEL = {
  select: 'Select',
  hand: 'Pan',
  pen: 'Pen',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  diamond: 'Diamond',
  cylinder: 'Database',
  sticky: 'Sticky note',
  text: 'Text',
  arrow: 'Arrow',
  line: 'Line',
  eraser: 'Eraser',
};

/** Digit shortcuts, in TOOLS order: 1 → select … 9 → eraser. */
const TOOL_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

const toolDigitBindings = TOOLS.map((tool, i) => ({
  id: `tool.${tool}.digit`,
  keys: [TOOL_DIGITS[i]],
  label: TOOL_LABEL[tool],
  group: 'Tools',
  allowInInput: false,
  handler: ({ store }) => store.setTool(tool),
}));

const toolLetterBindings = TOOLS.map((tool) => ({
  id: `tool.${tool}.letter`,
  keys: [TOOL_KEY_BY_TOOL[tool]],
  label: `${TOOL_LABEL[tool]} tool`,
  group: 'Tools',
  allowInInput: false,
  handler: ({ store }) => store.setTool(tool),
}));

export const SHORTCUTS = [
  /* --- Tools ------------------------------------------------------------- */
  ...toolDigitBindings,
  ...toolLetterBindings,
  {
    id: 'tool.select.escape',
    keys: ['Escape'],
    label: 'Back to select / close dialogs',
    group: 'Tools',
    allowInInput: true,
    handler: ({ store, ui }) => {
      // Escape is overloaded: it dismisses the topmost dialog, and only
      // reaches the canvas when nothing is open.
      if (ui.closeTopOverlay()) return;
      store.setTool('select');
    },
  },
  {
    id: 'view.pan.space',
    keys: ['Space'],
    label: 'Pan (hold)',
    group: 'Tools',
    allowInInput: false,
    hold: true,
    handler: () => {},
  },
  {
    id: 'view.pan.middle',
    keys: ['middle'],
    label: 'Pan (middle-drag)',
    group: 'Tools',
    allowInInput: false,
    hold: true,
    handler: () => {},
  },
  {
    id: 'tool.select.digitZero',
    keys: ['0'],
    label: 'Select tool',
    group: 'Tools',
    allowInInput: false,
    handler: ({ store }) => store.setTool('select'),
  },

  /* --- Editing ----------------------------------------------------------- */
  {
    id: 'edit.undo',
    keys: ['Mod', 'z'],
    label: 'Undo',
    group: 'Editing',
    handler: ({ store }) => store.undo(),
  },
  {
    id: 'edit.redo',
    keys: ['Mod', 'Shift', 'z'],
    label: 'Redo',
    group: 'Editing',
    handler: ({ store }) => store.redo(),
  },
  {
    id: 'edit.redo.y',
    keys: ['Mod', 'y'],
    label: 'Redo (Ctrl+Y)',
    group: 'Editing',
    handler: ({ store }) => store.redo(),
  },
  {
    id: 'edit.selectAll',
    keys: ['Mod', 'a'],
    label: 'Select all',
    group: 'Editing',
    handler: ({ store }) => store.select(store.getState().elements.map((e) => e.id)),
  },
  {
    id: 'edit.delete',
    keys: ['Delete'],
    label: 'Delete selection',
    group: 'Editing',
    // This is the SINGLE owner of Delete. React Flow's own `deleteKeyCode`
    // is set to null on the flow layer, and the canvas no longer binds a
    // keydown handler for it — two handlers racing on one keystroke is what
    // made deletion unreliable before.
    //
    // `commit` FIRST, per the store's rule: a mutation without a preceding
    // commit still deletes the elements but leaves nothing on the undo stack,
    // so the delete could not be taken back.
    handler: ({ store }) => {
      const ids = [...store.getState().selection];
      if (ids.length) {
        store.commit('delete');
        store.removeElements(ids);
      }
      // Clear the selection either way. `removeElements` prunes it, but a
      // Delete on an empty selection still has to drop a stale one, and
      // leaving a selection behind after the elements are gone means the next
      // Delete acts on nothing.
      store.clearSelection();
    },
  },
  {
    id: 'edit.duplicate',
    keys: ['Mod', 'd'],
    label: 'Duplicate selection',
    group: 'Editing',
    handler: ({ ui }) => ui.duplicateSelection(),
  },
  {
    id: 'edit.copy',
    keys: ['Mod', 'c'],
    label: 'Copy selection',
    group: 'Editing',
    handler: ({ ui }) => ui.copySelection(),
  },
  {
    id: 'edit.cut',
    keys: ['Mod', 'x'],
    label: 'Cut selection',
    group: 'Editing',
    handler: ({ ui }) => ui.cutSelection(),
  },
  {
    id: 'edit.paste',
    keys: ['Mod', 'v'],
    label: 'Paste',
    group: 'Editing',
    handler: ({ ui }) => ui.pasteClipboard(),
  },

  /* --- View -------------------------------------------------------------- */
  {
    id: 'view.zoomReset',
    keys: ['Mod', '0'],
    label: 'Reset zoom to 100%',
    group: 'View',
    handler: ({ store }) => store.resetView(),
  },
  {
    id: 'view.zoomFit',
    keys: ['Mod', '1'],
    label: 'Zoom to fit content',
    group: 'View',
    handler: ({ store }) => store.fitToContent(),
  },
  {
    id: 'view.zoomIn',
    keys: ['+', '='],
    label: 'Zoom in',
    group: 'View',
    handler: ({ ui }) => ui.zoomStep(1),
  },
  {
    id: 'view.zoomOut',
    keys: ['-', '_'],
    label: 'Zoom out',
    group: 'View',
    handler: ({ ui }) => ui.zoomStep(-1),
  },
  {
    id: 'view.grid',
    keys: ['g'],
    label: 'Toggle grid',
    group: 'View',
    handler: ({ store }) => {
      const { gridSize } = store.getState();
      store.setGridSize(gridSize > 0 ? 0 : 20);
    },
  },
  {
    id: 'view.snap',
    keys: ['k'],
    label: 'Toggle snapping',
    group: 'View',
    handler: ({ store }) => store.toggleSnap(),
  },
  {
    id: 'view.help',
    keys: ['?'],
    label: 'This shortcut sheet',
    group: 'View',
    handler: ({ ui }) => ui.toggleHelp(),
  },

  /* --- Board ------------------------------------------------------------- */
  {
    id: 'board.share',
    keys: ['Mod', 'Shift', 'l'],
    label: 'Copy share link',
    group: 'Board',
    handler: ({ ui }) => ui.copyShareLink(),
  },
  {
    id: 'board.export',
    keys: ['Mod', 'Shift', 'e'],
    label: 'Export / import',
    group: 'Board',
    handler: ({ ui }) => ui.toggleExport(),
  },
  {
    id: 'board.boards',
    keys: ['Mod', 'Shift', 'b'],
    label: 'All boards',
    group: 'Board',
    handler: ({ ui }) => ui.goToBoardList(),
  },
  {
    id: 'board.theme',
    keys: ['Mod', 'Shift', 'd'],
    label: 'Toggle dark mode',
    group: 'Board',
    handler: ({ ui }) => ui.toggleTheme(),
  },
];

/* --- lookups used by the Toolbar's hint badges ---------------------------- */

/** The primary (single) binding to advertise for a tool: its letter key. */
export function hintForTool(tool) {
  const binding = SHORTCUTS.find((s) => s.id === `tool.${tool}.letter`);
  return binding ? binding.keys[0] : '';
}

/** The digit for a tool, if it has one. */
export function digitForTool(tool) {
  const i = TOOLS.indexOf(tool);
  return i >= 0 && i < TOOL_DIGITS.length ? TOOL_DIGITS[i] : '';
}

export const TOOL_LABELS = TOOL_LABEL;

/** Ordered group names for the help sheet. */
export const SHORTCUT_GROUPS = ['Tools', 'Editing', 'View', 'Board'];

/** Bindings grouped for rendering, dropping the hold-only pseudo bindings. */
export function groupedShortcuts() {
  return SHORTCUT_GROUPS.map((group) => ({
    group,
    items: SHORTCUTS.filter((s) => s.group === group && !s.hold),
  })).filter((g) => g.items.length > 0);
}

/**
 * Run the first binding that matches. Returns the binding's id, or null.
 * A handler that throws is swallowed: one broken shortcut must not take down
 * the whole keyboard listener for every other binding.
 */
export function runShortcut(event, ctx) {
  for (const s of SHORTCUTS) {
    if (s.hold) continue;
    if (!matchesEvent(event, s.keys, { allowInInput: s.allowInInput })) continue;
    try {
      s.handler({ ...ctx, event });
    } catch {
      return s.id;
    }
    return s.id;
  }
  return null;
}
