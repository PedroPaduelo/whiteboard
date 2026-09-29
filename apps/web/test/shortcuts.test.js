/**
 * shortcuts.test.js — the keyboard table and matcher, in node.
 *
 * Events are plain objects shaped like KeyboardEvent (key, code, modifier
 * flags, target), which is all `matchesEvent`/`runShortcut` read.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHORTCUTS,
  SHORTCUT_BY_ID,
  matchesEvent,
  matchesChord,
  runShortcut,
  groupedShortcuts,
  formatChord,
  toolChords,
  isTypingTarget,
} from '../src/ui/shortcuts.js';
import { TOOLBAR } from '../src/editor/tools.js';
import { useBoardStore } from '../src/store/boardStore.js';
import { createElement } from '../src/editor/elements.js';
import { DEFAULT_STYLE, NUDGE, NUDGE_SHIFT } from '../src/editor/constants.js';

const S = () => useBoardStore.getState();

/** A KeyboardEvent-like object. */
function key(k, code, mods = {}) {
  let prevented = false;
  return {
    key: k,
    code,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    target: { tagName: 'BODY' },
    preventDefault() {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
    ...mods,
  };
}
const letter = (ch, mods) => key(ch, `Key${ch.toUpperCase()}`, mods);
const digit = (d, mods) => key(d, `Digit${d}`, mods);

/** The ctx the App passes: the live store handle, a fake ui. */
function ctx(uiOverrides = {}) {
  const calls = [];
  const ui = {
    calls,
    closeTopOverlay: () => false,
    toggleTheme: () => calls.push('theme'),
    toggle: (k) => calls.push(`toggle:${k}`),
    openFile: () => calls.push('openFile'),
    ...uiOverrides,
  };
  const store = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'getState') return useBoardStore.getState;
        const v = useBoardStore.getState()[prop];
        return typeof v === 'function' ? v.bind(useBoardStore.getState()) : v;
      },
    },
  );
  return { store, ui };
}

beforeEach(() => {
  S().reset();
  S().setViewportSize({ w: 1000, h: 800 });
  const a = createElement('rect', { x: 0, y: 0, w: 100, h: 60 }, DEFAULT_STYLE, { id: 'a' });
  const b = createElement('rect', { x: 200, y: 0, w: 100, h: 60 }, DEFAULT_STYLE, { id: 'b' });
  S().setSnapshot({ board: { id: 'b1' }, elements: [a, b], rev: 1 });
});

/* --- table integrity ---------------------------------------------------- */

test('every binding has a unique id, a group, a label, keys and a handler', () => {
  const seen = new Set();
  for (const s of SHORTCUTS) {
    assert.ok(s.id && !seen.has(s.id), `unique id ${s.id}`);
    seen.add(s.id);
    assert.ok(['tools', 'edit', 'view', 'board'].includes(s.group), `${s.id} group`);
    assert.equal(typeof s.label, 'string');
    assert.ok(s.label.length > 0 && !s.label.includes('undefined'), `${s.id} label`);
    assert.ok(Array.isArray(s.keys) && s.keys.length > 0, `${s.id} keys`);
    for (const k of s.keys) assert.ok(typeof k === 'string' && k.length > 0 && !k.includes('undefined'), `${s.id} chord ${k}`);
    assert.equal(typeof s.handler, 'function');
  }
  assert.ok(SHORTCUT_BY_ID['edit.delete']);
});

test('no two runnable bindings share a chord', () => {
  const owner = new Map();
  for (const s of SHORTCUTS) {
    if (s.hold) continue;
    for (const k of s.keys) {
      assert.ok(!owner.has(k), `${k} bound twice (${owner.get(k)} and ${s.id})`);
      owner.set(k, s.id);
    }
  }
});

test('the help dialog groups list every binding with formatted key caps (no "undefined")', () => {
  const groups = groupedShortcuts();
  assert.deepEqual(groups.map((g) => g.group), ['tools', 'edit', 'view', 'board']);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, SHORTCUTS.length);
  for (const g of groups) {
    assert.ok(g.title);
    for (const item of g.items) {
      assert.ok(item.chords.length > 0);
      for (const caps of item.chords) for (const cap of caps) assert.ok(cap && cap !== 'undefined', `${item.id}: ${cap}`);
    }
  }
  assert.deepEqual(formatChord('Mod+Shift+Z').slice(1), ['Shift', 'Z']);
});

