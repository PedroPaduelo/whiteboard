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
import { ZOOM_LIMITS } from '@whiteboard/shared';

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
  s().setView({ zoom: 1, panX: 0, panY: 0 });
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
  assert.equal(s().view.zoom, ZOOM_LIMITS.max, 'clamped to the max');
  s().setZoom(0.0001);
  assert.equal(s().view.zoom, ZOOM_LIMITS.min, 'clamped to the min');
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

test('setViewportSize stores CSS px and ignores an unchanged size', () => {
  s().setViewportSize({ w: 1000, h: 1000 });
  assert.deepEqual(s().viewportSize, { w: 1000, h: 1000 });
  const same = s().viewportSize;
  s().setViewportSize({ w: 1000, h: 1000 });
  assert.equal(s().viewportSize, same, 'an unchanged size is not a store write');
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

test('mergePatch: a fresh copy of the same points is NOT a change (identity kept)', () => {
  const ln = { id: 'ln', type: 'line', x: 100, y: 300, w: 300, h: 0, points: [{ x: 100, y: 300 }, { x: 400, y: 300 }] };
  assert.equal(mergePatch(ln, { points: ln.points.map((p) => ({ x: p.x, y: p.y })) }), ln);
  assert.equal(mergePatch(ln, { points: ln.points.map((p) => ({ ...p })), x: 100, y: 300 }), ln);
  assert.notEqual(mergePatch(ln, { points: [{ x: 100, y: 301 }, { x: 400, y: 300 }] }), ln);
});

test('undo of a polyline move stays correct while remote batches arrive during the drag', () => {
  // The sync bridge re-applies my unacked update (a fresh copy of the points)
  // under every remote batch. That used to be read as a REMOTE change and was
  // written into the undo snapshot, so Ctrl+Z left the line where it was dragged.
  for (const type of ['line', 'arrow', 'pen']) {
    s().reset();
    const ln = { id: 'ln', type, x: 100, y: 300, w: 300, h: 0, points: [{ x: 100, y: 300 }, { x: 400, y: 300 }], stroke: '#1e1e1e' };
    s().addElements([ln, rect('r')]);
    s().commit('move:g1');
    for (let f = 1; f <= 10; f++) {
      const cur = s().elements.find((e) => e.id === 'ln');
      s().updateElement('ln', { points: cur.points.map((p) => ({ x: p.x, y: p.y + 20 })) });
      const now = s().elements.find((e) => e.id === 'ln');
      const pending = [
        { kind: 'update', elementId: 'ln', patch: { points: now.points.map((p) => ({ x: p.x, y: p.y })), y: now.y } },
      ];
      if (f % 3 === 0) s().applyRemoteOps([{ kind: 'update', elementId: 'r', patch: { x: f } }], pending);
    }
    assert.equal(s().elements.find((e) => e.id === 'ln').y, 500, `${type}: dragged 200 down`);
    s().undo();
    assert.equal(s().elements.find((e) => e.id === 'ln').y, 300, `${type}: undo puts it back`);
    assert.equal(s().elements.find((e) => e.id === 'r').x, 9, `${type}: the peer's move survives`);
    s().redo();
    assert.equal(s().elements.find((e) => e.id === 'ln').y, 500, `${type}: redo drags it again`);
  }
});

test("undo after a peer restored an element in place keeps it there (remote creates keep their neighbours)", () => {
  // A draws X, B draws Y over it, A draws Z; B deletes X and undoes, which
  // ships create X + reorder X<Y<Z. A's Ctrl+Z must only remove Z.
  s().commit('add:x');
  s().addElement(rect('X'));
  s().applyRemoteOps([{ kind: 'create', element: rect('Y') }]);
  s().commit('add:z');
  s().addElement(rect('Z'));
  s().applyRemoteOps([{ kind: 'delete', elementId: 'X' }]);
  s().applyRemoteOps([{ kind: 'create', element: rect('X') }, { kind: 'reorder', order: ['X', 'Y', 'Z'] }]);
  assert.deepEqual(ids(), ['X', 'Y', 'Z']);
  s().undo();
  assert.deepEqual(ids(), ['X', 'Y'], 'X is not lifted above Y');
});

test('undo of my delete after a peer reordered restores the element in place', () => {
  s().addElements([rect('bottom'), rect('middle'), rect('top'), rect('far')]);
  s().commit('delete');
  s().removeElements(['middle']);
  s().applyRemoteOps([{ kind: 'reorder', order: ['far', 'bottom', 'top'] }]); // peer: "far" to back
  s().undo();
  assert.deepEqual(ids(), ['far', 'bottom', 'middle', 'top'], "middle back between its neighbours, the peer's move kept");
});

test('undo of my reorder keeps a peer create on top', () => {
  s().addElements([rect('a'), rect('b'), rect('c')]);
  s().commit('front');
  s().reorder(['a', 'c', 'b']);
  s().applyRemoteOps([{ kind: 'create', element: rect('d') }]);
  s().undo();
  assert.deepEqual(ids(), ['a', 'b', 'c', 'd']);
});

test('describeTransition: moved is the smallest set of survivors whose order changed', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => rect(id));
  assert.deepEqual([...describeTransition([a, b, c, d], [a, c, d, b]).moved], ['b'], 'bring b to front');
  assert.deepEqual([...describeTransition([a, b, c, d], [d, a, b, c]).moved], ['d'], 'send d to back');
  assert.equal(describeTransition([a, b], [a, b, c]).moved.size, 0);
  assert.deepEqual(describeTransition([a, b], [a, b, c]).next, ['a', 'b', 'c']);
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
  assert.notEqual(s().remoteCursors, mapBefore, 'a new Map, so a subscriber to remoteCursors re-renders');
});

