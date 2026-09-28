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
import { actions, reorderIds, parseClipboard, serializeClipboard, CLIPBOARD_TYPE, fileBaseName } from '../src/editor/actions.js';
import { createElement, styleKeysFor } from '../src/editor/elements.js';
import { DEFAULT_STYLE, DUPLICATE_OFFSET, NUDGE_SHIFT } from '../src/editor/constants.js';
import { fitTextElement } from '../src/editor/text.js';
import { resolveConnectors } from '@whiteboard/shared';
import { PRESETS, PRESET_GROUPS, buildPreset, searchPresets, assertPresetsValid } from '../src/store/presets.js';
import { commonBounds } from '../src/editor/handles.js';

const S = () => useBoardStore.getState();

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
  assert.deepEqual(calls, [['commit', 'delete'], ['remove', ['x', 'y']], ['clear']]);
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
