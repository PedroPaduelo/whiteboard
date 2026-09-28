/**
 * Store invariants.
 *
 * These are not "does the code run" tests — each one pins a rule that the
 * canvas, flow and ui agents depend on and cannot check for themselves. If
 * `elements[index]` stops meaning z-order, or a deleted element leaves a
 * connector pointing at a ghost id, the app still renders; it renders
 * WRONG, in a way that is miserable to debug from a screenshot. So they are
 * asserted here, in the one place that can see the whole state.
 *
 * Plain `node --test` — the store imports no JSX, no React and no DOM.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { useBoardStore, initialState, applyOpsToElements, describeTransition, rebaseEntry, mergePatch } from './boardStore.js';
import { DEFAULT_STYLE } from '../editor/constants.js';

/** The store's actions, bound to a fresh reset. */
const s = () => useBoardStore.getState();

/** A minimal valid element. Every field the validator requires, no extras. */
function rect(id, x = 0, y = 0, w = 100, h = 50, extra = {}) {
  return { id, type: 'rect', x, y, w, h, stroke: '#1f2937', fill: 'none', ...extra };
}

function arrow(id, { startId, endId, x = 0, y = 0, w = 100, h = 0 } = {}) {
  return {
    id,
    type: 'arrow',
    x,
    y,
    w,
    h,
    points: [
      { x, y: y + h / 2 },
      { x: x + w, y: y + h / 2 },
    ],
    stroke: '#1f2937',
    fill: 'none',
    ...(startId ? { startId } : {}),
    ...(endId ? { endId } : {}),
  };
}

function pen(id, points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    id,
    type: 'pen',
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
    points,
    stroke: '#1f2937',
    fill: 'none',
  };
}

const ids = () => s().elements.map((el) => el.id);

test.beforeEach(() => {
  s().reset();
});

// --------------------------------------------------------------- basics

test('reset() returns exactly the initial state', () => {
  s().addElement(rect('a'));
  s().setTool('pen');
  s().setZoom(2);
  s().reset();

  const fresh = s();
  const base = initialState();
  for (const key of Object.keys(base)) {
    assert.deepEqual(fresh[key], base[key], `${key} should be back to its initial value`);
  }
});

test('addElement appends to the END of the array', () => {
  s().addElement(rect('a'));
  s().addElement(rect('b'));
  s().addElement(rect('c'));
  assert.deepEqual(ids(), ['a', 'b', 'c']);
});

test('addElements is one history entry for the whole batch', () => {
  s().commit('add');
  s().addElements([rect('a'), rect('b'), rect('c')]);
  assert.deepEqual(ids(), ['a', 'b', 'c']);
  s().undo();
  assert.deepEqual(ids(), [], 'a three-element batch is undone in one step');
});

test('element actions do NOT auto-commit (the caller commits first)', () => {
  // The canvas reducer emits `commit` and `addElement` as separate effects.
  // A hidden commit inside the action would add a second history entry per
  // gesture, so one Ctrl+Z would undo only half of it.
  s().commit('add');
  s().addElement(rect('a'));
  assert.equal(s().pastDepth, 1, 'exactly one entry from commit() alone');
  s().addElement(rect('b'));
  assert.equal(s().pastDepth, 1, 'a second add adds no history of its own');
});

// -------------------------------------------------------------- z-order

test('z-order invariant: elements[0] is the FURTHEST BACK', () => {
  s().addElement(rect('back'));
  s().addElement(rect('middle'));
  s().addElement(rect('front'));

  // The array IS the paint order. Index 0 first.
  assert.equal(s().elements[0].id, 'back');
  assert.equal(s().elements[2].id, 'front');

  // Bring 'back' to the front and it must land at the end.
  s().reorder(['middle', 'front', 'back']);
  assert.deepEqual(ids(), ['middle', 'front', 'back']);
  assert.equal(s().elements.at(-1).id, 'back');
});

test('addElement after a reorder still lands on top', () => {
  s().addElements([rect('a'), rect('b'), rect('c')]);
  s().reorder(['c', 'b', 'a']);
  s().addElement(rect('d'));
  assert.deepEqual(ids(), ['c', 'b', 'a', 'd']);
});

test('reorder keeps elements the caller forgot to mention', () => {
  s().addElements([rect('a'), rect('b'), rect('c')]);
  // 'c' is missing from the order — it must survive, not vanish.
  s().reorder(['b', 'a']);
  assert.deepEqual(ids(), ['b', 'a', 'c']);
});

test('reorder ignores unknown ids', () => {
  s().addElements([rect('a'), rect('b')]);
  s().reorder(['b', 'ghost', 'a']);
  assert.deepEqual(ids(), ['b', 'a']);
});