/* --- tools from TOOLBAR ------------------------------------------------ */

test('each TOOLBAR tool is bound to exactly its letter and digit', () => {
  for (const tool of TOOLBAR) {
    const b = SHORTCUT_BY_ID[`tool.${tool.id}`];
    assert.ok(b, `binding for ${tool.id}`);
    assert.deepEqual(b.keys, toolChords(tool));
    if (tool.key) assert.ok(b.keys.includes(tool.key.toUpperCase()));
    if (tool.digit) assert.ok(b.keys.includes(tool.digit));
  }
});

test('digits and letters select the TOOLBAR tool (digit 2 = rect, R = rect, 0 = eraser)', () => {
  for (const tool of TOOLBAR) {
    if (tool.id === 'image') continue; // opens a file picker (needs a DOM)
    if (tool.digit) {
      S().setTool('select');
      assert.equal(runShortcut(digit(tool.digit), ctx()), `tool.${tool.id}`);
      assert.equal(S().tool, tool.id, `digit ${tool.digit}`);
    }
    if (tool.key) {
      S().setTool('select');
      assert.equal(runShortcut(letter(tool.key), ctx()), `tool.${tool.id}`);
      assert.equal(S().tool, tool.id, `letter ${tool.key}`);
    }
  }
});

test('Q toggles the tool lock', () => {
  assert.equal(S().toolLocked, false);
  runShortcut(letter('q'), ctx());
  assert.equal(S().toolLocked, true);
  runShortcut(letter('q'), ctx());
  assert.equal(S().toolLocked, false);
});

/* --- matching ------------------------------------------------------------ */

test('letters match via event.code on non-Latin layouts', () => {
  // Russian layout: the physical R key types "к".
  assert.equal(matchesChord(key('к', 'KeyR'), 'R'), true);
  assert.equal(matchesChord(key('к', 'KeyR'), 'D'), false);
  // Ctrl+Z on a Greek layout.
  assert.equal(matchesChord(key('ζ', 'KeyZ', { ctrlKey: true }), 'Mod+Z'), true);
  // macOS Option mangles the key: ⌥⇧D reports "Î".
  assert.equal(matchesChord(key('Î', 'KeyD', { altKey: true, shiftKey: true }), 'Alt+Shift+D'), true);
  // An event with only a code still matches.
  assert.equal(matchesChord({ code: 'KeyV' }, 'V'), true);
});

test('Latin letters follow event.key (AZERTY "a" is A even on the Q key)', () => {
  assert.equal(matchesChord(key('a', 'KeyQ'), 'A'), true);
  assert.equal(matchesChord(key('a', 'KeyQ'), 'Q'), false);
});

