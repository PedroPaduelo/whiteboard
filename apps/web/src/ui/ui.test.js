/**
 * ui.test.js — the UI's plain-function modules, in node: board duplication and
 * list paging (boardOps.js), routing and history (routing.js), the title field
 * (titleEdit.js), the colour hex field (colorHex.js), the modal clipboard
 * guard (modal.js), error messages (errors.js), the hint line (hints.js), the
 * dialog focus trap (focusTrap.js), the per-board view memory (viewMemory.js)
 * and the board theme default (theme.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from '../editor/elements.js';
import { DEFAULT_STYLE } from '../editor/constants.js';
import {
  BOARD_PAGE_SIZE,
  boardListQuery,
  chunkOps,
  copyBoardElements,
  duplicateOps,
  mergeBoardPages,
  nextPageOffset,
  pageTotal,
} from './boardOps.js';
import { boardUrl, navigateTo, planNavigation, resolveBoardId } from './routing.js';
import { titleToSave } from './titleEdit.js';
import { hexFieldValue, hexToApply, normalizeHex } from './colorHex.js';
import { MODAL_KEYS, installModalClipboardGuard, isModalOpen } from './modal.js';
import { errorMessage, errorReason, errorSentence } from './errors.js';
import { gestureHintOf, hintFor, selectionKindOf } from './hints.js';
import { PREVIEW_MAX_ELEMENTS, previewKind, previewQueryKey, previewSrc } from './boardPreview.js';
import { trapTabTarget } from './focusTrap.js';
import { MAX_VIEWS, VIEWS_KEY, loadView, sanitizeView, saveView } from './viewMemory.js';
import { boardDefaultTheme } from './theme.js';
import { useUi } from './uiStore.js';
import { t } from './strings.js';

/* --- duplication -------------------------------------------------------------- */

function sourceBoard() {
  const r = createElement('rect', { x: 0, y: 0, w: 100, h: 60 }, DEFAULT_STYLE, { id: 'r1', locked: true });
  const e = createElement('ellipse', { x: 300, y: 0, w: 100, h: 60 }, DEFAULT_STYLE, { id: 'e1' });
  const a = createElement('arrow', { points: [{ x: 100, y: 30 }, { x: 300, y: 30 }] }, DEFAULT_STYLE, { id: 'a1', startId: 'r1', endId: 'e1' });
  return [r, e, a];
}

test('duplicateOps: fresh ids, remapped bindings, target board id, locked kept', () => {
  const src = sourceBoard();
  let n = 0;
  const ops = duplicateOps(src, 'copy', { now: 5, makeOpId: () => `op${(n += 1)}` });
  assert.equal(ops.length, 3);
  for (const op of ops) {
    assert.equal(op.kind, 'create');
    assert.equal(op.boardId, 'copy');
    assert.equal(op.at, 5);
    assert.ok(!['r1', 'e1', 'a1'].includes(op.element.id), 'fresh ids');
  }
  const [r, e, a] = ops.map((op) => op.element);
  assert.equal(a.startId, r.id);
  assert.equal(a.endId, e.id);
  assert.equal(r.locked, true);
  assert.deepEqual(duplicateOps([], 'copy'), []);
  assert.deepEqual(duplicateOps(src, ''), []);
});

test('copyBoardElements: reads the SOURCE and posts every op to the COPY (never the source)', async () => {
  const src = sourceBoard();
  const calls = [];
  const http = {
    get: async (path) => {
      calls.push(['GET', path]);
      return { board: { id: 'src' }, elements: src, rev: 3 };
    },
    post: async (path, body) => {
      calls.push(['POST', path, body.ops.length]);
      assert.ok(body.ops.every((op) => op.boardId === 'copy'));
      return { status: 'applied' };
    },
  };
  const res = await copyBoardElements('src', 'copy', { http });
  assert.deepEqual(res, { ok: true, count: 3, copied: 3 });
  assert.deepEqual(calls, [
    ['GET', '/boards/src'],
    ['POST', '/boards/copy/ops', 3],
  ]);
  assert.ok(!calls.some(([m, p]) => m === 'POST' && p.includes('/boards/src/')), 'nothing is written to the source');
});