test('reorder never mutates the previous array in place', () => {
  s().addElements([rect('a'), rect('b')]);
  const before = s().elements;
  const snapshot = before.slice();
  s().reorder(['b', 'a']);
  assert.deepEqual(before.map((e) => e.id), snapshot.map((e) => e.id), 'old array untouched');
  assert.notEqual(s().elements, before, 'a new array is returned');
});

// -------------------------------------------------------------- updates

test('updateElement shallow-merges and leaves other fields alone', () => {
  s().addElement(rect('a', 0, 0, 100, 50, { fill: '#fde68a' }));
  s().updateElement('a', { x: 25 });
  const el = s().elements[0];
  assert.equal(el.x, 25);
  assert.equal(el.y, 0, 'untouched field survives');
  assert.equal(el.fill, '#fde68a', 'untouched style survives');
});

test('updateElement cannot change identity', () => {
  s().addElement(rect('a'));
  s().updateElement('a', { id: 'hijacked', type: 'ellipse' });
  assert.equal(s().elements[0].id, 'a', 'id is identity, not a patchable field');
  assert.equal(s().elements[0].type, 'rect');
});

test('updateElement REBOXES when points change (the pen-stroke invariant)', () => {
  s().addElement(pen('p', [{ x: 0, y: 0 }, { x: 10, y: 10 }]));
  assert.equal(s().elements[0].w, 10);

  // Append a point far away. Without a rebox the box stays at the old size
  // and the stroke becomes unselectable behind the ink.
  s().updateElement('p', { points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 200, y: 80 }] });
  const el = s().elements[0];
  assert.equal(el.x, 0);
  assert.equal(el.y, 0);
  assert.equal(el.w, 200, 'box width follows the new point');
  assert.equal(el.h, 80, 'box height follows the new point');
});

test('updateElement does NOT rebox for a non-polyline', () => {
  s().addElement(rect('a', 0, 0, 100, 50));
  // A rect's box IS the truth; a patch with a stale `points` key must not
  // overwrite x/y/w/h.
  s().updateElement('a', { w: 200, points: [{ x: 5, y: 5 }, { x: 6, y: 6 }] });
  assert.equal(s().elements[0].w, 200, 'the explicit box survives');
  assert.equal(s().elements[0].x, 0, 'a stray points key must not re-derive a rect box');
});

test('updateElements is ONE history entry for a multi-select drag', () => {
  s().commit('add');
  s().addElements([rect('a'), rect('b'), rect('c')]);
  s().undo(); // back to empty
  s().commit('add');
  s().addElements([rect('a'), rect('b'), rect('c')]);

  // Simulate a drag: 40 frames, 3 elements each, one commit per frame.
  for (let frame = 0; frame < 40; frame++) {
    s().commit('move');
    s().updateElements([
      { id: 'a', patch: { x: frame } },
      { id: 'b', patch: { x: frame } },
      { id: 'c', patch: { x: frame } },
    ]);
  }
  assert.equal(s().elements[0].x, 39, 'the last patch won');

  // 40 same-label commits in one gesture: coalesced, so ONE Ctrl+Z.
  s().undo();
  assert.equal(s().elements[0].x, 0, 'one Ctrl+Z undoes the whole drag, not one frame');
});

test('updateElements is a single render (array identity changes once)', () => {
  s().addElements([rect('a'), rect('b')]);
  const before = s().elements;
  s().updateElements([
    { id: 'a', patch: { x: 1 } },
    { id: 'b', patch: { y: 1 } },
  ]);
  assert.notEqual(s().elements, before);
  assert.equal(s().elements[0].x, 1);
  assert.equal(s().elements[1].y, 1);
});

// ------------------------------------------------------------- removals

test('removeElements deletes exactly the named ids', () => {
  s().addElements([rect('a'), rect('b'), rect('c')]);
  s().removeElements(['b']);
  assert.deepEqual(ids(), ['a', 'c']);
});

test('removing an element DETACHES connectors pointing at it', () => {
  s().addElements([
    rect('boxA', 0, 0, 100, 50),
    rect('boxB', 300, 0, 100, 50),
    arrow('link', { startId: 'boxA', endId: 'boxB' }),
  ]);

  s().removeElements(['boxA']);

  const link = s().elements.find((el) => el.id === 'link');
  assert.ok(link, 'the connector itself survives — it is still a line the user drew');
  assert.equal(link.startId, undefined, 'startId stripped: a ghost id is a permanent bug');
  assert.equal(link.endId, 'boxB', 'the other end is untouched');
});

test('removing the END target detaches endId only', () => {
  s().addElements([rect('a'), rect('b'), arrow('link', { startId: 'a', endId: 'b' })]);
  s().removeElements(['b']);
  const link = s().elements.find((el) => el.id === 'link');
  assert.equal(link.startId, 'a');
  assert.equal(link.endId, undefined);
});