// ------------------------------------------------- collaborators' selections

test("setPeerSelection stores a peer's selection with its colour; empty removes it", () => {
  s().setPeers([{ id: 'p1', name: 'Ana', color: '#e03131' }]);
  s().setPeerSelection('p1', { ids: ['a', 'b', 'a', 7, ''] });
  assert.ok(s().peerSelections instanceof Map, 'a Map: renderInteractive iterates its entries');
  assert.deepEqual(s().peerSelections.get('p1'), { ids: ['a', 'b'], color: '#e03131', name: 'Ana' });

  // A colour carried by the message wins over the roster's.
  s().setPeerSelection('p1', { ids: ['c'], color: '#2f9e44' });
  assert.equal(s().peerSelections.get('p1').color, '#2f9e44');

  s().setPeerSelection('p1', { ids: [] });
  assert.equal(s().peerSelections.size, 0, 'nothing selected, nothing drawn');
});

test('setPeerSelection with the same ids keeps the Map (no re-render per repeated message)', () => {
  s().setPeerSelection('p1', { ids: ['a'], color: '#e03131', name: 'Ana' });
  const before = s().peerSelections;
  s().setPeerSelection('p1', { ids: ['a'], color: '#e03131', name: 'Ana' });
  assert.equal(s().peerSelections, before);
  s().setPeerSelection('p1', { ids: ['a', 'b'], color: '#e03131', name: 'Ana' });
  assert.notEqual(s().peerSelections, before, 'a change is a new Map');
});

test('our own peer id never gets a peerSelections entry', () => {
  s().setMyPeerId('me');
  s().setPeerSelection('me', { ids: ['a'] });
  s().setPeers([{ id: 'me', selection: ['a'] }]);
  assert.equal(s().peerSelections.size, 0);
});

test('setPeers drops the selections of peers that left, and an empty roster drops them all', () => {
  s().setPeerSelection('p1', { ids: ['a'], color: '#e03131' });
  s().setPeerSelection('p2', { ids: ['b'], color: '#1971c2' });
  s().setPeers([{ id: 'p1', color: '#e03131' }]);
  assert.deepEqual([...s().peerSelections.keys()], ['p1']);
  assert.deepEqual(s().peerSelections.get('p1').ids, ['a'], 'a roster without `selection` keeps what we know');
  s().setPeers([]);
  assert.equal(s().peerSelections.size, 0, 'offline: nobody is selecting anything');
});

test("a roster that carries `selection` seeds it (a late joiner sees the others' selections)", () => {
  s().setPeers([
    { id: 'p1', name: 'Ana', color: '#e03131', selection: ['a', 'b'] },
    { id: 'p2', name: 'Bruno', color: '#1971c2', selection: [] },
  ]);
  assert.deepEqual([...s().peerSelections.keys()], ['p1']);
  assert.deepEqual(s().peerSelections.get('p1'), { ids: ['a', 'b'], color: '#e03131', name: 'Ana' });
  const before = s().peerSelections;
  s().setPeers([
    { id: 'p1', name: 'Ana', color: '#e03131', selection: ['a', 'b'] },
    { id: 'p2', name: 'Bruno', color: '#1971c2', selection: [] },
  ]);
  assert.equal(s().peerSelections, before, 'an unchanged roster keeps the Map');
  s().setPeers([{ id: 'p1', name: 'Ana', color: '#e03131', selection: [] }]);
  assert.equal(s().peerSelections.size, 0, "the server's record says p1 selects nothing now");
});

test('reset() clears the collaborators selections', () => {
  s().setPeerSelection('p1', { ids: ['a'] });
  s().reset();
  assert.equal(s().peerSelections.size, 0);
});