test('copyBoardElements: a refused batch resolves ok:false with what was copied; same ids are refused', async () => {
  const many = Array.from({ length: 160 }, (_, i) => createElement('rect', { x: i * 10, y: 0, w: 5, h: 5 }, DEFAULT_STYLE, { id: `r${i}` }));
  let posts = 0;
  const http = {
    get: async () => ({ elements: many }),
    post: async () => {
      posts += 1;
      if (posts === 2) throw new Error('boom');
      return { status: 'applied' };
    },
  };
  const res = await copyBoardElements('a', 'b', { http });
  assert.equal(res.ok, false);
  assert.equal(res.count, 160);
  assert.equal(res.copied, 150);
  assert.equal((await copyBoardElements('a', 'a', { http })).ok, false);
});

test('chunkOps: bounded by count and by bytes; an oversized op goes alone', () => {
  const ops = Array.from({ length: 7 }, (_, i) => ({ opId: `o${i}`, pad: 'x'.repeat(i === 3 ? 500 : 10) }));
  assert.deepEqual(
    chunkOps(ops, { maxOps: 3, maxBytes: 10_000 }).map((b) => b.length),
    [3, 3, 1],
  );
  const bySize = chunkOps(ops, { maxOps: 100, maxBytes: 200 });
  assert.ok(bySize.length > 1);
  assert.ok(bySize.some((b) => b.length === 1 && b[0].opId === 'o3'));
  assert.equal(bySize.flat().length, 7);
  assert.deepEqual(chunkOps([]), []);
});

/* --- the paged list ------------------------------------------------------------ */

test('board list paging: offsets, end of list, de-duplication, totals', () => {
  const rows = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `b${from + i}` }));
  const p1 = { boards: rows(0, 50), total: 120 };
  const p2 = { boards: rows(50, 50), total: 120 };
  const p3 = { boards: rows(100, 20), total: 120 };
  assert.equal(nextPageOffset(p1, [p1]), 50);
  assert.equal(nextPageOffset(p2, [p1, p2]), 100);
  assert.equal(nextPageOffset(p3, [p1, p2, p3]), undefined);
  assert.equal(nextPageOffset({ boards: [], total: 120 }, [p1, { boards: [] }]), undefined);
  // A server without `total`: a short page is the last one.
  assert.equal(nextPageOffset(rows(0, BOARD_PAGE_SIZE), [rows(0, BOARD_PAGE_SIZE)]), BOARD_PAGE_SIZE);
  assert.equal(nextPageOffset(rows(0, 3), [rows(0, 3)]), undefined);
  // A board created between two requests shifts one row onto the next page.
  const shifted = { boards: [{ id: 'b49' }, ...rows(50, 49)], total: 121 };
  const merged = mergeBoardPages([p1, shifted]);
  assert.equal(merged.length, 99);
  assert.equal(new Set(merged.map((b) => b.id)).size, 99);
  assert.equal(pageTotal(p1), 120);
  assert.equal(pageTotal([]), null);
});

test('boardListQuery: owner, trimmed search, limit and offset', () => {
  assert.equal(boardListQuery({ owner: 'Ana', offset: 50 }), '/boards?owner=Ana&limit=50&offset=50');
  assert.equal(boardListQuery({ owner: 'Ana', search: '  sprint ', offset: 0 }), '/boards?owner=Ana&search=sprint&limit=50&offset=0');
  assert.equal(boardListQuery({ owner: 'Ana Maria', search: '   ' }), '/boards?owner=Ana+Maria&limit=50&offset=0');
});

/* --- routing ----------------------------------------------------------------------- */