test('a connector survives its anchors being gone, with NO dangling refs', () => {
  s().addElements([rect('a'), rect('b'), arrow('link', { startId: 'a', endId: 'b' })]);
  s().removeElements(['a', 'b']);
  const link = s().elements[0];
  assert.equal(link.id, 'link');
  assert.equal(link.startId, undefined);
  assert.equal(link.endId, undefined);
  // The real invariant: nothing anywhere on the board points at a dead id.
  const live = new Set(s().elements.map((el) => el.id));
  for (const el of s().elements) {
    if (el.startId) assert.ok(live.has(el.startId), `${el.id}.startId is live`);
    if (el.endId) assert.ok(live.has(el.endId), `${el.id}.endId is live`);
  }
});

test('remote delete detaches connectors the same way', () => {
  s().addElements([rect('a'), rect('b'), arrow('link', { startId: 'a', endId: 'b' })]);
  s().applyRemoteOp({ kind: 'delete', elementId: 'a' });
  assert.equal(s().elements.find((el) => el.id === 'link').startId, undefined);
});

// ------------------------------------------------------------- selection

test('select() only accepts ids that exist', () => {
  s().addElements([rect('a'), rect('b')]);
  s().select(['a', 'ghost']);
  assert.deepEqual(Array.from(s().selection), ['a']);
});

test('selection is PRUNED when an element is removed', () => {
  s().addElements([rect('a'), rect('b'), rect('c')]);
  s().select(['a', 'b', 'c']);
  assert.equal(s().selection.size, 3);

  s().removeElements(['b']);
  assert.equal(s().selection.size, 2, 'the deleted id left the selection');
  assert.ok(!s().selection.has('b'));
  assert.ok(s().selection.has('a') && s().selection.has('c'));
});

test('replaceAll prunes the selection too (the undo/redo path)', () => {
  s().addElements([rect('a'), rect('b')]);
  s().select(['a', 'b']);
  s().replaceAll([rect('a')]);
  assert.deepEqual(Array.from(s().selection), ['a'], 'b was pruned on the wholesale swap');
});

test('setSnapshot prunes the selection against the incoming board', () => {
  s().addElements([rect('local'), rect('other')]);
  s().select(['local', 'other']);
  assert.equal(s().selection.size, 2);

  // The server's board has 'other' but not 'local'.
  s().setSnapshot({ board: { id: 'b1' }, elements: [rect('other')], rev: 5 });
  assert.deepEqual(Array.from(s().selection), ['other'], 'the vanished id left the selection');
  assert.equal(s().rev, 5);
  assert.equal(s().canUndo, false, 'a resync must not be undoable');
});

test('hover and edit ids are cleared when their element dies', () => {
  s().addElement(rect('a'));
  s().setHovered('a');
  s().setEditing('a');
  s().removeElements(['a']);
  assert.equal(s().hoveredId, null);
  assert.equal(s().editingId, null);
});

test('toggleSelect adds then removes', () => {
  s().addElement(rect('a'));
  s().toggleSelect('a');
  assert.equal(s().selection.size, 1);
  s().toggleSelect('a');
  assert.equal(s().selection.size, 0);
});

test('additive select keeps the existing selection', () => {
  s().addElements([rect('a'), rect('b')]);
  s().select(['a']);
  s().select(['b'], { additive: true });
  assert.equal(s().selection.size, 2);
  s().select(['a']);
  assert.equal(s().selection.size, 1, 'a non-additive select replaces');
});

// --------------------------------------------------------------- history

test('commit snapshots BEFORE the mutation, so undo restores the old state', () => {
  s().commit('seed');
  s().addElement(rect('a'));
  s().commit('before-b');
  s().updateElement('a', { x: 999 });

  assert.equal(s().elements[0].x, 999, 'the mutation is live');
  s().undo();
  assert.equal(s().elements[0].x, 0, 'undo restored the pre-commit snapshot');
});

test('undo / redo round-trips', () => {
  // Distinct labels: two separate adds are two separate undo steps. (Two
  // 'add' commits inside 500ms would coalesce, which is the point of the
  // coalescing rule and is covered by its own test.)
  s().commit('add-a');
  s().addElement(rect('a'));
  s().commit('add-b');
  s().addElement(rect('b'));
  assert.equal(s().elements.length, 2);

  s().undo();
  assert.deepEqual(ids(), ['a']);
  s().undo();
  assert.deepEqual(ids(), []);

  assert.equal(s().canRedo, true);
  s().redo();
  assert.deepEqual(ids(), ['a']);
  s().redo();
  assert.deepEqual(ids(), ['a', 'b']);
  assert.equal(s().canRedo, false, 'the redo stack is exhausted');
});

