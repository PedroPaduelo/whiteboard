/**
 * board.test.js — the React Flow model layer.
 *
 * `model.js` is pure on purpose: no React, no DOM, no store. That is what
 * makes the riskiest part of the migration (element -> node -> element)
 * verifiable in node instead of by clicking around a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnectors } from '@whiteboard/shared';
import { validateElement } from '@whiteboard/shared';
import { SHORTCUTS as ALL_SHORTCUTS } from '../src/ui/shortcuts.js';
import {
  isEdgeElement,
  liveIdSet,
  minimapColorFor,
  toFlowNodes,
  toFlowEdges,
  boardSignature,
  planGestureEndPatches,
  NODE_ELEMENT_TYPES,
  POINTS_EPSILON,
} from '../src/flow/model.js';

const rect = (id, x = 0, y = 0, w = 100, h = 60, extra = {}) => ({
  id, type: 'rect', x, y, w, h, stroke: '#1f2937', strokeWidth: 2, fill: 'none', ...extra,
});
const arrow = (id, extra = {}) => ({
  id, type: 'arrow', x: 0, y: 0, w: 100, h: 0,
  points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], stroke: '#1f2937', strokeWidth: 2, ...extra,
});
const pen = (id) => ({
  id, type: 'pen', x: 0, y: 0, w: 20, h: 20,
  points: [{ x: 0, y: 0 }, { x: 20, y: 20 }], stroke: '#000', strokeWidth: 2,
});

/* ================================================================== *
 * isEdgeElement — the predicate that decides node vs edge
 * ================================================================== */

test('isEdgeElement: bound to two live elements is an edge', () => {
  const live = new Set(['a', 'b']);
  assert.equal(isEdgeElement(arrow('e', { startId: 'a', endId: 'b' }), live), true);
});

test('isEdgeElement: a free connector is a node', () => {
  assert.equal(isEdgeElement(arrow('e'), new Set(['a', 'b'])), false);
});

test('isEdgeElement: a HALF-bound connector is a node', () => {
  // The most common connector gesture in the product: drag one end onto a
  // box. An edge needs both ends, so this must never be one.
  assert.equal(isEdgeElement(arrow('e', { startId: 'a' }), new Set(['a', 'b'])), false);
  assert.equal(isEdgeElement(arrow('e', { endId: 'b' }), new Set(['a', 'b'])), false);
});

test('isEdgeElement: a dangling anchor makes it a node, not a broken edge', () => {
  // The box was deleted and the id was not cleared. An edge pointing at a
  // non-existent node is an error React Flow throws on.
  const live = new Set(['a']);
  assert.equal(isEdgeElement(arrow('e', { startId: 'a', endId: 'gone' }), live), false);
});

test('isEdgeElement: a `line` bound at both ends is an edge too', () => {
  const live = new Set(['a', 'b']);
  assert.equal(isEdgeElement(arrow('e', { type: 'line', startId: 'a', endId: 'b' }), live), true);
});

test('isEdgeElement: a non-connector is never an edge', () => {
  const live = new Set(['a', 'b']);
  for (const type of ['rect', 'sticky', 'text', 'pen', 'image', 'cylinder']) {
    assert.equal(isEdgeElement({ id: 'x', type, startId: 'a', endId: 'b' }, live), false, type);
  }
});

test('isEdgeElement: junk input is false, not a throw', () => {
  for (const bad of [null, undefined, {}, { type: 'arrow' }, 'arrow', 42]) {
    assert.equal(isEdgeElement(bad, new Set(['a', 'b'])), false);
  }
  assert.equal(isEdgeElement(arrow('e', { startId: 'a', endId: 'b' }), null), false);
});

/* ================================================================== *
 * toFlowNodes
 * ================================================================== */

test('toFlowNodes: every node type is produced', () => {
  for (const type of NODE_ELEMENT_TYPES) {
    const el = { id: 'n', type, x: 1, y: 2, w: 10, h: 10 };
    if (type === 'arrow' || type === 'line') el.points = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    if (type === 'sticky') el.label = 'hi';
    if (type === 'text') el.text = 'hi';
    if (type === 'image') el.src = 'https://x/y.png';
    const nodes = toFlowNodes([el]);
    assert.equal(nodes.length, 1, `${type} should be a node`);
    assert.equal(nodes[0].type, type);
  }
});