test('resolveBoardId: query, /b/<id>, bare id; the list for /, /b and files', () => {
  assert.equal(resolveBoardId('/b/abc?board=abc'), 'abc');
  assert.equal(resolveBoardId('/?board=xyz'), 'xyz');
  assert.equal(resolveBoardId('/b/abc'), 'abc');
  assert.equal(resolveBoardId('/b/abc/'), 'abc');
  assert.equal(resolveBoardId('/abc'), 'abc');
  assert.equal(resolveBoardId('/'), null);
  assert.equal(resolveBoardId('/b'), null);
  assert.equal(resolveBoardId('/b/'), null);
  assert.equal(resolveBoardId('/favicon.svg'), null);
  assert.equal(resolveBoardId('/api'), null);
  assert.equal(resolveBoardId('/b/%E0%A4%A'), '%E0%A4%A', 'a malformed escape does not throw');
  // Truncated or mangled links never throw (they used to, from App's state
  // initialiser and its popstate handler): the raw id reaches the server,
  // which does not know it, and the not-found screen shows.
  for (const [href, id] of [
    ['/b/abc%', 'abc%'],
    ['/b/%E0%A4', '%E0%A4'],
    ['/%ZZ', '%ZZ'],
    ['http://localhost:5173/b/abc%', 'abc%'],
  ]) {
    assert.doesNotThrow(() => resolveBoardId(href), href);
    assert.equal(resolveBoardId(href), id, href);
  }
  assert.equal(resolveBoardId('/b/caf%C3%A9'), 'café', 'a valid escape still decodes');
});

test('boardUrl keeps other query params', () => {
  assert.equal(boardUrl('abc', 'http://h/?x=1'), '/b/abc?x=1&board=abc');
  assert.equal(boardUrl(null, 'http://h/b/abc'), '/');
});

test('planNavigation: list <-> board pushes; same place replaces or does nothing', () => {
  assert.deepEqual(planNavigation('http://h/', 'abc'), { mode: 'push', url: '/b/abc?board=abc' });
  assert.deepEqual(planNavigation('http://h/b/abc?board=abc', null), { mode: 'push', url: '/' });
  assert.deepEqual(planNavigation('http://h/b/abc?board=abc', 'def'), { mode: 'push', url: '/b/def?board=def' });
  assert.deepEqual(planNavigation('http://h/b/abc', 'abc'), { mode: 'replace', url: '/b/abc?board=abc' });
  assert.deepEqual(planNavigation('http://h/b/abc?board=abc', 'abc'), { mode: 'none', url: '/b/abc?board=abc' });
  assert.deepEqual(planNavigation('http://h/', null), { mode: 'none', url: '/' });
});

test('navigateTo grows the history, so Back returns to the list', () => {
  const entries = ['/'];
  let index = 0;
  const win = {
    location: {
      origin: 'http://h',
      get href() {
        return `http://h${entries[index]}`;
      },
    },
    history: {
      pushState: (_s, _t, url) => {
        entries.splice(index + 1);
        entries.push(url);
        index += 1;
      },
      replaceState: (_s, _t, url) => {
        entries[index] = url;
      },
    },
  };
  navigateTo('abc', win); // open a board from the list
  navigateTo(null, win); // "Meus quadros"
  navigateTo('def', win); // another board
  assert.deepEqual(entries, ['/', '/b/abc?board=abc', '/', '/b/def?board=def']);
  navigateTo('def', win); // already there: no new entry
  assert.equal(entries.length, 4);
});

/* --- the title field -------------------------------------------------------------- */

test('titleToSave: an untouched field never saves, even after a remote rename', () => {
  // B opened the field on 'Título Original'; A renamed the board meanwhile.
  assert.equal(titleToSave('Título Original', 'Título Original', 'Renomeado por Alice'), null);
  assert.equal(titleToSave('  Título Original ', 'Título Original', 'Título Original'), null);
  assert.equal(titleToSave('Novo nome ', 'Título Original', 'Título Original'), 'Novo nome');
  assert.equal(titleToSave('Renomeado por Alice', 'Título Original', 'Renomeado por Alice'), null);
  assert.equal(titleToSave('   ', 'Título Original', 'Título Original'), null);
});