test('undo on an empty history is a no-op', () => {
  s().undo();
  s().redo();
  assert.deepEqual(ids(), []);
  assert.equal(s().canUndo, false);
});

test('commits with the SAME label inside 500ms COALESCE into one entry', () => {
  s().commit('add');
  s().addElement(rect('a'));
  const depthBefore = s().pastDepth;

  // Three 'update' commits in a tight loop = one drag.
  for (let i = 0; i < 3; i++) {
    s().commit('update');
    s().updateElement('a', { x: i + 1 });
  }
  assert.equal(s().pastDepth, depthBefore + 1, 'three same-label commits merged into one entry');
});

test('commits with DIFFERENT labels do NOT coalesce', () => {
  s().commit('seed');
  s().addElement(rect('a'));
  const depthBefore = s().pastDepth;

  s().commit('add');
  s().addElement(rect('b'));
  s().commit('delete');
  s().removeElements(['b']);
  s().commit('style');
  s().updateElement('a', { x: 5 });

  assert.equal(s().pastDepth, depthBefore + 3, 'three distinct labels, three entries');
});

test('coalescing keeps the OLDER snapshot (the state before the gesture)', () => {
  s().commit('seed');
  s().addElement(rect('a', 0, 0, 100, 50));
  s().undo();
  s().commit('place');
  s().addElement(rect('a', 0, 0, 100, 50));

  s().commit('move');
  s().updateElement('a', { x: 10 });
  s().commit('move');
  s().updateElement('a', { x: 20 });
  s().commit('move');
  s().updateElement('a', { x: 30 });

  assert.equal(s().elements[0].x, 30);
  s().undo();
  assert.equal(s().elements[0].x, 0, 'undo jumps to before the FIRST move, not the last');
});

test('undo breaks coalescing — the next commit is a fresh entry', () => {
  s().commit('add');
  s().addElement(rect('a'));
  s().undo();
  s().commit('add');
  s().addElement(rect('a'));
  s().undo();
  s().commit('move');
  s().updateElement('a', { x: 1 });
  s().undo();
  const depth = s().pastDepth;

  // Same label as before the undo: must NOT merge into the consumed entry.
  s().commit('move');
  s().updateElement('a', { x: 2 });
  assert.equal(s().pastDepth, depth + 1);
});

test('a new commit clears the redo stack', () => {
  s().commit('add');
  s().addElement(rect('a'));
  s().commit('add');
  s().addElement(rect('b'));
  s().undo();
  assert.equal(s().canRedo, true);
  s().commit('edit');
  s().updateElement('a', { x: 1 });
  assert.equal(s().canRedo, false, 'you cannot redo into a diverged history');
});

test('history is bounded at 50 entries', () => {
  for (let i = 0; i < 80; i++) {
    // Distinct labels defeat coalescing so we actually exercise the bound.
    s().commit(`bulk-${i}`);
    s().addElement(rect(`e${i}`));
  }
  assert.equal(s().pastDepth, 50, 'the stack never exceeds HISTORY_LIMIT');
});

test('undo after the bound still restores something coherent', () => {
  s().commit('add');
  s().addElement(rect('base'));
  for (let i = 0; i < 60; i++) {
    s().commit(`add-${i}`);
    s().addElement(rect(`e${i}`));
  }
  s().undo();
  assert.equal(s().elements.at(-1).id, 'e58', 'the most recent change is undone first');
});

// ------------------------------------------------------------------ view

test('panBy is additive', () => {
  s().setPan(10, 20);
  s().panBy(5, -5);
  assert.deepEqual(s().view, { zoom: 1, panX: 15, panY: 15 });
});

test('panBy is never history', () => {
  s().commit('add');
  s().addElement(rect('a'));
  s().undo();
  s().commit('add');
  s().addElement(rect('a'));
  const depth = s().pastDepth;
  s().panBy(100, 100);
  s().setZoom(3);
  s().resetView();
  assert.equal(s().pastDepth, depth, 'view changes do not pollute history');
});

test('zoomAtScreen keeps the point under the cursor fixed', () => {
  s().setView({ zoom: 1, panX: 0, panY: 0 });
  const screenPt = { x: 400, y: 300 };
  const before = { x: 400, y: 300 }; // board coords at zoom 1, pan 0

  s().zoomAtScreen(screenPt, 2);

  const v = s().view;
  assert.equal(v.zoom, 2);
  // screenToBoard of the same screen point must still be the same board point.
  const bx = (screenPt.x - v.panX) / v.zoom;
  const by = (screenPt.y - v.panY) / v.zoom;
  assert.ok(Math.abs(bx - before.x) < 1e-6, `x drifted to ${bx}`);
  assert.ok(Math.abs(by - before.y) < 1e-6, `y drifted to ${by}`);
});