test('toFlowNodes: a pen stroke is NOT a node', () => {
  // A freehand stroke has no fixed box to lay out; it lives on the canvas
  // underlay. This is the one element type with no node.
  assert.equal(toFlowNodes([pen('p')]).length, 0);
});

test('toFlowNodes: a bound connector is not ALSO a node', () => {
  const els = [rect('a', 0, 0), rect('b', 200, 0), arrow('e', { startId: 'a', endId: 'b' })];
  const nodes = toFlowNodes(els);
  assert.equal(nodes.length, 2, 'two rects');
  assert.equal(nodes.some((n) => n.id === 'e'), false, 'the bound connector is an edge, not a node');
});

test('toFlowNodes: a half-bound connector IS a node', () => {
  const els = [rect('a'), arrow('e', { startId: 'a' })];
  const ids = toFlowNodes(els).map((n) => n.id);
  assert.deepEqual(ids.sort(), ['a', 'e']);
});

test('toFlowNodes: id and position round-trip EXACTLY', () => {
  // The migration's core invariant. Element x/y is the top-left of the
  // axis-aligned box, which is exactly React Flow's `position` — so there is
  // no coordinate conversion anywhere, and this test is what proves it.
  const el = rect('r', 137, -42, 200, 150);
  const [node] = toFlowNodes([el]);
  assert.equal(node.id, 'r');
  assert.equal(node.position.x, 137);
  assert.equal(node.position.y, -42);
  assert.equal(node.width, 200);
  assert.equal(node.height, 150);
  assert.deepEqual(node.style, { width: 200, height: 150 });
});

test('toFlowNodes: BOTH width/height and style are set', () => {
  // React Flow measures from the DOM. A node sized only by its content will
  // not match the store's w/h, and w/h is what the backend stores and what
  // export.js draws.
  const [node] = toFlowNodes([rect('r', 0, 0, 321, 123)]);
  assert.equal(node.width, 321);
  assert.equal(node.height, 123);
  assert.equal(node.style.width, 321);
  assert.equal(node.style.height, 123);
});

test('toFlowNodes: a negative w/h is clamped to zero, never passed through', () => {
  const [node] = toFlowNodes([rect('r', 0, 0, -5, -5)]);
  assert.equal(node.width, 0);
  assert.equal(node.height, 0);
});

test('toFlowNodes: overrides win over stored position during a drag', () => {
  const overrides = new Map([['r', { x: 500, y: 600 }]]);
  const [node] = toFlowNodes([rect('r', 10, 20)], { overrides });
  assert.equal(node.position.x, 500);
  assert.equal(node.position.y, 600);
});

test('toFlowNodes: selection and editing land in data', () => {
  const els = [rect('a'), rect('b')];
  const [a, b] = toFlowNodes(els, { selection: new Set(['a']), editingId: 'b' });
  assert.equal(a.data.selected, true);
  assert.equal(a.data.editing, false);
  assert.equal(b.data.selected, false);
  assert.equal(b.data.editing, true);
});

test('toFlowNodes: locked is not draggable', () => {
  const [node] = toFlowNodes([rect('r', 0, 0, 10, 10, { locked: true })]);
  assert.equal(node.draggable, false);
  assert.equal(node.data.locked, true);
});

test('toFlowNodes: an unlocked element IS draggable', () => {
  const [node] = toFlowNodes([rect('r')]);
  assert.equal(node.draggable, true);
});

test('toFlowNodes: z-order is preserved', () => {
  // Index in `elements` IS the z-order; React Flow paints in array order.
  const els = [rect('a'), rect('b'), rect('c')];
  assert.deepEqual(toFlowNodes(els).map((n) => n.id), ['a', 'b', 'c']);
});