/* --- the hex field ------------------------------------------------------------------ */

test('colour hex field: follows the colour, applies only real edits', () => {
  assert.equal(normalizeHex('9C36B5'), '#9c36b5');
  assert.equal(normalizeHex('#1e1e1e'), '#1e1e1e');
  assert.equal(normalizeHex('12345'), null);
  assert.equal(hexFieldValue('#9C36B5'), '9c36b5');
  assert.equal(hexFieldValue('transparent'), '');
  assert.equal(hexFieldValue(null), '');
  // Focus + blur without typing: nothing, whatever the field shows.
  assert.equal(hexToApply('1e1e1e', false, '#9c36b5'), null);
  // Typed the colour already in use: nothing.
  assert.equal(hexToApply('9C36B5', true, '#9c36b5'), null);
  // A real edit applies, normalised.
  assert.equal(hexToApply('#E03131', true, '#9c36b5'), '#e03131');
  assert.equal(hexToApply('e0313', true, '#9c36b5'), null);
  // Mixed selection (no current colour): a typed colour applies.
  assert.equal(hexToApply('e03131', true, null), '#e03131');
});

/* --- modal guard ------------------------------------------------------------------ */

test('isModalOpen: help, export, a confirmation or the nickname dialog; not menus or panels', () => {
  assert.equal(isModalOpen({}), false);
  for (const k of MODAL_KEYS) assert.equal(isModalOpen({ [k]: k === 'confirm' ? { title: 'x' } : true }), true, k);
  assert.equal(isModalOpen({ menuOpen: true, libraryOpen: true, contextMenu: { x: 0, y: 0 }, propsOpen: true }), false);
});

test('modal clipboard guard: stops copy/cut/paste before the board sees them, only while a modal is open', () => {
  const target = new EventTarget();
  let modal = true;
  const uninstall = installModalClipboardGuard(target, () => modal);
  const seen = [];
  // Registered after the guard, like the canvas and App listeners.
  for (const type of ['copy', 'cut', 'paste']) target.addEventListener(type, () => seen.push(type), true);
  for (const type of ['copy', 'cut', 'paste']) target.dispatchEvent(new Event(type, { cancelable: true }));
  assert.deepEqual(seen, [], 'nothing reaches the board behind a modal');
  modal = false;
  target.dispatchEvent(new Event('cut', { cancelable: true }));
  assert.deepEqual(seen, ['cut'], 'no modal: the board gets it');
  uninstall();
  modal = true;
  target.dispatchEvent(new Event('paste', { cancelable: true }));
  assert.deepEqual(seen, ['cut', 'paste'], 'uninstalled');
});

test('modal clipboard guard: a paste into a field of the dialog is left alone (default and propagation)', () => {
  const handlers = [];
  installModalClipboardGuard({ addEventListener: (type, fn) => handlers.push(fn) }, () => true);
  let stopped = 0;
  const ev = (target) => ({ target, stopImmediatePropagation: () => (stopped += 1) });
  handlers[2](ev({ tagName: 'INPUT', type: 'text' }));
  assert.equal(stopped, 0);
  handlers[2](ev({ tagName: 'BUTTON' }));
  assert.equal(stopped, 1);
});

/* --- error messages --------------------------------------------------------------- */