test('setZoom clamps to the zoom limits', () => {
  s().setZoom(1000);
  assert.ok(s().view.zoom <= 8, 'clamped to the max');
  s().setZoom(0.0001);
  assert.ok(s().view.zoom >= 0.05, 'clamped to the min');
});

test('fitToContent accepts an explicit viewport', () => {
  s().addElements([rect('a', 0, 0, 100, 100), rect('b', 900, 900, 100, 100)]);
  s().fitToContent({ vw: 1000, vh: 1000 });
  const v = s().view;
  assert.ok(v.zoom > 0 && v.zoom <= 8);
  // Content should be centred, so the pan should be near zero for a
  // symmetric layout around the viewport centre.
  assert.ok(Math.abs(v.panX) < 200, `panX should be small, got ${v.panX}`);
});

test('fitToContent on an empty board does not produce NaN', () => {
  s().fitToContent({ vw: 800, vh: 600 });
  for (const key of ['zoom', 'panX', 'panY']) {
    assert.ok(Number.isFinite(s().view[key]), `${key} must be a finite number`);
  }
});

test('resetView returns to the identity transform', () => {
  s().setView({ zoom: 3, panX: 50, panY: 60 });
  s().resetView();
  assert.deepEqual(s().view, { zoom: 1, panX: 0, panY: 0 });
});

// ----------------------------------------------------------------- peers

test('pruneCursors drops cursors older than the TTL', () => {
  s().upsertCursor('p1', { x: 1, y: 1, at: 1000 });
  s().upsertCursor('p2', { x: 2, y: 2, at: 5000 });

  s().pruneCursors(5000 + 29_000);
  assert.equal(s().remoteCursors.size, 1, 'the stale cursor went, the fresh one stayed');
  assert.ok(s().remoteCursors.has('p2'));
});

test('upsertCursor replaces rather than accumulates', () => {
  s().upsertCursor('p1', { x: 1, y: 1 });
  s().upsertCursor('p1', { x: 9, y: 9 });
  assert.equal(s().remoteCursors.size, 1);
  assert.equal(s().remoteCursors.get('p1').x, 9);
});

test('remoteCursors is a Map, not a plain object', () => {
  // The canvas iterates it with .entries(); a plain object would silently
  // iterate nothing and no cursor would ever be drawn.
  assert.ok(s().remoteCursors instanceof Map);
});

test('selection is a Set, not an array', () => {
  assert.ok(s().selection instanceof Set);
});

// -------------------------------------------------------------- identity

test('no action mutates the previous elements array in place', () => {
  s().addElements([rect('a'), rect('b'), rect('c')]);
  const first = s().elements;
  const idsOfFirst = first.map((e) => e.id);

  s().updateElement('a', { x: 5 });
  assert.deepEqual(first.map((e) => e.id), idsOfFirst, 'update left the old array alone');

  s().reorder(['c', 'b', 'a']);
  assert.deepEqual(first.map((e) => e.id), idsOfFirst, 'reorder left the old array alone');

  s().removeElements(['b']);
  assert.deepEqual(first.map((e) => e.id), idsOfFirst, 'remove left the old array alone');
});

test('setTool rejects a tool that does not exist', () => {
  s().setTool('pen');
  assert.equal(s().tool, 'pen');
  s().setTool('not-a-tool');
  assert.equal(s().tool, 'pen', 'an unknown tool is ignored, not stored');
});

test('setStyle merges without dropping the other keys', () => {
  s().setStyle({ stroke: '#ff0000' });
  const before = s().style.strokeWidth;
  s().setStyle({ strokeWidth: 8 });
  assert.equal(s().style.stroke, '#ff0000', 'the earlier change survived');
  assert.equal(s().style.strokeWidth, 8);
  assert.notEqual(before, 8, 'the width really changed');
});

test('subscribe fires on every mutation and can be torn down', () => {
  let calls = 0;
  const off = useBoardStore.subscribe(() => {
    calls += 1;
  });
  s().addElement(rect('a'));
  s().addElement(rect('b'));
  assert.ok(calls >= 2, 'the sync bridge would otherwise miss mutations');
  off();
  const settled = calls;
  s().addElement(rect('c'));
  assert.equal(calls, settled, 'unsubscribe actually stopped it');
});

test('the SAME label outside 500ms does NOT coalesce', async () => {
  s().commit('seed');
  s().addElement(rect('a'));
  s().undo();
  s().commit('place');
  s().addElement(rect('a'));
  const depthBefore = s().pastDepth;

  // Same label, but past the window. Must be a separate history entry —
  // otherwise two edits minutes apart would collapse into one Ctrl+Z.
  s().commit('edit');
  s().updateElement('a', { x: 1 });
  await new Promise((r) => setTimeout(r, 560));
  s().commit('edit');
  s().updateElement('a', { x: 2 });

  assert.equal(s().pastDepth, depthBefore + 2, 'the window really is a window');
});