test('toFlowNodes: a missing w/h degrades to 0, not NaN', () => {
  const [node] = toFlowNodes([{ id: 'x', type: 'rect', x: 0, y: 0 }]);
  assert.equal(node.width, 0);
  assert.equal(node.height, 0);
  assert.equal(Number.isNaN(node.position.x), false);
});

/* ================================================================== *
 * toFlowEdges
 * ================================================================== */

test('toFlowEdges: bound connector becomes an edge with source and target', () => {
  const els = [rect('a'), rect('b'), arrow('e', { startId: 'a', endId: 'b' })];
  const edges = toFlowEdges(els);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].source, 'a');
  assert.equal(edges[0].target, 'b');
});

test('toFlowEdges: the edge id is prefixed so it cannot collide with a node id', () => {
  // React Flow keeps nodes and edges in one map keyed by id.
  const els = [rect('a'), rect('b'), arrow('e', { startId: 'a', endId: 'b' })];
  const ids = [...toFlowNodes(els), ...toFlowEdges(els)].map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length, 'every id is unique');
  assert.equal(toFlowEdges(els)[0].id, 'edge:e');
});

test('toFlowEdges: an arrow gets a marker, a line does not', () => {
  // This is the whole reason markerEnd is conditional — `line` vs `arrow` has
  // to survive the round trip.
  const els = [
    rect('a'), rect('b'),
    arrow('ar', { startId: 'a', endId: 'b' }),
    arrow('li', { type: 'line', startId: 'a', endId: 'b' }),
  ];
  const byId = Object.fromEntries(toFlowEdges(els).map((e) => [e.data.elementId, e]));
  assert.ok(byId.ar.markerEnd, 'arrow has an arrowhead');
  assert.equal(byId.li.markerEnd, undefined, 'line has none');
});

test('toFlowEdges: a free or half-bound connector produces NO edge', () => {
  assert.equal(toFlowEdges([rect('a'), arrow('e', { startId: 'a' })]).length, 0);
  assert.equal(toFlowEdges([arrow('e')]).length, 0);
});

test('toFlowEdges: stroke and width carry over from the element', () => {
  const els = [rect('a'), rect('b'), arrow('e', { startId: 'a', endId: 'b', stroke: '#ef4444', strokeWidth: 5 })];
  const [edge] = toFlowEdges(els);
  assert.equal(edge.style.stroke, '#ef4444');
  assert.equal(edge.style.strokeWidth, 5);
});

test('toFlowEdges: dash style maps to a dasharray', () => {
  const mk = (strokeStyle) => [
    rect('a'), rect('b'),
    arrow('e', { startId: 'a', endId: 'b', strokeStyle }),
  ];
  assert.ok(toFlowEdges(mk('dashed'))[0].style.strokeDasharray);
  assert.ok(toFlowEdges(mk('dotted'))[0].style.strokeDasharray);
  assert.equal(toFlowEdges(mk('solid'))[0].style.strokeDasharray, undefined);
});

/* ================================================================== *
 * boardSignature — the gate that stops per-cursor re-renders
 * ================================================================== */

test('boardSignature: identical input gives an identical signature', () => {
  const els = [rect('a', 1, 2, 3, 4), stickyOrNull()];
  const n1 = toFlowNodes(els.filter(Boolean));
  const n2 = toFlowNodes(els.filter(Boolean));
  assert.equal(boardSignature(n1), boardSignature(n2));
});

function stickyOrNull() {
  return { id: 's', type: 'sticky', x: 0, y: 0, w: 80, h: 80, label: 'x', fill: '#fde68a' };
}

test('boardSignature: a position change DOES change it', () => {
  assert.notEqual(
    boardSignature(toFlowNodes([rect('a', 0, 0)])),
    boardSignature(toFlowNodes([rect('a', 1, 0)])),
  );
});