test('errorMessage: Portuguese reasons by status, never the error’s own (English) text', () => {
  const network = Object.assign(new Error('Could not reach the API at /api. (Failed to fetch)'), { name: 'ApiError', status: 0 });
  const gone = Object.assign(new Error('board 613c not found'), { name: 'ApiError', status: 404 });
  const server = Object.assign(new Error('Internal Server Error'), { name: 'ApiError', status: 503 });
  const bad = Object.assign(new Error('body/title must be string'), { name: 'ApiError', status: 400 });
  const fail = 'Não foi possível renomear o quadro';
  assert.equal(errorMessage(network, fail), `${fail}: ${t.errors.reasons.network}.`);
  assert.equal(errorMessage(gone, fail), `${fail}: ${t.errors.reasons.boardGone}.`);
  assert.equal(errorMessage(server, fail), `${fail}: ${t.errors.reasons.server}.`);
  assert.equal(errorMessage(bad, fail), fail, 'nothing useful to add: just the fallback');
  assert.equal(errorMessage(undefined, fail), fail);
  assert.equal(errorReason(new TypeError('Failed to fetch')), t.errors.reasons.network);
  // Where a 404 cannot mean "the board is gone" (creating one), it says nothing more.
  assert.equal(errorMessage(gone, 'Não foi possível criar o quadro', { notFound: null }), 'Não foi possível criar o quadro');
  for (const e of [network, gone, server, bad]) assert.ok(!errorMessage(e, fail).includes(e.message));
  assert.equal(errorSentence(network), 'Sem conexão com o servidor.');
  assert.equal(errorSentence(bad), null);
});

/* --- hint line -------------------------------------------------------------------- */

test('hintFor: tools, locked tool, selection kinds, nothing while editing text', () => {
  assert.equal(hintFor({ tool: 'rect' }), t.hints.shape);
  assert.equal(hintFor({ tool: 'rect', toolLocked: true }), `${t.hints.shape} ${t.hints.locked}`);
  assert.equal(hintFor({ tool: 'select', selection: 'text' }), t.hints.editText);
  assert.equal(hintFor({ tool: 'select', selection: 'many' }), t.hints.selection);
  assert.equal(hintFor({ tool: 'select', selection: '' }), '');
  assert.equal(hintFor({ tool: 'rect', editing: true }), '');
});

test('a locked selection gets the unlock hint, never an edit hint it would refuse', () => {
  const rect = createElement('rect', { x: 0, y: 0, w: 100, h: 60 }, DEFAULT_STYLE, { id: 'r', locked: true });
  const arrow = createElement('arrow', { points: [{ x: 0, y: 0 }, { x: 50, y: 0 }] }, DEFAULT_STYLE, { id: 'ar', locked: true });
  const text = createElement('text', { x: 0, y: 100, text: 'olá' }, DEFAULT_STYLE, { id: 'tx' });
  const elements = [rect, arrow, text];
  const kind = (ids) => selectionKindOf({ elements, selection: new Set(ids) });
  assert.equal(kind([]), '');
  assert.equal(kind(['r']), 'locked');
  assert.equal(kind(['ar']), 'locked', 'a locked connector offers no point editing either');
  assert.equal(kind(['r', 'ar']), 'lockedMany');
  assert.equal(kind(['r', 'tx']), 'many', 'partly locked: the usual selection hint');
  assert.equal(kind(['tx']), 'text');
  assert.equal(kind(['gone']), '', 'a stale id is no selection');
  assert.equal(hintFor({ tool: 'select', selection: 'locked', lockKeys: 'Ctrl+Shift+L' }), t.hints.lockedElement('Ctrl+Shift+L'));
  assert.match(hintFor({ tool: 'select', selection: 'locked' }), /travado.*Ctrl\+Shift\+L/);
  assert.equal(hintFor({ tool: 'select', selection: 'lockedMany', lockKeys: '⌘⇧L' }), t.hints.lockedElements('⌘⇧L'));
  assert.notEqual(hintFor({ tool: 'select', selection: 'locked' }), t.hints.editText);
});