// ============================================================ editor rewrite

test('initial state: Excalidraw defaults', () => {
  const st = s();
  assert.deepEqual(st.style, { ...DEFAULT_STYLE }, 'style starts from DEFAULT_STYLE');
  assert.notEqual(st.style, DEFAULT_STYLE, 'a copy, never the frozen constant');
  assert.equal(st.snapEnabled, false, 'grid mode is off by default');
  assert.equal(st.gridSize, 20);
  assert.equal(st.toolLocked, false);
  assert.deepEqual(st.viewportSize, { w: 0, h: 0 });
  assert.equal(st.connection, 'idle');
});

test('setTool clears editingId and, for drawing tools, the selection', () => {
  s().addElements([rect('a'), rect('b')]);
  s().select(['a', 'b']);
  s().setEditing('a');

  s().setTool('hand');
  assert.equal(s().editingId, null, 'any tool change ends the text edit');
  assert.equal(s().selection.size, 2, 'hand keeps the selection');

  s().setTool('select');
  assert.equal(s().selection.size, 2, 'select keeps the selection');

  s().setTool('rect');
  assert.equal(s().tool, 'rect');
  assert.equal(s().selection.size, 0, 'a drawing tool clears the selection');
});

test('setTool accepts the image tool and rejects unknown ones', () => {
  s().setTool('image');
  assert.equal(s().tool, 'image');
  s().setTool('laser-beam');
  assert.equal(s().tool, 'image');
});

test('tool lock toggles', () => {
  s().toggleToolLocked();
  assert.equal(s().toolLocked, true);
  s().setToolLocked(false);
  assert.equal(s().toolLocked, false);
});

test('setViewportSize stores CSS px and fitToContent uses it', () => {
  s().setViewportSize({ w: 1000, h: 1000 });
  assert.deepEqual(s().viewportSize, { w: 1000, h: 1000 });
  const same = s().viewportSize;
  s().setViewportSize({ w: 1000, h: 1000 });
  assert.equal(s().viewportSize, same, 'an unchanged size is not a store write');

  s().addElements([rect('a', 0, 0, 100, 100), rect('b', 900, 900, 100, 100)]);
  s().fitToContent();
  const byStore = { ...s().view };
  s().fitToContent({ vw: 1000, vh: 1000 });
  assert.deepEqual(s().view, byStore, 'no argument = the reported canvas size');
});

test('setConnection accepts only the realtime states', () => {
  s().setConnection('connected');
  assert.equal(s().connection, 'connected');
  s().setConnection('banana');
  assert.equal(s().connection, 'connected');
});

test('a null patch value DELETES the key (unbinding, leaving a group)', () => {
  s().addElements([rect('a'), rect('b'), arrow('link', { startId: 'a', endId: 'b' })]);
  s().updateElement('link', { startId: null });
  const link = s().elements.find((e) => e.id === 'link');
  assert.ok(!('startId' in link), 'the key is gone, not set to null');
  assert.equal(link.endId, 'b');

  s().updateElements([{ id: 'a', patch: { groupId: 'g' } }]);
  s().updateElements([{ id: 'a', patch: { groupId: null } }]);
  assert.ok(!('groupId' in s().elements[0]));
});

test('a patch that changes nothing keeps the element identity', () => {
  s().addElement(rect('a'));
  const before = s().elements;
  s().updateElement('a', { x: 0 });
  assert.equal(s().elements, before, 'no new array, no sync diff, no re-render');
  assert.equal(mergePatch(before[0], { y: 0, stroke: '#1f2937' }), before[0]);
});

test('a polyline re-boxes from its points even when only x/y were patched', () => {
  s().addElement(pen('p', [{ x: 0, y: 0 }, { x: 10, y: 10 }]));
  s().updateElement('p', { x: 500 });
  assert.equal(s().elements[0].x, 0, 'the server re-derives the box from points; so do we');
});

test('addElement ignores an id that is already on the board', () => {
  s().addElement(rect('a', 0));
  s().addElement(rect('a', 99));
  s().addElements([rect('a', 5), rect('b')]);
  assert.deepEqual(ids(), ['a', 'b']);
  assert.equal(s().elements[0].x, 0);
});

// --------------------------------------------------------- applyRemoteOps