test('boardSignature: the fields the old signature missed', () => {
  // derive.js's old flowSignature covered label/hidden/locked/selected but
  // NOT type, dimensions or minimap colour — two boards differing in exactly
  // those reported "unchanged" and never re-rendered.
  const base = () => boardSignature(toFlowNodes([rect('a', 0, 0, 10, 10)]));
  assert.notEqual(base(), boardSignature(toFlowNodes([rect('a', 0, 0, 20, 10)])), 'dimensions');
  assert.notEqual(base(), boardSignature(toFlowNodes([rect('a', 0, 0, 10, 10, { fill: '#ff0000' })])), 'fill');
  assert.notEqual(
    base(),
    boardSignature(toFlowNodes([{ id: 'a', type: 'sticky', x: 0, y: 0, w: 10, h: 10, label: '', fill: 'none' }])),
    'type',
  );
});

test('boardSignature: selection is part of it', () => {
  const els = [rect('a')];
  assert.notEqual(
    boardSignature(toFlowNodes(els, { selection: new Set(['a']) })),
    boardSignature(toFlowNodes(els, { selection: new Set() })),
  );
});

test('boardSignature: edges are part of it', () => {
  const els = [rect('a'), rect('b'), arrow('e', { startId: 'a', endId: 'b' })];
  const withEdge = boardSignature(toFlowNodes(els), toFlowEdges(els));
  const without = boardSignature(toFlowNodes([rect('a'), rect('b')]), []);
  assert.notEqual(withEdge, without);
});

/* ================================================================== *
 * planGestureEndPatches — one commit, and only what moved
 * ================================================================== */

test('planGestureEndPatches: an empty drag writes nothing', () => {
  assert.deepEqual(planGestureEndPatches([], [rect('a')]), []);
  assert.deepEqual(planGestureEndPatches(null, [rect('a')]), []);
});

test('planGestureEndPatches: node patches are ABSOLUTE, not deltas', () => {
  // React Flow reports a position as a delta from the drag origin. Writing
  // that delta as an absolute position makes the node drift further from the
  // cursor on every move.
  const patches = planGestureEndPatches([{ id: 'a', position: { x: 150, y: 250 } }], [rect('a', 0, 0)]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].patch.x, 150);
  assert.equal(patches[0].patch.y, 250);
});

test('planGestureEndPatches: attached connectors follow, in the same batch', () => {
  const els = [
    rect('a', 0, 0, 100, 60),
    rect('b', 300, 0, 100, 60),
    arrow('e', { startId: 'a', endId: 'b' }),
  ];
  const patches = planGestureEndPatches([{ id: 'a', position: { x: 0, y: 120 } }], els, resolveConnectors);
  const edge = patches.find((p) => p.id === 'e');
  assert.ok(edge, 'the attached connector gets a patch');
  assert.ok(Array.isArray(edge.patch.points), 'it carries points, which is what the server re-derives the box from');
  // The end attached to `a` rode the box down. With both ends bound, each
  // points at the CENTRE of the other anchor and stops on the edge facing it:
  // `a` moved to y=120, so its bottom edge is y=120+60=180 and its centre
  // y=150, and the ray from that centre toward `b` leaves through the bottom
  // at y=180. The value is not magic — it is whatever that geometry yields.
  assert.equal(edge.patch.points[0].y, 130);
  // The other end is bound to `b`, which did not move.
  assert.equal(edge.patch.points[1].x, 300);
});

test('planGestureEndPatches: a connector whose anchor did NOT move writes nothing', () => {
  // The whole point: dragging one box among several must not resync every
  // arrow on the board. Only what actually changed goes over the wire.
  // `far` is not touched by this drag, so the arrow bound only to `far` must
  // produce NOTHING. The earlier version of this test used a self-loop
  // (`startId` and `endId` both `still`), which is a connector attached to the
  // same box at both ends — and when the dragged box is that box, the arrow
  // genuinely does move. The test was asserting the wrong thing.
  const els = [
    rect('mover', 0, 0, 100, 60),
    rect('still', 400, 0, 100, 60),
    rect('far', 800, 0, 100, 60),
    arrow('unrelated', { startId: 'far', endId: 'far' }),
    arrow('attached', { startId: 'mover', endId: 'still' }),
  ];
  // Same here: the store holds RESOLVED endpoints, so that is the baseline the
  // post-drag points get compared against.
  const stored = resolveConnectors(els);
  const patches = planGestureEndPatches([{ id: 'mover', position: { x: 0, y: 100 } }], stored, resolveConnectors);
  assert.equal(patches.filter((p) => p.id === 'unrelated').length, 0, 'the untouched arrow is silent');
  assert.equal(patches.filter((p) => p.id === 'attached').length, 1, 'the attached one follows');
});