test('the colour popover is an Escape overlay: closed before the properties sheet, reset with everything else', () => {
  const ui = useUi.getState();
  ui.closeAll();
  ui.openColorPicker('stroke');
  assert.equal(useUi.getState().colorPicker, 'stroke');
  ui.openColorPicker('fill');
  assert.equal(useUi.getState().colorPicker, 'fill', 'one popover at a time');
  ui.closeColorPicker('stroke');
  assert.equal(useUi.getState().colorPicker, 'fill', 'another row cannot close it');
  useUi.setState({ propsOpen: true });
  assert.equal(ui.closeTopOverlay(), true);
  assert.equal(useUi.getState().colorPicker, null, 'Escape closes the popover first');
  assert.equal(useUi.getState().propsOpen, true, '...and only the popover');
  ui.openColorPicker('stroke');
  useUi.setState({ helpOpen: true });
  ui.closeTopOverlay();
  assert.equal(useUi.getState().helpOpen, false, 'a dialog above it closes first');
  assert.equal(useUi.getState().colorPicker, 'stroke');
  ui.closeAll();
  assert.equal(useUi.getState().colorPicker, null);
  assert.equal(ui.closeTopOverlay(), false);
});

test('board thumbnails: empty boards say so, big ones show a count, the rest draw their real content', () => {
  assert.equal(previewKind({ id: 'b', elementCount: 0 }), 'empty');
  assert.equal(previewKind({ id: 'b', elementCount: 3 }), 'content');
  assert.equal(previewKind({ id: 'b', elementCount: PREVIEW_MAX_ELEMENTS + 1 }), 'large');
  assert.equal(previewKind({ id: 'b' }), 'content', 'a server without counts still gets pictures');
  assert.equal(previewSrc([]), null);
  assert.equal(previewSrc(null), null);
  const rect = createElement('rect', { x: 10, y: 20, w: 100, h: 60 }, DEFAULT_STYLE, { id: 'r1' });
  const note = createElement('text', { x: 10, y: 100, text: 'olá' }, DEFAULT_STYLE, { id: 't1' });
  const src = previewSrc([rect, note]);
  assert.match(src, /^data:image\/svg\+xml;charset=utf-8,/);
  const svg = decodeURIComponent(src.slice(src.indexOf(',') + 1));
  assert.match(svg, /^<svg /);
  assert.doesNotMatch(svg, /data-role="background"/, 'transparent: the row paints the canvas colour');
  assert.doesNotMatch(svg, /@font-face/, 'no font embedded per row');
  assert.match(decodeURIComponent(previewSrc([rect], { dark: true })), /wb-dark/);
  // A new revision is a new picture; a rename (same rev) is not.
  assert.notDeepEqual(previewQueryKey({ id: 'b', rev: 1, elementCount: 1 }), previewQueryKey({ id: 'b', rev: 2, elementCount: 1 }));
  assert.deepEqual(previewQueryKey({ id: 'b', rev: 2, elementCount: 1, title: 'x' }), previewQueryKey({ id: 'b', rev: 2, elementCount: 1, title: 'y' }));
});

test('hintFor: a connector placed click by click says how to finish; point editing says what it does', () => {
  assert.equal(hintFor({ tool: 'arrow' }), t.hints.linear);
  assert.equal(hintFor({ tool: 'arrow', gesture: 'linearMulti' }), t.hints.linearMulti);
  assert.equal(hintFor({ tool: 'line', gesture: 'linearMulti' }), t.hints.linearMulti);
  assert.equal(hintFor({ tool: 'select', selection: 'linear' }), t.hints.editPoints);
  assert.equal(hintFor({ tool: 'select', selection: 'linear', gesture: 'pointEditing' }), t.hints.pointEditing);
  // A stale point-editing flag means nothing without the lone connector selected.
  assert.equal(hintFor({ tool: 'select', selection: 'many', gesture: 'pointEditing' }), t.hints.selection);
  assert.notEqual(t.hints.pointEditing, t.hints.editPoints);
});