test('applyRemoteOps applies a batch in order, then ONE connector pass', () => {
  s().addElements([rect('a', 0, 0, 100, 100), rect('b', 400, 0, 100, 100), arrow('link', { startId: 'a', endId: 'b', x: 100, y: 50, w: 300 })]);
  const before = s().elements.find((e) => e.id === 'link').points;

  let writes = 0;
  const off = useBoardStore.subscribe(() => (writes += 1));
  s().applyRemoteOps([
    { kind: 'update', elementId: 'b', patch: { y: 300 } },
    { kind: 'create', element: rect('c', 0, 600) },
    { kind: 'update', elementId: 'c', patch: { x: 10 } },
  ]);
  off();

  assert.equal(writes, 1, 'one store write for the whole batch');
  assert.deepEqual(ids(), ['a', 'b', 'link', 'c']);
  assert.equal(s().elements.find((e) => e.id === 'c').x, 10, 'a later op sees an earlier create');
  const after = s().elements.find((e) => e.id === 'link').points;
  assert.notDeepEqual(after, before, 'the bound arrow followed b, like the server does');
  assert.equal(s().pastDepth, 0, 'remote ops never create history');
});

test('applyRemoteOps: create is idempotent, update of a missing id is skipped', () => {
  s().addElement(rect('a', 0));
  const before = s().elements;
  s().applyRemoteOps([
    { kind: 'create', element: rect('a', 999) },
    { kind: 'update', elementId: 'ghost', patch: { x: 1 } },
  ]);
  assert.equal(s().elements, before, 'nothing changed, nothing written');
});

test('applyRemoteOps detaches a created connector bound to a missing element', () => {
  s().applyRemoteOps([{ kind: 'create', element: arrow('link', { startId: 'nowhere' }) }]);
  assert.ok(!('startId' in s().elements[0]));
});

test('applyRemoteOps: null patch deletes, delete prunes the selection, clear empties', () => {
  s().addElements([rect('a', 0, 0, 10, 10, { groupId: 'g' }), rect('b')]);
  s().select(['a', 'b']);
  s().applyRemoteOps([{ kind: 'update', elementId: 'a', patch: { groupId: null } }, { kind: 'delete', elementId: 'b' }]);
  assert.ok(!('groupId' in s().elements[0]));
  assert.deepEqual(Array.from(s().selection), ['a']);
  s().applyRemoteOps([{ kind: 'clear' }]);
  assert.deepEqual(ids(), []);
  assert.equal(s().selection.size, 0);
});

test('applyRemoteOps: reorder follows the server rule (unknown ids ignored, forgotten ones last)', () => {
  s().addElements([rect('a'), rect('b'), rect('c')]);
  s().applyRemoteOps([{ kind: 'reorder', order: ['c', 'ghost', 'a'] }]);
  assert.deepEqual(ids(), ['c', 'a', 'b']);
});

test('applyOpsToElements is pure and returns the same array for a no-op batch', () => {
  const els = [rect('a')];
  const res = applyOpsToElements(els, [{ kind: 'delete', elementId: 'zzz' }]);
  assert.equal(res.elements, els);
  const res2 = applyOpsToElements(els, [{ kind: 'update', elementId: 'a', patch: { x: 3 } }]);
  assert.equal(els[0].x, 0, 'input untouched');
  assert.equal(res2.elements[0].x, 3);
  assert.equal(res2.geometry, true);
});

// ------------------------------------------------------ history rebase

test('undo does not delete an element a peer created after the commit', () => {
  s().commit('add');
  s().addElement(rect('mine'));
  s().applyRemoteOps([{ kind: 'create', element: rect('theirs') }]);
  s().undo();
  assert.deepEqual(ids(), ['theirs']);
  s().redo();
  assert.deepEqual(ids(), ['mine', 'theirs'], 'redo restores mine in its old place');
});

test('undo keeps a remote change to another field and yields to a remote change of the same field', () => {
  s().addElement(rect('a'));
  s().commit('move:1');
  s().updateElement('a', { x: 50, y: 50 });
  s().applyRemoteOps([{ kind: 'update', elementId: 'a', patch: { stroke: '#e03131', y: 70 } }]);
  s().undo();
  const a = s().elements[0];
  assert.equal(a.x, 0, 'my x move is undone');
  assert.equal(a.y, 70, 'their later y wins over my undo');
  assert.equal(a.stroke, '#e03131', 'their colour survives');
});

test('undo does not resurrect an element a peer deleted', () => {
  s().addElements([rect('a'), rect('b')]);
  s().commit('move:2');
  s().updateElement('a', { x: 10 });
  s().applyRemoteOps([{ kind: 'delete', elementId: 'b' }]);
  s().undo();
  assert.deepEqual(ids(), ['a']);
  assert.equal(s().elements[0].x, 0);
});

test('undo skips commits that were never followed by a change', () => {
  s().commit('add');
  s().addElement(rect('a'));
  s().commit('click-without-drag'); // no mutation follows
  s().undo();
  assert.deepEqual(ids(), [], 'one Ctrl+Z undoes the add, not the empty entry');
  assert.equal(s().canUndo, false);
});