test('modifiers are exact: Ctrl+Z is not Z, Ctrl+Shift+Z is not Ctrl+Z', () => {
  assert.equal(matchesChord(letter('z', { ctrlKey: true }), 'Z'), false);
  assert.equal(matchesChord(letter('z', { ctrlKey: true, shiftKey: true }), 'Mod+Z'), false);
  assert.equal(matchesChord(letter('Z', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+Z'), true);
  assert.equal(matchesChord(letter('z', { metaKey: true }), 'Mod+Z'), true, '⌘ counts as Mod');
  assert.equal(matchesChord(letter('r', { shiftKey: true }), 'R'), false);
  assert.equal(matchesEvent(letter('y', { ctrlKey: true }), ['Mod+Shift+Z', 'Mod+Y']), true);
});

test('digits match by code, so Shift+1 (= "!") and AZERTY digits work', () => {
  assert.equal(matchesChord(key('!', 'Digit1', { shiftKey: true }), 'Shift+1'), true);
  assert.equal(matchesChord(key('!', 'Digit1', { shiftKey: true }), '1'), false);
  assert.equal(matchesChord(key('&', 'Digit1'), '1'), true, 'AZERTY unshifted digit row');
  assert.equal(matchesChord(key('0', 'Numpad0', { ctrlKey: true }), 'Mod+0'), true);
});

test('"?" matches with or without Shift; brackets respect Shift', () => {
  assert.equal(matchesChord(key('?', 'Slash', { shiftKey: true }), '?'), true);
  assert.equal(matchesChord(key('?', 'IntlRo'), '?'), true);
  assert.equal(matchesChord(key(']', 'BracketRight', { ctrlKey: true }), 'Mod+]'), true);
  assert.equal(matchesChord(key('}', 'BracketRight', { ctrlKey: true, shiftKey: true }), 'Mod+]'), false);
  assert.equal(matchesChord(key('}', 'BracketRight', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+]'), true);
  assert.equal(matchesChord(key('+', 'Equal', { ctrlKey: true, shiftKey: true }), 'Mod+='), true);
  assert.equal(matchesChord(key('=', 'Equal', { ctrlKey: true }), 'Mod+='), true);
  assert.equal(matchesChord(key('-', 'NumpadSubtract', { ctrlKey: true }), 'Mod+-'), true);
});

/* --- behaviour ---------------------------------------------------------- */

test("'?' with Shift opens help", () => {
  const c = ctx();
  const ev = key('?', 'Slash', { shiftKey: true });
  assert.equal(runShortcut(ev, c), 'view.help');
  assert.deepEqual(c.ui.calls, ['toggle:helpOpen']);
});

test("with a modal open only Escape and the help toggle run: '?' closes the help sheet it opened", () => {
  const open = new Set(['helpOpen']);
  const c = ctx({ isOpen: (k) => open.has(k), toggle: (k) => (open.has(k) ? open.delete(k) : open.add(k)) });
  S().select(['a']);
  const ev = key('?', 'Slash', { shiftKey: true });
  assert.equal(runShortcut(ev, c, { modal: true }), 'view.help');
  assert.equal(open.has('helpOpen'), false, 'help closed by its own key');
  // Another modal (export) is open: '?' does not stack help on top of it.
  open.add('exportOpen');
  assert.equal(runShortcut(ev, c, { modal: true }), null);
  assert.equal(open.has('helpOpen'), false);
  // Every other key belongs to the dialog: no board shortcut behind it.
  assert.equal(runShortcut(key('Delete', 'Delete'), c, { modal: true }), null);
  assert.equal(runShortcut(letter('r'), c, { modal: true }), null);
  assert.equal(S().elements.length, 2);
  assert.equal(S().tool, 'select');
  // Escape still closes the modal.
  let closed = false;
  const c2 = ctx({ closeTopOverlay: () => (closed = true) });
  assert.equal(runShortcut(key('Escape', 'Escape'), c2, { modal: true }), 'edit.escape');
  assert.equal(closed, true);
  // '?' typed into a dialog field is text, not a shortcut.
  const typed = key('?', 'Slash', { shiftKey: true, target: { tagName: 'INPUT', type: 'text' } });
  open.add('helpOpen');
  assert.equal(runShortcut(typed, c, { modal: true }), null);
});

test('Backspace deletes the selection, as Delete does', () => {
  S().select(['a']);
  assert.equal(runShortcut(key('Backspace', 'Backspace'), ctx()), 'edit.delete');
  assert.deepEqual(S().elements.map((el) => el.id), ['b']);
  assert.equal(S().selection.size, 0);
  S().undo();
  assert.equal(S().elements.length, 2, 'undoable');
  S().select(['b']);
  assert.equal(runShortcut(key('Delete', 'Delete'), ctx()), 'edit.delete');
  assert.deepEqual(S().elements.map((el) => el.id), ['a']);
});

test('legacy contract: edit.delete calls commit("delete:<unique>") -> removeElements(ids) -> clearSelection()', () => {
  const entry = SHORTCUTS.find((c) => c.id === 'edit.delete');
  const calls = [];
  entry.handler({
    store: {
      getState: () => ({ selection: new Set(['a', 'b']) }),
      commit: (label) => calls.push(['commit', label]),
      removeElements: (ids) => calls.push(['removeElements', ids]),
      clearSelection: () => calls.push(['clearSelection']),
    },
  });
  assert.deepEqual(calls.map((c) => c[0]), ['commit', 'removeElements', 'clearSelection']);
  // A unique label per delete: two quick deletes stay two undo steps.
  assert.match(calls[0][1], /^delete:/);
  assert.deepEqual(calls[1][1], ['a', 'b']);

  const calls2 = [];
  entry.handler({
    store: {
      getState: () => ({ selection: new Set() }),
      commit: () => calls2.push('commit'),
      removeElements: () => calls2.push('remove'),
      clearSelection: () => calls2.push('clear'),
    },
  });
  assert.deepEqual(calls2, ['clear'], 'empty selection: no commit, no remove, still cleared');
});

test('arrows nudge the selection (Shift = 10x) and are not handled without one', () => {
  S().select(['a']);
  assert.equal(runShortcut(key('ArrowRight', 'ArrowRight'), ctx()), 'edit.nudge');
  assert.equal(S().elements[0].x, NUDGE);
  runShortcut(key('ArrowDown', 'ArrowDown', { shiftKey: true }), ctx());
  assert.equal(S().elements[0].y, NUDGE_SHIFT);
  S().clearSelection();
  const ev = key('ArrowLeft', 'ArrowLeft');
  assert.equal(runShortcut(ev, ctx()), null, 'nothing selected: not handled, so no preventDefault');
});

test('in grid mode an arrow moves one grid cell and Shift+arrow one unit, so a snapped element stays snapped', () => {
  S().toggleSnap();
  const grid = S().gridSize;
  assert.ok(grid > 1);
  S().select(['a']);
  runShortcut(key('ArrowRight', 'ArrowRight'), ctx());
  assert.equal(S().elements[0].x, grid);
  runShortcut(key('ArrowDown', 'ArrowDown', { shiftKey: true }), ctx());
  assert.equal(S().elements[0].y, NUDGE);
});

test('Ctrl+C / Ctrl+X / Ctrl+V are left to the native clipboard events', () => {
  S().select(['a']);
  for (const ch of ['c', 'x', 'v']) {
    assert.equal(runShortcut(letter(ch, { ctrlKey: true }), ctx()), null, `Ctrl+${ch} not consumed`);
  }
  assert.equal(S().elements.length, 2);
  assert.ok(SHORTCUT_BY_ID['edit.copy'].native);
});

test('Ctrl+D duplicates, Ctrl+A selects all, Ctrl+Z / Ctrl+Y undo and redo', () => {
  S().select(['a']);
  assert.equal(runShortcut(letter('d', { ctrlKey: true }), ctx()), 'edit.duplicate');
  assert.equal(S().elements.length, 3);
  runShortcut(letter('z', { ctrlKey: true }), ctx());
  assert.equal(S().elements.length, 2);
  runShortcut(letter('y', { ctrlKey: true }), ctx());
  assert.equal(S().elements.length, 3);
  runShortcut(letter('a', { ctrlKey: true }), ctx());
  assert.equal(S().selection.size, 3);
});

test('Ctrl+G groups, Ctrl+Shift+G ungroups, Ctrl+Shift+L locks', () => {
  S().select(['a', 'b']);
  runShortcut(letter('g', { ctrlKey: true }), ctx());
  assert.ok(S().elements[0].groupId);
  runShortcut(letter('G', { ctrlKey: true, shiftKey: true }), ctx());
  assert.equal(S().elements[0].groupId, undefined);
  runShortcut(letter('L', { ctrlKey: true, shiftKey: true }), ctx());
  assert.equal(S().elements[0].locked, true);
});

test('Escape: overlay first, then selection, then back to the select tool', () => {
  let open = true;
  const c = ctx({ closeTopOverlay: () => (open ? ((open = false), true) : false) });
  S().select(['a']);
  S().setTool('select');
  assert.equal(runShortcut(key('Escape', 'Escape'), c), 'edit.escape');
  assert.equal(S().selection.size, 1, 'first Escape only closed the overlay');
  runShortcut(key('Escape', 'Escape'), c);
  assert.equal(S().selection.size, 0);
  S().setTool('rect');
  runShortcut(key('Escape', 'Escape'), c);
  assert.equal(S().tool, 'select');
  assert.equal(runShortcut(key('Escape', 'Escape'), c), null, 'nothing left to do: not handled');
});

test('view shortcuts: Ctrl+= / Ctrl+- / Ctrl+0 / Shift+1', () => {
  runShortcut(key('=', 'Equal', { ctrlKey: true }), ctx());
  assert.ok(S().view.zoom > 1);
  runShortcut(key('0', 'Digit0', { ctrlKey: true }), ctx());
  assert.equal(S().view.zoom, 1);
  runShortcut(key('-', 'Minus', { ctrlKey: true }), ctx());
  assert.ok(S().view.zoom < 1);
  assert.equal(runShortcut(key('!', 'Digit1', { shiftKey: true }), ctx()), 'view.zoomFit');
  assert.ok(S().view.zoom <= 1);
});

test("Ctrl+' toggles the grid; Alt+Shift+D the theme; Ctrl+Shift+E export", () => {
  const c = ctx();
  runShortcut(key("'", 'Quote', { ctrlKey: true }), c);
  assert.equal(S().snapEnabled, true);
  runShortcut(key('D', 'KeyD', { altKey: true, shiftKey: true }), c);
  runShortcut(key('E', 'KeyE', { ctrlKey: true, shiftKey: true }), c);
  assert.deepEqual(c.ui.calls, ['theme', 'toggle:exportOpen']);
});

test('keys typed into a field are ignored (except Escape for overlays)', () => {
  S().select(['a']);
  const ev = key('Backspace', 'Backspace', { target: { tagName: 'INPUT', type: 'text' } });
  assert.equal(runShortcut(ev, ctx()), null);
  assert.equal(S().elements.length, 2);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'range' }), false);
  // Escape in a field with an overlay open closes the overlay…
  let closed = false;
  const esc = key('Escape', 'Escape', { target: { tagName: 'INPUT', type: 'text' } });
  assert.equal(runShortcut(esc, ctx({ closeTopOverlay: () => (closed = true) })), 'edit.escape');
  assert.equal(closed, true);
  // …but without one it belongs to the field (the selection survives).
  assert.equal(runShortcut(esc, ctx()), null);
  assert.equal(S().selection.size, 1);
});

test('Enter on a focused button is left to the button', () => {
  const t = createElement('text', { x: 0, y: 0, text: 'x' }, DEFAULT_STYLE, { id: 't1' });
  S().addElements([t]);
  S().select(['t1']);
  assert.equal(runShortcut(key('Enter', 'Enter', { target: { tagName: 'BUTTON' } }), ctx()), null);
  assert.equal(S().editingId, null);
  assert.equal(runShortcut(key('Enter', 'Enter'), ctx()), 'edit.enter');
  assert.equal(S().editingId, 't1');
});

test('auto-repeat does not re-fire toggles', () => {
  const c = ctx();
  runShortcut(key('?', 'Slash', { shiftKey: true, repeat: true }), c);
  assert.deepEqual(c.ui.calls, []);
});

test('runShortcut reports a throwing handler, rethrows in dev, and never claims it handled the key', () => {
  const entry = SHORTCUT_BY_ID['view.theme'];
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const c = ctx({
      toggleTheme: () => {
        throw new Error('boom');
      },
    });
    const ev = key('D', 'KeyD', { altKey: true, shiftKey: true });
    assert.equal(runShortcut(ev, c, { dev: false }), null, 'not handled -> caller will not preventDefault');
    assert.equal(errors.length, 1, 'reported, not swallowed');
    assert.throws(() => runShortcut(ev, c, { dev: true }), /boom/);
  } finally {
    console.error = origError;
  }
  assert.ok(entry);
});

test('an unbound key is not handled', () => {
  assert.equal(runShortcut(letter('j'), ctx()), null);
  assert.equal(runShortcut(key('F5', 'F5'), ctx()), null);
});