test('planGestureEndPatches: a box with no connectors sends exactly one op', () => {
  const els = [rect('a', 0, 0, 100, 60), rect('b', 300, 0, 100, 60)];
  const patches = planGestureEndPatches([{ id: 'a', position: { x: 10, y: 10 } }], els, resolveConnectors);
  assert.equal(patches.length, 1);
});

test('planGestureEndPatches: a connector on an UNMOVED box writes nothing', () => {
  // The regression this guards is the expensive one: dragging one box on a
  // busy board must not resync every arrow on it. The baseline is the store's
  // RESOLVED state, which is what the store actually holds — `resolveConnectors`
  // returns a new array rather than mutating, so it is captured by return.
  const els = [
    rect('mover', 0, 0, 100, 60),
    rect('b', 300, 0, 100, 60),
    rect('leftAlone', 800, 0, 100, 60),
    rect('alsoAlone', 1100, 0, 100, 60),
    arrow('e', { startId: 'mover', endId: 'b' }),
    // Bound at BOTH ends to boxes this drag never touches.
    arrow('unrelated', { startId: 'leftAlone', endId: 'alsoAlone' }),
  ];
  const stored = resolveConnectors(els);

  const patches = planGestureEndPatches(
    [{ id: 'mover', position: { x: 0, y: 100 } }],
    stored,
    resolveConnectors,
  );
  assert.equal(patches.filter((p) => p.id === 'e').length, 1, 'the moved one follows');
  assert.equal(
    patches.filter((p) => p.id === 'unrelated').length,
    0,
    'an arrow bound only to untouched boxes produces no op at all',
  );
  // And the count is what matters: two nodes moved means two ops, not four.
  assert.equal(patches.length, 2, 'one op for the box, one for the arrow that followed it');
});

test('planGestureEndPatches: an arrow with NO anchors never moves', () => {
  // A free-floating connector is positioned by the user and has nothing to
  // follow. It is also the case a naive epsilon test gets wrong: a free arrow
  // keeps whatever points it was drawn with, forever.
  const els = [rect('a', 0, 0, 100, 60), arrow('free', { points: [{ x: 100, y: 0 }, { x: 300, y: 24 }] })];
  const stored = resolveConnectors(els);
  const patches = planGestureEndPatches([{ id: 'a', position: { x: 0, y: 400 } }], stored, resolveConnectors);
  assert.equal(patches.filter((p) => p.id === 'free').length, 0);
});

test('planGestureEndPatches: works without the resolver injected', () => {
  const patches = planGestureEndPatches([{ id: 'a', position: { x: 5, y: 5 } }], [rect('a')]);
  assert.equal(patches.length, 1);
});

/* ================================================================== *
 * minimapColorFor
 * ================================================================== */

test('minimapColorFor: a filled shape is identified by its fill', () => {
  assert.equal(minimapColorFor({ type: 'rect', fill: '#ff0000' }), '#ff0000');
  assert.equal(minimapColorFor({ type: 'sticky', fill: '#fde68a' }), '#fde68a');
});

test('minimapColorFor: an unfilled shape falls back to the outline token', () => {
  assert.equal(minimapColorFor({ type: 'rect', fill: 'none' }), 'var(--color-border-strong)');
  assert.equal(minimapColorFor(null), 'var(--color-border-strong)');
});

test('minimapColorFor: a connector uses its own stroke', () => {
  assert.equal(minimapColorFor({ type: 'arrow', stroke: '#3b82f6' }), '#3b82f6');
});

/* ================================================================== *
 * The invariant that matters most
 * ================================================================== */