test('rebaseEntry: identity is preserved when the snapshot shares the element', () => {
  const a = rect('a');
  const b = rect('b');
  const entry = [a, b];
  const aNext = { ...a, x: 5 };
  const t = describeTransition([a, b], [aNext, b]);
  const rebased = rebaseEntry(entry, t);
  assert.equal(rebased[0], aNext, 'the very same object, so no-op detection works');
  assert.equal(rebased[1], b);
  assert.equal(rebaseEntry(entry, null), entry);
  assert.equal(describeTransition(entry, entry), null);
});

test('describeTransition detects a real reorder but not a create or delete', () => {
  const a = rect('a');
  const b = rect('b');
  const c = rect('c');
  assert.equal(describeTransition([a, b], [a, b, c]).order, null);
  assert.equal(describeTransition([a, b, c], [a, c]).order, null);
  assert.deepEqual(describeTransition([a, b], [b, a]).order, ['b', 'a']);
});

// -------------------------------------------------------------- snapshots

test('setSnapshot ignores a snapshot OLDER than the board already shows', () => {
  s().setSnapshot({ board: { id: 'b1' }, elements: [rect('new')], rev: 7 });
  s().setSnapshot({ board: { id: 'b1' }, elements: [rect('old')], rev: 3 });
  assert.deepEqual(ids(), ['new'], 'a late HTTP seed must not roll the board back');
  s().setSnapshot({ board: { id: 'b1' }, elements: [rect('old')], rev: 3 }, { force: true });
  assert.deepEqual(ids(), ['old']);
  s().setSnapshot({ board: { id: 'b2' }, elements: [rect('other')], rev: 1 });
  assert.deepEqual(ids(), ['other'], 'another board is always accepted');
});

test('resyncSnapshot re-applies pending ops and keeps (rebased) history on the same board', () => {
  s().setSnapshot({ board: { id: 'b1' }, elements: [rect('a')], rev: 1 });
  s().commit('move:3');
  s().updateElement('a', { x: 40 });
  // Server truth: a peer created 'p' and nobody has our move yet.
  s().resyncSnapshot(
    { board: { id: 'b1', title: 'T' }, elements: [rect('a'), rect('p')], rev: 5 },
    [{ kind: 'update', elementId: 'a', patch: { x: 40 } }],
  );
  assert.deepEqual(ids(), ['a', 'p']);
  assert.equal(s().elements[0].x, 40, 'our pending move is still visible');
  assert.equal(s().rev, 5);
  assert.equal(s().board.title, 'T');
  assert.equal(s().canUndo, true, 'a reconnect does not cost the user their history');
  s().undo();
  assert.deepEqual(ids(), ['a', 'p'], "undo keeps the peer's element");
  assert.equal(s().elements[0].x, 0);
});

test('resyncSnapshot keeps element identity for elements that did not change', () => {
  s().setSnapshot({ board: { id: 'b1' }, elements: [rect('a'), rect('b')], rev: 1 });
  const before = s().elements;
  s().resyncSnapshot({ board: { id: 'b1' }, elements: [rect('a'), rect('b')], rev: 2 });
  assert.equal(s().elements, before, 'fresh JSON with equal content changes nothing');
});

test('resyncSnapshot of ANOTHER board is a hydration (history wiped)', () => {
  s().setSnapshot({ board: { id: 'b1' }, elements: [], rev: 1 });
  s().commit('add');
  s().addElement(rect('a'));
  s().resyncSnapshot({ board: { id: 'b2' }, elements: [rect('z')], rev: 9 });
  assert.equal(s().boardId, 'b2');
  assert.deepEqual(ids(), ['z']);
  assert.equal(s().canUndo, false);
});

// ------------------------------------------------------------------ peers

test('setPeers drops the cursors of peers that left', () => {
  s().upsertCursor('p1', { x: 1, y: 1, name: 'Ana', color: '#e03131' });
  s().upsertCursor('p2', { x: 2, y: 2 });
  s().setPeers([{ id: 'me' }, { id: 'p1' }]);
  assert.deepEqual([...s().remoteCursors.keys()], ['p1']);
});

test('upsertCursor stores name and colour and keeps them on a bare move', () => {
  s().upsertCursor('p1', { x: 1, y: 1, name: 'Ana', color: '#e03131' });
  const mapBefore = s().remoteCursors;
  s().upsertCursor('p1', { x: 5, y: 6 });
  const cur = s().remoteCursors.get('p1');
  assert.equal(cur.name, 'Ana');
  assert.equal(cur.color, '#e03131');
  assert.equal(cur.x, 5);
  assert.notEqual(s().remoteCursors, mapBefore, 'a new Map, so useRemoteCursors re-renders');
});
