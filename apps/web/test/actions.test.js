/**
 * actions.test.js — editor/actions.js against the real board store, in node.
 *
 * Every action is a plain function over `useBoardStore.getState()`, so these
 * tests drive the actual store (no mocks) and assert on what a user would see:
 * which elements exist, what they look like, what is selected, and how many
 * Ctrl+Z it takes to get back.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useBoardStore } from '../src/store/boardStore.js';
import {
  actions,
  reorderIds,
  parseClipboard,
  serializeClipboard,
  CLIPBOARD_TYPE,
  fileBaseName,
  fitContainerToLabel,
  commitActiveTextEdit,
  anyElementVisible,
  groupAvailability,
  groupTree,
  nudgeStep,
  clampPastedText,
  copyTextViaExecCommand,
} from '../src/editor/actions.js';
import { getToasts, clearToasts } from '../src/ui/toast.js';
import { t } from '../src/ui/strings.js';
import { expandSelectionToGroups } from '../src/editor/scene.js';
import { createElement, styleKeysFor } from '../src/editor/elements.js';
import { DEFAULT_STYLE, DUPLICATE_OFFSET, NUDGE, NUDGE_SHIFT } from '../src/editor/constants.js';
import { fitTextElement, labelBox, lineHeightPx, wrapText } from '../src/editor/text.js';
import { LIMITS, ZOOM_LIMITS, resolveConnectors } from '@whiteboard/shared';
import { PRESETS, PRESET_GROUPS, buildPreset, searchPresets, assertPresetsValid } from '../src/store/presets.js';
import { commonBounds } from '../src/editor/handles.js';

const S = () => useBoardStore.getState();

/** Run `fn` with Date.now() frozen at `at` (the store's 500 ms coalescing clock). */
function atTime(at, fn) {
  const real = Date.now;
  Date.now = () => at;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

function reset(elements = []) {
  S().reset();
  S().setViewportSize({ w: 1000, h: 800 });
  S().setSnapshot({ board: { id: 'b1', title: 'Teste' }, elements, rev: 1 });
}

const rect = (x, y, extra = {}) => createElement('rect', { x, y, w: 100, h: 60 }, DEFAULT_STYLE, extra);
const byId = (id) => S().elements.find((el) => el.id === id);
const ids = () => S().elements.map((el) => el.id);

/** Board: a <- arrow -> b, plus a free text and a pen stroke. */
function scene() {
  const a = rect(0, 0, { id: 'a' });
  const b = rect(300, 0, { id: 'b' });
  const arrow = createElement('arrow', { points: [{ x: 100, y: 30 }, { x: 300, y: 30 }] }, DEFAULT_STYLE, {
    id: 'ar',
    startId: 'a',
    endId: 'b',
  });
  const text = createElement('text', { x: 0, y: 200, text: 'olá' }, DEFAULT_STYLE, { id: 'tx' });
  const pen = createElement('pen', { points: [{ x: 0, y: 300 }, { x: 10, y: 310 }, { x: 20, y: 305 }] }, DEFAULT_STYLE, { id: 'pn' });
  return resolveConnectors([a, b, arrow, text, pen]);
}

beforeEach(() => reset(scene()));

/* --- delete ------------------------------------------------------------ */

test('deleteSelection removes the selection, clears it, and one undo restores it', () => {
  S().select(['a', 'tx']);
  assert.equal(actions.deleteSelection(), true);
  assert.deepEqual(ids(), ['b', 'ar', 'pn']);
  assert.equal(S().selection.size, 0);
  // The arrow lost its binding to the deleted box (connectors never dangle).
  assert.equal(byId('ar').startId, undefined);
  S().undo();
  assert.deepEqual(ids(), ['a', 'b', 'ar', 'tx', 'pn']);
  assert.equal(byId('ar').startId, 'a');
});

test('deleteSelection skips locked elements', () => {
  S().updateElements([{ id: 'a', patch: { locked: true } }]);
  S().select(['a', 'b']);
  actions.deleteSelection();
  assert.ok(byId('a'), 'locked element survives');
  assert.equal(byId('b'), undefined);
});

test('deleteSelection with a handle follows the legacy commit -> remove -> clear order', () => {
  const calls = [];
  actions.deleteSelection({
    getState: () => ({ selection: new Set(['x', 'y']) }),
    commit: (l) => calls.push(['commit', l]),
    removeElements: (list) => calls.push(['remove', list]),
    clearSelection: () => calls.push(['clear']),
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0][1], /^delete:/, 'a unique label per delete');
  assert.deepEqual(calls.slice(1), [['remove', ['x', 'y']], ['clear']]);
});

test('two deletes in quick succession are two undo steps (never one merged entry)', () => {
  const depth = S().pastDepth;
  S().select(['a']);
  actions.deleteSelection();
  S().select(['b']);
  actions.deleteSelection();
  assert.equal(S().pastDepth, depth + 2);
  S().undo();
  assert.ok(byId('b'), 'the first Ctrl+Z restores only the last delete');
  assert.equal(byId('a'), undefined);
  S().undo();
  assert.ok(byId('a'));
});

/* --- duplicate ----------------------------------------------------------- */

test('duplicateSelection clones with fresh ids, offsets, remapped bindings, selects the copies', () => {
  S().select(['a', 'b', 'ar']);
  const copies = actions.duplicateSelection();
  assert.equal(copies.length, 3);
  const [ca, cb, car] = copies;
  for (const c of copies) assert.ok(!['a', 'b', 'ar'].includes(c.id));
  assert.equal(ca.x, byId('a').x + DUPLICATE_OFFSET);
  assert.equal(ca.y, byId('a').y + DUPLICATE_OFFSET);
  // The copied arrow is bound to the copied boxes, not the originals.
  assert.equal(car.startId, ca.id);
  assert.equal(car.endId, cb.id);
  assert.equal(car.points[0].x, byId('ar').points[0].x + DUPLICATE_OFFSET);
  assert.deepEqual([...S().selection].sort(), copies.map((c) => c.id).sort());
  assert.equal(S().elements.length, 8);
  S().undo();
  assert.equal(S().elements.length, 5);
});

test('duplicate of an arrow alone drops bindings to shapes that were not copied', () => {
  S().select(['ar']);
  const [copy] = actions.duplicateSelection();
  assert.equal(copy.startId, undefined);
  assert.equal(copy.endId, undefined);
});

test('duplicate with nothing selected does nothing', () => {
  S().clearSelection();
  assert.deepEqual(actions.duplicateSelection(), []);
  assert.equal(S().canUndo, false);
});

/* --- select all ---------------------------------------------------------- */

test('selectAll selects every unlocked element and returns to the select tool', () => {
  S().updateElements([{ id: 'pn', patch: { locked: true } }]);
  S().setTool('rect');
  actions.selectAll();
  assert.equal(S().tool, 'select');
  assert.deepEqual([...S().selection].sort(), ['a', 'ar', 'b', 'tx']);
});

/* --- group / ungroup ---------------------------------------------------- */

test('group gives the selection one shared fresh group key; ungroup removes it; each is one undo step', () => {
  S().select(['a', 'b']);
  assert.equal(actions.group(), true);
  const g = byId('a').groupId;
  assert.ok(g && typeof g === 'string');
  assert.equal(byId('b').groupId, g);
  assert.equal(byId('tx').groupId, undefined);
  // Grouping the exact same group again is a no-op.
  assert.equal(actions.group(), false);

  assert.equal(actions.ungroup(), true);
  assert.equal('groupId' in byId('a'), false, 'null patch removes the key');
  assert.equal('groupId' in byId('b'), false);

  S().undo();
  assert.equal(byId('a').groupId, g);
  S().undo();
  assert.equal(byId('a').groupId, undefined);
});

test('group needs at least two elements', () => {
  S().select(['a']);
  assert.equal(actions.group(), false);
});

test('ungroup of a legacy frame frees the children that point at it', () => {
  const frame = rect(-50, -50, { id: 'frame' });
  reset([frame, rect(0, 0, { id: 'c1', groupId: 'frame' }), rect(10, 10, { id: 'c2', groupId: 'frame' })]);
  S().select(['frame', 'c1', 'c2']);
  assert.equal(actions.ungroup(), true);
  assert.equal(byId('c1').groupId, undefined);
  assert.equal(byId('c2').groupId, undefined);
});

/** What a click on `id` selects (scene.js group expansion), sorted. */
const clickSelects = (id) => expandSelectionToGroups(S().elements, [id]).sort();

test('grouping a group with another element NESTS it: ungroup gives the inner group back (Excalidraw)', () => {
  reset([rect(0, 0, { id: 'A' }), rect(200, 0, { id: 'B' }), rect(400, 0, { id: 'C' })]);
  S().select(['A', 'B']);
  assert.equal(actions.group(), true);
  S().select(['A', 'B', 'C']);
  assert.equal(actions.group(), true);
  // One click on any of them selects all three (the outer group)...
  assert.deepEqual(clickSelects('A'), ['A', 'B', 'C']);
  assert.deepEqual(clickSelects('C'), ['A', 'B', 'C']);
  // ...and the selection is exactly one group: nothing more to group.
  assert.equal(actions.group(), false);
  assert.deepEqual(groupAvailability(), { canGroup: false, canUngroup: true });

  assert.equal(actions.ungroup(), true);
  assert.deepEqual(clickSelects('A'), ['A', 'B'], 'the A+B group survived');
  assert.deepEqual(clickSelects('B'), ['A', 'B']);
  assert.deepEqual(clickSelects('C'), ['C']);

  // One more ungroup of A+B frees everything.
  S().select(['A', 'B']);
  assert.equal(actions.ungroup(), true);
  for (const id of ['A', 'B', 'C']) assert.equal(byId(id).groupId, undefined, `${id} has no group left`);
  assert.deepEqual(clickSelects('A'), ['A']);
  assert.equal(actions.ungroup(), false);

  // Each step is one undo: back to the nested group, then to the flat A+B.
  S().undo();
  assert.deepEqual(clickSelects('A'), ['A', 'B']);
  S().undo();
  assert.deepEqual(clickSelects('C'), ['A', 'B', 'C']);
});

test('groupTree lists each element\'s groups innermost first, nested members included', () => {
  reset([rect(0, 0, { id: 'A', groupId: 'N' }), rect(200, 0, { id: 'B', groupId: 'A' }), rect(400, 0, { id: 'C', groupId: 'N' })]);
  const tree = groupTree(S().elements);
  assert.deepEqual(tree.chains.get('B'), ['A', 'N']);
  assert.deepEqual(tree.chains.get('A'), ['A', 'N']);
  assert.deepEqual(tree.chains.get('C'), ['N']);
  assert.deepEqual([...tree.members.get('N')].sort(), ['A', 'B', 'C']);
  assert.deepEqual([...tree.members.get('A')].sort(), ['A', 'B']);
});

test('two groups grouped together keep both inner groups; three levels deep still unwind one level at a time', () => {
  reset([rect(0, 0, { id: 'A' }), rect(100, 0, { id: 'B' }), rect(200, 0, { id: 'C' }), rect(300, 0, { id: 'D' }), rect(400, 0, { id: 'E' })]);
  S().select(['A', 'B']);
  actions.group();
  S().select(['C', 'D']);
  actions.group();
  S().select(['A', 'B', 'C', 'D']);
  assert.equal(actions.group(), true);
  assert.deepEqual(clickSelects('D'), ['A', 'B', 'C', 'D']);
  // A group made only of groups cannot carry a link to a parent (one groupId
  // per element): nesting it once more merges that one level, and the two
  // groups inside it stay.
  S().select(['A', 'B', 'C', 'D', 'E']);
  assert.equal(actions.group(), true);
  assert.deepEqual(clickSelects('E'), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(actions.ungroup(), true);
  assert.deepEqual(clickSelects('A'), ['A', 'B']);
  assert.deepEqual(clickSelects('C'), ['C', 'D']);
  assert.deepEqual(clickSelects('E'), ['E']);
});

test('a group nested with a lone element keeps its members when the element is its link (group of three + one)', () => {
  reset([rect(0, 0, { id: 'A' }), rect(100, 0, { id: 'B' }), rect(200, 0, { id: 'C' }), rect(300, 0, { id: 'D' })]);
  S().select(['A', 'B', 'C']);
  actions.group();
  S().select(['A', 'B', 'C', 'D']);
  actions.group();
  // The inner group is keyed by one of its members now; all three still in it.
  assert.deepEqual(clickSelects('B'), ['A', 'B', 'C', 'D']);
  actions.ungroup();
  assert.deepEqual(clickSelects('C'), ['A', 'B', 'C']);
  assert.deepEqual(clickSelects('D'), ['D']);
});

test('a legacy frame grouped with another element nests as a unit, and ungroup restores the frame', () => {
  const frame = rect(-50, -50, { id: 'frame' });
  reset([frame, rect(0, 0, { id: 'c1', groupId: 'frame' }), rect(10, 10, { id: 'c2', groupId: 'frame' }), rect(500, 0, { id: 'x' })]);
  S().select(['frame', 'c1', 'c2', 'x']);
  assert.equal(actions.group(), true);
  assert.equal(byId('c1').groupId, 'frame', 'children still point at their frame');
  assert.deepEqual(clickSelects('x'), ['c1', 'c2', 'frame', 'x']);
  actions.ungroup();
  assert.deepEqual(clickSelects('c1'), ['c1', 'c2', 'frame']);
  assert.deepEqual(clickSelects('x'), ['x']);
});

test('ungrouping an inner group picked inside its outer group keeps its members in the outer one', () => {
  reset([rect(0, 0, { id: 'A', groupId: 'N' }), rect(200, 0, { id: 'B', groupId: 'A' }), rect(400, 0, { id: 'C', groupId: 'N' })]);
  // After double-clicking into N, the inner group A+B alone is selected.
  S().select(['A', 'B']);
  assert.equal(actions.ungroup(), true);
  assert.equal(byId('B').groupId, 'N', 'B moved up into N, not out of every group');
  assert.equal(byId('A').groupId, 'N');
  assert.deepEqual(clickSelects('B'), ['A', 'B', 'C']);
});

test('groupAvailability: group needs two elements that are not already exactly one group', () => {
  S().select(['a']);
  assert.deepEqual(groupAvailability(), { canGroup: false, canUngroup: false });
  S().select(['a', 'b']);
  assert.deepEqual(groupAvailability(), { canGroup: true, canUngroup: false });
  actions.group();
  assert.deepEqual(groupAvailability(), { canGroup: false, canUngroup: true });
  // The group plus another element can be grouped (nesting).
  S().select(['a', 'b', 'tx']);
  assert.deepEqual(groupAvailability(), { canGroup: true, canUngroup: true });
  S().clearSelection();
  assert.deepEqual(groupAvailability(), { canGroup: false, canUngroup: false });
});

/* --- lock ------------------------------------------------------------------ */

test('toggleLock locks, then unlocks with locked:false (never null)', () => {
  S().select(['a', 'b']);
  actions.toggleLock();
  assert.equal(byId('a').locked, true);
  assert.equal(byId('b').locked, true);
  actions.toggleLock();
  assert.equal(byId('a').locked, false);
  assert.equal(byId('b').locked, false);
});

/* --- z-order ---------------------------------------------------------------- */

test('reorderIds: forward/backward move one step past unselected, front/back go to the ends', () => {
  const els = ['1', '2', '3', '4', '5'].map((id) => ({ id }));
  const sel = new Set(['2', '3']);
  assert.deepEqual(reorderIds(els, sel, 'forward'), ['1', '4', '2', '3', '5']);
  assert.deepEqual(reorderIds(els, sel, 'backward'), ['2', '3', '1', '4', '5']);
  assert.deepEqual(reorderIds(els, sel, 'front'), ['1', '4', '5', '2', '3']);
  assert.deepEqual(reorderIds(els, sel, 'back'), ['2', '3', '1', '4', '5']);
  assert.equal(reorderIds(els, new Set(['5']), 'forward'), null, 'already on top');
  assert.equal(reorderIds(els, new Set(['1']), 'back'), null, 'already at the back');
});

test('bringToFront / sendToBack / forward / backward reorder the store and undo', () => {
  S().select(['a']);
  actions.bringToFront();
  assert.deepEqual(ids(), ['b', 'ar', 'tx', 'pn', 'a']);
  actions.sendBackward();
  assert.deepEqual(ids(), ['b', 'ar', 'tx', 'a', 'pn']);
  actions.sendToBack();
  assert.deepEqual(ids(), ['a', 'b', 'ar', 'tx', 'pn']);
  actions.bringForward();
  assert.deepEqual(ids(), ['b', 'a', 'ar', 'tx', 'pn']);
  assert.equal(actions.sendToBack(), true);
  assert.equal(actions.sendToBack(), false, 'no-op creates no undo entry');
  S().undo();
  assert.deepEqual(ids(), ['b', 'a', 'ar', 'tx', 'pn']);
});

/* --- nudge ------------------------------------------------------------------- */

test('nudge moves boxes by x/y and polylines by points; bound arrows follow', () => {
  S().select(['b', 'pn']);
  const pen0 = byId('pn').points.map((p) => ({ ...p }));
  const arrowEnd0 = byId('ar').points[1];
  actions.nudge(NUDGE_SHIFT, 0);
  assert.equal(byId('b').x, 300 + NUDGE_SHIFT);
  assert.deepEqual(byId('pn').points, pen0.map((p) => ({ x: p.x + NUDGE_SHIFT, y: p.y })));
  // The arrow bound to b was re-resolved: its end follows the box.
  assert.equal(byId('ar').points[1].x, arrowEnd0.x + NUDGE_SHIFT);
  assert.equal(byId('ar').endId, 'b');
});

test('repeated nudges coalesce into one undo step', () => {
  S().select(['a']);
  actions.nudge(1, 0);
  actions.nudge(1, 0);
  actions.nudge(0, 1);
  assert.equal(byId('a').x, 2);
  assert.equal(byId('a').y, 1);
  S().undo();
  assert.equal(byId('a').x, 0);
  assert.equal(byId('a').y, 0);
});

test('nudging another selection right after is its own undo step', () => {
  S().select(['a']);
  actions.nudge(1, 0);
  S().select(['tx']);
  actions.nudge(0, 1);
  S().undo();
  assert.equal(byId('tx').y, 200, 'the second nudge is undone…');
  assert.equal(byId('a').x, 1, '…without the first one');
  S().undo();
  assert.equal(byId('a').x, 0);
});

test('nudgeStep: grid mode moves one grid cell (Shift: 1 unit); otherwise 1 unit (Shift: NUDGE_SHIFT)', () => {
  assert.equal(nudgeStep(false, { snapEnabled: false, gridSize: 20 }), NUDGE);
  assert.equal(nudgeStep(true, { snapEnabled: false, gridSize: 20 }), NUDGE_SHIFT);
  assert.equal(nudgeStep(false, { snapEnabled: true, gridSize: 20 }), 20);
  assert.equal(nudgeStep(true, { snapEnabled: true, gridSize: 20 }), NUDGE);
  assert.equal(nudgeStep(false, { snapEnabled: true, gridSize: 0 }), NUDGE, 'no grid size: plain steps');
  S().toggleSnap();
  assert.equal(nudgeStep(false), S().gridSize, 'reads the live store by default');
});

test('nudge skips locked elements and does nothing without a selection', () => {
  S().updateElements([{ id: 'a', patch: { locked: true } }]);
  S().select(['a']);
  assert.equal(actions.nudge(5, 5), false);
  assert.equal(byId('a').x, 0);
  S().clearSelection();
  assert.equal(actions.nudge(5, 5), false);
});

/* --- applyStyle -------------------------------------------------------------- */

test('applyStyle patches only the keys each selected type uses, and sets the default style', () => {
  S().select(['a', 'pn', 'tx', 'ar']);
  const before = Object.fromEntries(S().elements.map((el) => [el.id, el]));
  actions.applyStyle({ fontFamily: 'code', stroke: '#e03131' });
  assert.equal(S().style.fontFamily, 'code');
  assert.equal(S().style.stroke, '#e03131');
  for (const el of S().elements) {
    const allowed = styleKeysFor(el.type);
    const was = before[el.id];
    if (!S().selection.has(el.id)) continue;
    assert.equal(el.stroke, allowed.includes('stroke') ? '#e03131' : was.stroke, `${el.type} stroke`);
    if (!allowed.includes('fontFamily')) assert.equal(el.fontFamily, was.fontFamily, `${el.type} must not get fontFamily`);
  }
  assert.equal(byId('pn').fontFamily, undefined, 'a pen stroke never gets a font');
  assert.equal(byId('ar').fontFamily, undefined);
  assert.equal(byId('a').fontFamily, 'code');
  assert.equal(byId('tx').fontFamily, 'code');
  assert.equal(byId('b').stroke, DEFAULT_STYLE.stroke, 'unselected elements untouched');
});

test('applyStyle re-fits free text after a font size change', () => {
  S().select(['tx']);
  const w0 = byId('tx').w;
  actions.applyStyle({ fontSize: 36 });
  const tx = byId('tx');
  assert.equal(tx.fontSize, 36);
  const fit = fitTextElement(tx);
  assert.equal(tx.w, fit.w);
  assert.equal(tx.h, fit.h);
  assert.ok(tx.w > w0);
});

test('applyStyle grows a labelled shape so its label fits a bigger font (no mid-word splits), as one undo step', () => {
  const box = rect(440, 260, { id: 'lb', w: 120, h: 80, label: 'Olá mundo grande demais' });
  const other = rect(0, 0, { id: 'o' });
  const arrow = createElement('arrow', { points: [{ x: 100, y: 30 }, { x: 440, y: 300 }] }, DEFAULT_STYLE, { id: 'ar2', startId: 'o', endId: 'lb' });
  reset(resolveConnectors([other, box, arrow]));
  const before = byId('lb');
  const centre = { x: before.x + before.w / 2, y: before.y + before.h / 2 };
  const arrowBefore = byId('ar2').points.map((p) => ({ ...p }));
  S().select(['lb']);
  actions.applyStyle({ fontSize: 36 });
  const el = byId('lb');
  assert.equal(el.fontSize, 36);
  const lb = labelBox(el);
  const lines = wrapText(el.label, lb.w, 'hand', 36);
  const words = el.label.split(' ');
  for (const line of lines) assert.ok(line.split(' ').every((w) => words.includes(w)), `"${line}" holds whole words only`);
  assert.ok(lines.length * lineHeightPx(36) <= lb.h + 0.01, 'every line fits inside the shape');
  assert.ok(el.w >= before.w && el.h > before.h, 'the shape only grows');
  assert.ok(Math.abs(el.x + el.w / 2 - centre.x) < 1 && Math.abs(el.y + el.h / 2 - centre.y) < 1, 'about its centre');
  assert.notDeepEqual(byId('ar2').points, arrowBefore, 'the bound arrow follows the new outline');
  S().undo();
  assert.equal(byId('lb').h, 80);
  assert.equal(byId('lb').fontSize, before.fontSize);
});

test('fitContainerToLabel: null when it fits or has no label; never shrinks; ellipse/diamond/sticky use their label box', () => {
  assert.equal(fitContainerToLabel(rect(0, 0, { w: 200, h: 100, label: 'oi' })), null);
  assert.equal(fitContainerToLabel(rect(0, 0, { w: 20, h: 20 })), null);
  assert.equal(fitContainerToLabel(createElement('text', { x: 0, y: 0, text: 'x' }, DEFAULT_STYLE)), null);
  assert.equal(fitContainerToLabel(rect(0, 0, { w: 400, h: 400, label: 'curto', fontSize: 16 })), null, 'a smaller font does not shrink');
  for (const type of ['ellipse', 'diamond', 'sticky', 'cylinder']) {
    const el = createElement(type, { x: 0, y: 0, w: 120, h: 80 }, DEFAULT_STYLE, { label: 'um texto bem comprido para caber', fontSize: 36 });
    const fit = fitContainerToLabel(el);
    assert.ok(fit, type);
    const grown = { ...el, ...fit };
    const lb = labelBox(grown);
    const lines = wrapText(grown.label, lb.w, 'hand', 36);
    assert.ok(lines.length * lineHeightPx(36) <= lb.h + 0.01, `${type}: label fits`);
    const words = grown.label.split(' ');
    assert.ok(lines.every((l) => l.split(' ').every((w) => words.includes(w))), `${type}: no word split`);
  }
  // One absurd word does not make the shape absurdly wide: it wraps past the cap.
  const huge = fitContainerToLabel(rect(0, 0, { w: 120, h: 80, label: 'x'.repeat(400), fontSize: 20 }));
  assert.ok(huge.w <= 20 * 20 + 20);
});

test('applyStyle: one undo step per control, even for a burst (slider drag)', () => {
  S().select(['a']);
  for (let i = 1; i <= 10; i++) actions.applyStyle({ opacity: i / 10 });
  assert.equal(byId('a').opacity, 1);
  actions.applyStyle({ opacity: 0.5 });
  assert.equal(byId('a').opacity, 0.5);
  S().undo();
  assert.equal(byId('a').opacity, DEFAULT_STYLE.opacity, 'one Ctrl+Z undoes the whole drag');
  assert.equal(S().canUndo, false);
});

test('applyStyle: a slider drag (gesture) is one undo step even with a pause longer than the coalescing window', () => {
  S().select(['a']);
  const depth = S().pastDepth;
  atTime(10_000, () => actions.applyStyle({ opacity: 0.6 }, { gesture: 'g1' }));
  atTime(10_050, () => actions.applyStyle({ opacity: 0.2 }, { gesture: 'g1' }));
  // The button is held still for 700 ms, then the drag goes on.
  atTime(10_750, () => actions.applyStyle({ opacity: 0.1 }, { gesture: 'g1' }));
  assert.equal(byId('a').opacity, 0.1);
  assert.equal(S().pastDepth, depth + 1);
  S().undo();
  assert.equal(byId('a').opacity, DEFAULT_STYLE.opacity, 'one Ctrl+Z restores the opacity from before the drag');
});

test('applyStyle: two separate slider drags are two undo steps, however close together', () => {
  S().select(['a']);
  atTime(20_000, () => actions.applyStyle({ opacity: 0.5 }, { gesture: 'g1' }));
  atTime(20_100, () => actions.applyStyle({ opacity: 0.3 }, { gesture: 'g2' }));
  S().undo();
  assert.equal(byId('a').opacity, 0.5);
  S().undo();
  assert.equal(byId('a').opacity, DEFAULT_STYLE.opacity);
});

test('applyStyle: a gesture commits again after something else committed (or an undo) in between', () => {
  S().select(['a']);
  actions.applyStyle({ opacity: 0.5 }, { gesture: 'g1' });
  S().undo();
  assert.equal(byId('a').opacity, DEFAULT_STYLE.opacity);
  actions.applyStyle({ opacity: 0.4 }, { gesture: 'g1' });
  assert.equal(S().canUndo, true, 'the change after the undo is undoable');
  S().undo();
  assert.equal(byId('a').opacity, DEFAULT_STYLE.opacity);
});

test('applyStyle without a selection only changes the default style (no undo entry)', () => {
  S().clearSelection();
  assert.equal(actions.applyStyle({ strokeWidth: 4 }), false);
  assert.equal(S().style.strokeWidth, 4);
  assert.equal(S().canUndo, false);
});

test('applyStyle: a background picked for a sticky note becomes the next note colour, not the shape fill', () => {
  const note = createElement('sticky', { x: 0, y: 0 }, DEFAULT_STYLE, { id: 'n1', label: 'oi' });
  reset([note, rect(300, 0, { id: 'r1' })]);
  S().select(['n1']);
  actions.applyStyle({ fill: '#a5d8ff' });
  assert.equal(byId('n1').fill, '#a5d8ff');
  assert.equal(S().style.stickyFill, '#a5d8ff');
  assert.equal(S().style.fill, DEFAULT_STYLE.fill);
  // A note never loses its paper.
  actions.applyStyle({ fill: 'none' });
  assert.equal(byId('n1').fill, '#a5d8ff');
});

/* --- clipboard ------------------------------------------------------------------ */

test('clipboard JSON round-trips and rejects foreign text', () => {
  const text = serializeClipboard([byId('a')]);
  assert.ok(text.includes(CLIPBOARD_TYPE));
  const parsed = parseClipboard(text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'a');
  assert.equal(parseClipboard('hello'), null);
  assert.equal(parseClipboard('{"type":"other","elements":[]}'), null);
  assert.deepEqual(parseClipboard(JSON.stringify({ type: CLIPBOARD_TYPE, elements: [{ bogus: true }] })), []);
});

test('paste remaps ids and bindings, centres on the target point, selects, one undo step', async () => {
  S().select(['a', 'b', 'ar']);
  const text = actions.selectionClipboardText();
  const pasted = await actions.paste(text, { x: 1000, y: 1000 });
  assert.equal(pasted.length, 3);
  const pa = pasted[0];
  const pb = pasted[1];
  const par = pasted[2];
  for (const el of pasted) assert.ok(!['a', 'b', 'ar'].includes(el.id), 'fresh ids');
  assert.equal(par.startId, pa.id);
  assert.equal(par.endId, pb.id);
  // Bounds of the paste are centred on the target.
  const minX = Math.min(pa.x, pb.x);
  const maxX = Math.max(pa.x + pa.w, pb.x + pb.w);
  assert.ok(Math.abs((minX + maxX) / 2 - 1000) < 1e-6);
  assert.deepEqual([...S().selection].sort(), pasted.map((el) => el.id).sort());
  assert.equal(S().elements.length, 8);
  S().undo();
  assert.equal(S().elements.length, 5);
});

test('pasting the same clipboard twice gives distinct ids each time', async () => {
  S().select(['a']);
  const text = actions.selectionClipboardText();
  const [p1] = await actions.paste(text, { x: 0, y: 0 });
  const [p2] = await actions.paste(text, { x: 0, y: 0 });
  assert.notEqual(p1.id, p2.id);
  assert.ok(p1.id.length <= 40 && p2.id.length <= 40);
});

test('plain text pastes as a text element', async () => {
  const [el] = await actions.paste('linha 1\nlinha 2', { x: 50, y: 50 });
  assert.equal(el.type, 'text');
  assert.equal(el.text, 'linha 1\nlinha 2');
  assert.ok(byId(el.id));
});

test('paste(null) falls back to the last in-app copy when there is no system clipboard', async () => {
  S().select(['b']);
  actions.selectionClipboardText();
  const pasted = await actions.paste(null, { x: 0, y: 0 });
  assert.equal(pasted.length, 1);
  assert.equal(pasted[0].type, 'rect');
});

test('cut copies and removes as one undo step', async () => {
  S().select(['tx']);
  await actions.cut();
  assert.equal(byId('tx'), undefined);
  const pasted = await actions.paste(null, { x: 0, y: 0 });
  assert.equal(pasted[0].type, 'text');
  S().undo(); // paste
  S().undo(); // cut
  assert.ok(byId('tx'));
});

/**
 * Run `fn` with `navigator.clipboard` replaced (node has a navigator but no
 * clipboard, i.e. an http origin); restored afterwards.
 */
async function withClipboard(clipboard, fn) {
  const nav = globalThis.navigator;
  const had = Object.getOwnPropertyDescriptor(nav, 'clipboard');
  Object.defineProperty(nav, 'clipboard', { value: clipboard, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (had) Object.defineProperty(nav, 'clipboard', had);
    else delete nav.clipboard;
  }
}

test('menu Copy with no way to reach the system clipboard: Ctrl+V pastes the copy, not stale system text', async () => {
  S().select(['a']);
  // node: no navigator.clipboard and no document for execCommand.
  assert.equal(await actions.copy(), false);
  const mine = actions.clipboardTextForPaste('texto antigo do sistema');
  assert.ok(parseClipboard(mine), 'the in-memory copy wins over the older system text');
  assert.ok(parseClipboard(actions.clipboardTextForPaste('')), '…and over an empty system clipboard');
  const [el] = await actions.paste(mine, { x: 0, y: 0 });
  assert.equal(el.type, 'rect');
  // A native copy of page text (the title field) is newer than that copy.
  actions.noteSystemClipboardWrite();
  assert.equal(actions.clipboardTextForPaste('título copiado'), 'título copiado');
});

test('menu Copy / Cut that reached the system clipboard leave Ctrl+V on the system text', async () => {
  const written = [];
  await withClipboard({ writeText: async (text) => written.push(text) }, async () => {
    S().select(['a']);
    assert.equal(await actions.copy(), true);
    assert.equal(written.length, 1);
    assert.equal(actions.clipboardTextForPaste('outra coisa'), 'outra coisa');
    S().select(['tx']);
    assert.equal(await actions.cut(), true);
    assert.equal(written.length, 2);
    assert.equal(byId('tx'), undefined);
    assert.equal(actions.clipboardTextForPaste('outra coisa'), 'outra coisa');
  });
});

test('a refused async clipboard falls back to execCommand, then to memory', async () => {
  await withClipboard(
    {
      writeText: async () => {
        throw new Error('NotAllowedError');
      },
    },
    async () => {
      S().select(['b']);
      assert.equal(await actions.copy(), false, 'no document here: memory only');
      assert.ok(parseClipboard(actions.clipboardTextForPaste('velho')));
    },
  );
  actions.noteSystemClipboardWrite();
});

test('copyTextViaExecCommand copies through a throwaway textarea and gives focus back', () => {
  const calls = [];
  const focused = { focus: (opts) => calls.push(['focus', opts]) };
  const body = { children: [], appendChild: (n) => body.children.push(n) };
  const doc = {
    body,
    activeElement: focused,
    createElement: (tag) => {
      const node = {
        tag,
        attrs: {},
        style: {},
        setAttribute: (k, v) => (node.attrs[k] = v),
        select: () => calls.push(['select', node.value]),
        setSelectionRange: (a, b) => calls.push(['range', a, b]),
        remove: () => body.children.splice(body.children.indexOf(node), 1),
      };
      return node;
    },
    execCommand: (cmd) => {
      calls.push(['exec', cmd, body.children.length]);
      return true;
    },
  };
  assert.equal(copyTextViaExecCommand('olá', doc), true);
  assert.deepEqual(calls[0], ['select', 'olá']);
  assert.deepEqual(calls[2], ['exec', 'copy', 1], 'the textarea is in the page while copying');
  assert.equal(body.children.length, 0, 'and removed afterwards');
  assert.equal(calls.at(-1)[0], 'focus');
  assert.equal(copyTextViaExecCommand('x', { ...doc, execCommand: () => false }), false);
  assert.equal(copyTextViaExecCommand('x', null), false, 'no DOM (node)');
});

test('clampPastedText keeps what fits, says when it cut, never splits an emoji', () => {
  assert.deepEqual(clampPastedText('a\r\nb\rc'), { text: 'a\nb\nc', truncated: false });
  assert.deepEqual(clampPastedText('x'.repeat(10), 10), { text: 'x'.repeat(10), truncated: false });
  assert.deepEqual(clampPastedText('x'.repeat(11), 10), { text: 'x'.repeat(10), truncated: true });
  const emoji = 'x'.repeat(9) + '😀'; // the pair straddles the cut at 10
  assert.deepEqual(clampPastedText(emoji + 'y', 10), { text: 'x'.repeat(9), truncated: true });
});

test('pasting text longer than the limit keeps the first MAX_TEXT characters and says so', async () => {
  clearToasts();
  const long = 'palavra '.repeat(LIMITS.MAX_TEXT); // 8x the limit
  const [el] = await actions.paste(long, { x: 0, y: 0 });
  assert.equal(el.type, 'text');
  assert.equal(el.text.length, LIMITS.MAX_TEXT);
  assert.ok(long.startsWith(el.text));
  assert.ok(
    getToasts().some((x) => x.message === t.toast.pasteTruncated(LIMITS.MAX_TEXT)),
    'a toast says the text was cut',
  );
  clearToasts();
  await actions.paste('curto', { x: 0, y: 0 });
  assert.equal(getToasts().length, 0, 'no toast when nothing was cut');
});

/* --- clear ---------------------------------------------------------------------- */

test('clearCanvas removes everything as one undo step', () => {
  S().select(['a']);
  assert.equal(actions.clearCanvas(), true);
  assert.equal(S().elements.length, 0);
  assert.equal(S().selection.size, 0);
  S().undo();
  assert.equal(S().elements.length, 5);
  reset([]);
  assert.equal(actions.clearCanvas(), false, 'empty board: nothing to clear, no undo entry');
  assert.equal(S().canUndo, false);
});

/* --- view --------------------------------------------------------------------- */

test('zoom in/out/reset act about the viewport centre', () => {
  S().setView({ zoom: 1, panX: 0, panY: 0 });
  const centre = () => {
    const v = S().view;
    return { x: (500 - v.panX) / v.zoom, y: (400 - v.panY) / v.zoom };
  };
  const c0 = centre();
  actions.zoomIn();
  assert.ok(S().view.zoom > 1);
  assert.ok(Math.abs(centre().x - c0.x) < 1e-6 && Math.abs(centre().y - c0.y) < 1e-6);
  actions.zoomOut();
  actions.zoomOut();
  assert.ok(S().view.zoom < 1);
  actions.resetZoom();
  assert.equal(S().view.zoom, 1);
  assert.ok(Math.abs(centre().x - c0.x) < 1e-6);
});

test('zoom in/out step by 10 percentage points, like Excalidraw (not x1.25)', () => {
  S().setView({ zoom: 1, panX: 0, panY: 0 });
  const pct = () => Math.round(S().view.zoom * 100);
  const seen = [];
  for (let i = 0; i < 5; i++) {
    actions.zoomIn();
    seen.push(pct());
  }
  assert.deepEqual(seen, [110, 120, 130, 140, 150]);
  assert.equal(S().view.zoom, 1.5, 'exact, no float drift');
  actions.resetZoom();
  seen.length = 0;
  for (let i = 0; i < 7; i++) {
    actions.zoomOut();
    seen.push(pct());
  }
  assert.deepEqual(seen, [90, 80, 70, 60, 50, 40, 30]);
  // A wheel-zoomed level steps from where it is.
  S().setView({ zoom: 1.37, panX: 0, panY: 0 });
  actions.zoomIn();
  assert.equal(S().view.zoom, 1.47);
  // Clamped at the limits, and a step at the limit changes nothing.
  S().setView({ zoom: ZOOM_LIMITS.min + 0.05, panX: 0, panY: 0 });
  actions.zoomOut();
  assert.equal(S().view.zoom, ZOOM_LIMITS.min);
  const before = S().view;
  actions.zoomOut();
  assert.equal(S().view, before, 'no view change at the minimum');
  S().setView({ zoom: ZOOM_LIMITS.max, panX: 0, panY: 0 });
  actions.zoomIn();
  assert.equal(S().view.zoom, ZOOM_LIMITS.max);
});

test('zoomToFit frames all elements without magnifying past 100%', () => {
  S().setView({ zoom: 3, panX: -5000, panY: 999 });
  actions.zoomToFit();
  const v = S().view;
  assert.ok(v.zoom <= 1);
  // Every element's box is on screen.
  for (const el of S().elements) {
    const sx = el.x * v.zoom + v.panX;
    const sy = el.y * v.zoom + v.panY;
    assert.ok(sx >= 0 && sx <= 1000 && sy >= 0 && sy <= 800, `${el.id} visible`);
  }
});

test('zoomToSelection frames the selection', () => {
  S().select(['b']);
  actions.zoomToSelection();
  const v = S().view;
  const b = byId('b');
  const cx = (b.x + b.w / 2) * v.zoom + v.panX;
  assert.ok(Math.abs(cx - 500) <= 1);
  assert.ok(v.zoom > 1, 'a small selection is magnified');
});

test('anyElementVisible: true when some element overlaps the viewport, false when all are off-screen', () => {
  const size = { w: 1000, h: 800 };
  assert.equal(anyElementVisible(S().elements, { zoom: 1, panX: 0, panY: 0 }, size), true);
  assert.equal(anyElementVisible(S().elements, { zoom: 1, panX: -5000, panY: -5000 }, size), false);
  // Partly visible counts: b spans x 300..400, the view starts at x 350.
  assert.equal(anyElementVisible([byId('b')], { zoom: 1, panX: -350, panY: 0 }, size), true);
  assert.equal(anyElementVisible([], { zoom: 1, panX: 0, panY: 0 }, size), false);
});

test('scrollToContent centres off-screen content at the current zoom', () => {
  reset([rect(2000, 1500, { id: 'far', w: 200, h: 120 })]);
  S().setView({ zoom: 1, panX: 0, panY: 0 });
  assert.equal(anyElementVisible(S().elements, S().view, { w: 1000, h: 800 }), false);
  assert.equal(actions.scrollToContent(), true);
  const v = S().view;
  assert.equal(v.zoom, 1);
  assert.equal(2100 * v.zoom + v.panX, 500, 'content centre at the viewport centre (x)');
  assert.equal(1560 * v.zoom + v.panY, 400, 'content centre at the viewport centre (y)');
  assert.equal(anyElementVisible(S().elements, v, { w: 1000, h: 800 }), true);
});

test('scrollToContent frames content that does not fit at this zoom (never magnifying)', () => {
  reset([rect(0, 0, { id: 'l' }), rect(5000, 0, { id: 'r' })]);
  S().setView({ zoom: 2, panX: 90_000, panY: 0 });
  actions.scrollToContent();
  const v = S().view;
  assert.ok(v.zoom < 1);
  for (const el of S().elements) {
    const sx = el.x * v.zoom + v.panX;
    assert.ok(sx >= 0 && sx <= 1000, `${el.id} visible`);
  }
  reset([]);
  assert.equal(actions.scrollToContent(), false, 'nothing to scroll to on an empty board');
});

/* --- misc ------------------------------------------------------------------------ */

test('editSelected starts editing a single selected text or container only', () => {
  S().select(['tx']);
  assert.equal(actions.editSelected(), true);
  assert.equal(S().editingId, 'tx');
  S().setEditing(null);
  S().select(['pn']);
  assert.equal(actions.editSelected(), false);
  S().select(['a', 'b']);
  assert.equal(actions.editSelected(), false);
});

test('selectTool commits an open text edit BEFORE switching (toolbar buttons keep focus in the textarea)', () => {
  const events = [];
  const textarea = {
    matches: (sel) => sel.includes('text-editor'),
    // The real textarea commits on blur; here the commit is recorded with the tool it saw.
    blur: () => events.push(['blur', S().tool]),
  };
  const prevDocument = globalThis.document;
  globalThis.document = { activeElement: textarea };
  try {
    S().setTool('text');
    actions.selectTool('rect');
    assert.deepEqual(events, [['blur', 'text']], 'committed while the old tool was still active');
    assert.equal(S().tool, 'rect');
    // Nothing is being edited: no blur of an unrelated focused control.
    globalThis.document = { activeElement: { matches: () => false, blur: () => events.push(['wrong']) } };
    actions.selectTool('ellipse');
    assert.equal(events.length, 1);
    assert.equal(S().tool, 'ellipse');
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
  assert.equal(commitActiveTextEdit(null), false, 'no DOM (node): no-op');
});

test('fileBaseName keeps accents and strips path characters', () => {
  assert.equal(fileBaseName('Reunião: planos/2026'), 'Reunião- planos-2026');
  assert.equal(fileBaseName('   '), 'quadro');
});

test('importFile replaces the board with a parsed file, as one undo step', async () => {
  const file = { text: async () => JSON.stringify({ type: 'whiteboard', version: 2, elements: [rect(5, 5, { id: 'imp' })] }) };
  const res = await actions.importFile(file);
  assert.equal(res.ok, true);
  assert.deepEqual(ids(), ['imp']);
  S().undo();
  assert.equal(S().elements.length, 5);
  const bad = await actions.importFile({ text: async () => 'not json' });
  assert.equal(bad.ok, false);
  assert.equal(S().elements.length, 5, 'a bad file changes nothing');
});

/* --- library presets (store/presets.js) -------------------------------------- */


test('every preset builds valid, seeded elements in the new model', () => {
  const res = assertPresetsValid();
  assert.deepEqual(res.failures, []);
  for (const p of PRESETS) {
    for (const el of buildPreset(p, { x: 0, y: 0 }, DEFAULT_STYLE)) {
      assert.ok(Number.isInteger(el.seed), `${p.id}: seed`);
      assert.equal(typeof el.roughness === 'number' || el.type === 'sticky' || el.type === 'text' || el.type === 'pen', true, `${p.id}: roughness`);
    }
  }
  assert.ok(PRESET_GROUPS.length >= 3);
});

test('shapes carry their text in label; connectors in presets are bound', () => {
  const [box] = buildPreset(PRESETS.find((p) => p.id === 'box'), { x: 0, y: 0 }, DEFAULT_STYLE);
  assert.equal(box.type, 'rect');
  assert.ok(box.label && box.label.length > 0);
  const flow = buildPreset(PRESETS.find((p) => p.id === 'process'), { x: 0, y: 0 }, DEFAULT_STYLE);
  const boxes = flow.filter((el) => el.type === 'rect');
  const arrows = flow.filter((el) => el.type === 'arrow');
  assert.equal(boxes.length, 3);
  assert.equal(arrows.length, 2);
  assert.equal(arrows[0].startId, boxes[0].id);
  assert.equal(arrows[0].endId, boxes[1].id);
  // Settled: resolving again changes nothing.
  assert.deepEqual(resolveConnectors(flow), flow);
});

test('buildPreset centres on the point and gives fresh ids every call', () => {
  const p = PRESETS.find((x) => x.id === 'yes-no');
  const a = buildPreset(p, { x: 500, y: -200 }, DEFAULT_STYLE);
  const b = buildPreset(p, { x: 500, y: -200 }, DEFAULT_STYLE);
  const bb = commonBounds(a);
  assert.ok(Math.abs(bb.x + bb.w / 2 - 500) <= 1);
  assert.ok(Math.abs(bb.y + bb.h / 2 + 200) <= 1);
  const idsA = new Set(a.map((el) => el.id));
  for (const el of b) assert.ok(!idsA.has(el.id));
});

test('grouped presets share one group key', () => {
  const person = buildPreset(PRESETS.find((x) => x.id === 'person'), { x: 0, y: 0 }, DEFAULT_STYLE);
  const g = person[0].groupId;
  assert.ok(g);
  for (const el of person) assert.equal(el.groupId, g);
});

test('searchPresets is accent- and case-insensitive', () => {
  assert.ok(searchPresets('decisao').some((p) => p.id === 'decision'));
  assert.ok(searchPresets('BANCO').some((p) => p.id === 'database'));
  assert.equal(searchPresets('').length, PRESETS.length);
  assert.equal(searchPresets('zzzz-nada').length, 0);
});

test('insertElements adds a preset as one undo step and selects it', () => {
  const els = buildPreset(PRESETS.find((x) => x.id === 'process'), { x: 0, y: 0 }, S().style);
  S().setTool('rect');
  actions.insertElements(els, 'library');
  assert.equal(S().tool, 'select');
  assert.equal(S().selection.size, 5);
  assert.equal(S().elements.length, 10);
  S().undo();
  assert.equal(S().elements.length, 5);
});