test('gestureHintOf reads the interaction state; setGestureHint accepts only known kinds', () => {
  assert.equal(gestureHintOf(null), null);
  assert.equal(gestureHintOf({ g: { kind: 'linear', phase: 'clicking' }, linearEdit: null }), 'linearMulti');
  assert.equal(gestureHintOf({ g: { kind: 'linear', phase: 'dragging' }, linearEdit: null }), null);
  assert.equal(gestureHintOf({ g: null, linearEdit: { id: 'a', editing: true } }), 'pointEditing');
  assert.equal(gestureHintOf({ g: null, linearEdit: { id: 'a', editing: false } }), null);
  const ui = useUi.getState();
  ui.setGestureHint('pointEditing');
  assert.equal(useUi.getState().gestureHint, 'pointEditing');
  ui.setGestureHint('nonsense');
  assert.equal(useUi.getState().gestureHint, null);
  ui.setGestureHint('linearMulti');
  ui.closeAll();
  assert.equal(useUi.getState().gestureHint, null, 'leaving the board drops it');
});

/* --- dialog focus trap ------------------------------------------------------------ */

test('trapTabTarget: focus on the dialog itself is "before the first item"; the ends wrap', () => {
  const [a, b, c] = [{ n: 'a' }, { n: 'b' }, { n: 'c' }];
  const container = { n: 'dialog' };
  const items = [a, b, c];
  assert.equal(trapTabTarget(items, container, true), c, 'Shift+Tab from the container wraps to the last item');
  assert.equal(trapTabTarget(items, container, false), a, 'Tab from the container goes to the first item');
  assert.equal(trapTabTarget(items, a, true), c);
  assert.equal(trapTabTarget(items, c, false), a);
  assert.equal(trapTabTarget(items, b, false), null, 'inside: the browser moves it');
  assert.equal(trapTabTarget(items, b, true), null);
  assert.equal(trapTabTarget([], container, true), null);
});

/* --- view memory ------------------------------------------------------------------ */

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    data,
  };
}

test('view memory: per board, restored as saved, bounded, junk ignored', () => {
  const st = memoryStorage();
  assert.equal(loadView('b1', st), null);
  saveView('b1', { zoom: 1.5, panX: -2000.4, panY: -1500 }, st);
  saveView('b2', { zoom: 0.5, panX: 10, panY: 20 }, st);
  assert.deepEqual(loadView('b1', st), { zoom: 1.5, panX: -2000, panY: -1500 });
  assert.deepEqual(loadView('b2', st), { zoom: 0.5, panX: 10, panY: 20 });
  saveView('b1', { zoom: 2, panX: 0, panY: 0 }, st);
  assert.deepEqual(loadView('b1', st), { zoom: 2, panX: 0, panY: 0 }, 'the latest view wins');
  for (let i = 0; i < MAX_VIEWS + 5; i++) saveView(`x${i}`, { zoom: 1, panX: i, panY: 0 }, st);
  assert.equal(JSON.parse(st.getItem(VIEWS_KEY)).length, MAX_VIEWS, 'never grows without bound');
  assert.equal(loadView('b2', st), null, 'the oldest boards are forgotten first');
  assert.equal(sanitizeView({ zoom: Number.NaN, panX: 0, panY: 0 }), null);
  assert.equal(sanitizeView({ zoom: 1e9, panX: 0, panY: 0 }), null);
  st.setItem(VIEWS_KEY, '{not json');
  assert.equal(loadView('b1', st), null);
  saveView('b1', { zoom: 1, panX: 1, panY: 1 }, st);
  assert.deepEqual(loadView('b1', st), { zoom: 1, panX: 1, panY: 1 }, 'recovers from a corrupt entry');
  assert.equal(loadView('b1', null), null, 'no storage: no memory, no throw');
  saveView('b1', { zoom: 1, panX: 0, panY: 0 }, null);
});

/* --- theme --------------------------------------------------------------------------- */

test('boardDefaultTheme: only a dark board asks for a theme; light (every board’s default) never overrides the OS', () => {
  assert.equal(boardDefaultTheme('dark'), 'dark');
  assert.equal(boardDefaultTheme('light'), null);
  assert.equal(boardDefaultTheme(undefined), null);
  assert.equal(boardDefaultTheme('neon'), null);
});