test('ROUND TRIP: element -> node -> element preserves x/y/w/h exactly', () => {
  // Every one of these would be wrong if React Flow's position and the
  // store's box ever diverged — which is the migration's central risk.
  const originals = [
    rect('a', 0, 0, 100, 60),
    rect('b', 137, -42, 200, 150),
    { id: 'c', type: 'sticky', x: -500, y: 999.5, w: 80, h: 80, label: 'x', fill: '#fde68a' },
    { id: 'd', type: 'text', x: 12.25, y: 34.5, w: 300, h: 40, text: 'hi', fontSize: 24 },
    { id: 'e', type: 'cylinder', x: 5, y: 5, w: 120, h: 80 },
    { id: 'f', type: 'diamond', x: 7, y: 9, w: 90, h: 70 },
    { id: 'g', type: 'ellipse', x: 3, y: 4, w: 110, h: 90 },
  ];
  const nodes = toFlowNodes(originals);
  for (const n of nodes) {
    const src = originals.find((o) => o.id === n.id);
    assert.equal(n.position.x, src.x, `${n.id} x`);
    assert.equal(n.position.y, src.y, `${n.id} y`);
    assert.equal(n.width, src.w, `${n.id} w`);
    assert.equal(n.height, src.h, `${n.id} h`);
  }
});

test('ROUND TRIP: a node survives the SERVER validator unchanged', () => {
  // The node's data.element is the element itself. If that element were
  // rejected or stripped on the way back from the server, collaboration
  // would silently drop fields. `locked` was lost exactly this way once.
  const els = [
    rect('a', 1, 2, 30, 40, { locked: true }),
    { id: 's', type: 'sticky', x: 0, y: 0, w: 90, h: 90, label: 'note', fill: '#fde68a' },
    { id: 't', type: 'text', x: 0, y: 0, w: 200, h: 30, text: 'hello', fontSize: 18 },
  ];
  for (const el of els) {
    const clean = validateElement(el);
    assert.equal(clean.locked, el.locked, 'locked survives the server');
    assert.equal(clean.x, el.x);
    assert.equal(clean.w, el.w);
    assert.equal(clean.type, el.type);
  }
});


/* ================================================================== *
 * The delete path — the single most-reported bug
 * ================================================================== */

test('the Delete shortcut commits BEFORE removing, so it is undoable', () => {
  // The store's rule is commit-before-mutate. The delete shortcut violated it:
  // it called removeElements with no commit, so the elements disappeared and
  // nothing was pushed onto the undo stack — the delete could not be taken
  // back. Recording the ORDER is the point; a test that only asserted the
  // elements were gone would pass either way.
  const shortcuts = ALL_SHORTCUTS;
  const entry = shortcuts.find((c) => c.id === 'edit.delete');
  assert.ok(entry, 'the delete shortcut exists');

  const calls = [];
  const store = {
    getState: () => ({ selection: new Set(['a', 'b']) }),
    commit: (label) => calls.push(['commit', label]),
    removeElements: (ids) => calls.push(['removeElements', ids]),
    clearSelection: () => calls.push(['clearSelection']),
  };

  entry.handler({ store });

  assert.deepEqual(calls.map((c) => c[0]), ['commit', 'removeElements', 'clearSelection'],
    'commit must come first, or the delete leaves no undo entry');
  assert.equal(calls[0][1], 'delete');
  assert.deepEqual(calls[1][1], ['a', 'b']);
});

test('the Delete shortcut on an empty selection still clears it', () => {
  // A stale selection left behind after the elements are gone means the next
  // Delete acts on nothing at all.
  const shortcuts = ALL_SHORTCUTS;
  const entry = shortcuts.find((c) => c.id === 'edit.delete');
  const calls = [];
  entry.handler({
    store: {
      getState: () => ({ selection: new Set() }),
      commit: () => calls.push('commit'),
      removeElements: () => calls.push('remove'),
      clearSelection: () => calls.push('clear'),
    },
  });
  assert.deepEqual(calls, ['clear'], 'no commit, no remove, but the selection is cleared');
});
