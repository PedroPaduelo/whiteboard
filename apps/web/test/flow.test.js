/**
 * Tests for the two pieces of flow-layer logic that are easiest to get subtly
 * wrong and impossible to debug from the UI: the two-way ownership rule and
 * the drop coordinate conversion.
 *
 *   node --test apps/web/test/flow.test.js
 *
 * Both subjects were extracted into plain `.js` helpers (`src/flow/derive.js`
 * and `src/dnd/dropGeometry.js`) precisely so this file can exist: neither one
 * is reachable from a component test without a DOM, a store, and React Flow.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  absoluteFromDelta,
  acceptsStoreMove,
  beginInteraction,
  createInteractionOwner,
  deriveFlowNodes,
  endInteraction,
  flowSignature,
  isFlowElement,
  planMovePatches,
  reorderIds,
  selectFlowElements,
  shouldApplyPositionChange,
  toLayerOrder,
} from '../src/flow/derive.js';

import {
  boundsOfElements,
  buildDroppedElements,
  canvasCollisionDetection,
  CANVAS_DROPPABLE_ID,
  centerElementsAt,
  screenToBoard,
  snapPoint,
  viewportCentreToBoard,
} from '../src/dnd/dropGeometry.js';

import { tryValidateElement, tryValidateOps } from '@whiteboard/shared';

/* ========================================================================== *
 * 1. The two-way ownership rule — no feedback loop
 * ========================================================================== */

test('ownership: a flow drag claims the element and the store stops moving it', () => {
  const owner = createInteractionOwner();

  // Nothing happening: the store is free to move the nodes.
  assert.equal(acceptsStoreMove(owner), true);

  // A drag begins in the flow layer.
  assert.equal(beginInteraction(owner, 'flow'), true);
  assert.equal(owner.current, 'flow');

  // A canvas drag starting a frame later must NOT steal it.
  assert.equal(beginInteraction(owner, 'canvas'), false);
  assert.equal(owner.current, 'flow');

  // The canvas's update is ignored while the flow drag owns the interaction.
  assert.equal(acceptsStoreMove(owner), false, 'store move must be rejected mid-flow-drag');

  // The drag ends; the canvas may move things again.
  endInteraction(owner, 'flow');
  assert.equal(owner.current, null);
  assert.equal(acceptsStoreMove(owner), true);
});

test('ownership: the canvas owns its own drag and the flow layer only follows', () => {
  const owner = createInteractionOwner();

  assert.equal(beginInteraction(owner, 'canvas'), true);
  assert.equal(owner.current, 'canvas');
  // A canvas drag is allowed to move nodes: the canvas IS the source of truth.
  assert.equal(acceptsStoreMove(owner), true);
  // But a flow drag must not start in the middle of it.
  assert.equal(beginInteraction(owner, 'flow'), false);
  assert.equal(owner.current, 'canvas');
});

test('ownership: a stale release cannot end somebody else’s interaction', () => {
  const owner = createInteractionOwner();
  beginInteraction(owner, 'canvas');
  // The flow layer's drag-end arrives late, after a canvas drag took over.
  endInteraction(owner, 'flow');
  assert.equal(owner.current, 'canvas', 'a non-owner must not release the lock');
  endInteraction(owner, 'canvas');
  assert.equal(owner.current, null);
});

test('no feedback loop: a store-driven re-derivation never becomes a drag', () => {
  // This is the loop. The canvas moves the element, nodes re-derive, React Flow
  // reports the move back as a `position` change with `dragging: undefined`,
  // and if we acted on it the element would drift a frame at a time.
  const dragging = new Set();
  const programmatic = {
    type: 'position',
    id: 'frame-1',
    position: { x: 37, y: 12 },
    dragging: undefined,
  };
  assert.equal(shouldApplyPositionChange(programmatic, dragging), false);
  assert.deepEqual(planMovePatches([programmatic], () => ({ x: 0, y: 0 }), dragging), []);
});

test('no feedback loop: real drags accumulate on the origin frame by frame', () => {
  const dragging = new Set(['frame-1']);
  const origin = () => ({ x: 100, y: 200 });
  const running = new Map();
  const advance = (id, pos) => running.set(id, pos);

  // React Flow emits one change per frame and each `position` is THAT frame's
  // movement, measured from the origin — exactly what its own
  // `applyNodeChanges` does. So a 5px-per-frame drag is 5, 10, 15 from the
  // origin, never 5, 10, 25.
  const frame = { type: 'position', id: 'frame-1', position: { x: 5, y: 4 }, dragging: true };
  const seen = [1, 2, 3].map(() => planMovePatches([frame], origin, dragging, advance)[0]);
  assert.deepEqual(seen.map((p) => p.x), [105, 105, 105]);
  assert.deepEqual(seen.map((p) => p.y), [204, 204, 204]);
  assert.deepEqual(running.get('frame-1'), { x: 105, y: 204 });
});

test('no feedback loop: the synthetic drag-end total is origin-relative too', () => {
  // React's `dragging: false` change carries the TOTAL offset from the origin,
  // not one more frame. From (100,200), a total of (30,12) lands at (130,212).
  const dragging = new Set(['frame-1']);
  const total = [
    { type: 'position', id: 'frame-1', position: { x: 30, y: 12 }, dragging: false },
  ];
  assert.deepEqual(planMovePatches(total, () => ({ x: 100, y: 200 }), dragging, () => {}), [
    { id: 'frame-1', x: 130, y: 212 },
  ]);
});

test('no feedback loop: one patch per id, not one per event', () => {
  const dragging = new Set(['a', 'b']);
  const changes = [
    { type: 'position', id: 'a', position: { x: 1, y: 1 }, dragging: true },
    { type: 'position', id: 'a', position: { x: 2, y: 2 }, dragging: true },
    { type: 'position', id: 'b', position: { x: 3, y: 3 }, dragging: true },
  ];
  const patches = planMovePatches(
    changes,
    (id) => ({ x: 0, y: 0 }),
    dragging,
    () => {},
  );
  assert.deepEqual(patches, [
    { id: 'a', x: 1, y: 1 },
    { id: 'b', x: 3, y: 3 },
  ]);
});

test('no feedback loop: a drag-end for a drag we did not start is ignored', () => {
  // React Flow emits `dragging:false` for programmatic moves too. Acting on one
  // of those is what commits a phantom position to the store.
  const stranger = [{ type: 'position', id: 'frame-9', position: { x: 5, y: 5 }, dragging: false }];
  assert.deepEqual(planMovePatches(stranger, () => ({ x: 0, y: 0 }), new Set()), []);

  const mine = [{ type: 'position', id: 'frame-9', position: { x: 5, y: 5 }, dragging: false }];
  assert.deepEqual(
    planMovePatches(mine, () => ({ x: 1, y: 1 }), new Set(['frame-9'])),
    [{ id: 'frame-9', x: 6, y: 6 }],
  );
});

test('no feedback loop: select and remove changes are never position writes', () => {
  const changes = [
    { type: 'select', id: 'frame-1', selected: true },
    { type: 'remove', id: 'frame-1' },
    { type: 'dimensions', id: 'frame-1', dimensions: { width: 10, height: 10 } },
  ];
  assert.deepEqual(planMovePatches(changes, () => ({ x: 0, y: 0 }), new Set(['frame-1'])), []);
});

test('absoluteFromDelta tolerates a missing component', () => {
  assert.deepEqual(absoluteFromDelta({ x: 3 }, { x: 1, y: 2 }), { x: 4, y: 2 });
  assert.deepEqual(absoluteFromDelta({}, { x: 1, y: 2 }), { x: 1, y: 2 });
});

/* ========================================================================== *
 * 2. Drop coordinate conversion under a non-identity view
 * ========================================================================== */

const rectPreset = {
  id: 'rect',
  build: (box, style) => [
    {
      id: 'e1',
      type: 'rect',
      x: 0,
      y: 0,
      w: box?.w ?? 200,
      h: box?.h ?? 120,
      stroke: style?.stroke ?? '#000000',
      fill: 'none',
    },
  ],
};

test('screenToBoard inverts pan and zoom exactly', () => {
  const view = { zoom: 2.5, panX: -300, panY: 75 };
  assert.deepEqual(screenToBoard({ x: 0, y: 0 }, view), { x: 120, y: -30 });
  assert.deepEqual(screenToBoard({ x: 200, y: 325 }, view), { x: 200, y: 100 });

  // A degenerate zoom must not produce Infinity — it produces a no-op view.
  assert.deepEqual(screenToBoard({ x: 10, y: 10 }, { zoom: 0, panX: 0, panY: 0 }), { x: 10, y: 10 });
});

test('a preset dropped at zoom 2.5 with a pan lands on the right board units', () => {
  const view = { zoom: 2.5, panX: -300, panY: 75 };
  // Cursor at viewport (200, 325) -> board (200, 100).
  // The preset is 200x120, so it is CENTRED there: x = 100, y = 40.
  const els = buildDroppedElements({
    screenPoint: { x: 200, y: 325 },
    view,
    preset: rectPreset,
    style: { stroke: '#1f2937' },
  });
  assert.equal(els.length, 1);
  assert.equal(els[0].x, 100);
  assert.equal(els[0].y, 40);
  assert.equal(els[0].w, 200);
  assert.equal(els[0].h, 120);
  assert.equal(els[0].stroke, '#1f2937');
});

test('dropping at identity view is the identity — no surprise offset', () => {
  const view = { zoom: 1, panX: 0, panY: 0 };
  const els = buildDroppedElements({
    screenPoint: { x: 600, y: 400 },
    view,
    preset: { id: 'r', build: () => [{ id: 'e', type: 'rect', x: 0, y: 0, w: 100, h: 100 }] },
  });
  assert.deepEqual({ x: els[0].x, y: els[0].y }, { x: 550, y: 350 });
});

test('a multi-element preset is centred on the cursor and stays connected', () => {
  const preset = {
    id: 'flow',
    build: () => [
      { id: 'a', type: 'rect', x: 0, y: 0, w: 100, h: 50 },
      { id: 'b', type: 'rect', x: 200, y: 100, w: 100, h: 50 },
      { id: 'link', type: 'arrow', x: 100, y: 25, w: 100, h: 50, points: [{ x: 100, y: 25 }, { x: 200, y: 125 }] },
    ],
  };
  const els = buildDroppedElements({ screenPoint: { x: 500, y: 500 }, view: { zoom: 1, panX: 0, panY: 0 }, preset });

  // Bounds are 0,0 -> 300,150; centre is 150,75. Cursor 500,500 -> delta
  // 350,425.
  assert.deepEqual({ x: els[0].x, y: els[0].y }, { x: 350, y: 425 });
  assert.deepEqual({ x: els[1].x, y: els[1].y }, { x: 550, y: 525 });
  // The connector's endpoints move with it, or the arrow detaches.
  assert.deepEqual(els[2].points, [
    { x: 450, y: 450 },
    { x: 550, y: 550 },
  ]);
  // The ORIGINAL preset objects are not mutated.
  assert.equal(preset.build()[0].x, 0);
});

test('the viewport centre is resolved through the view, in board units', () => {
  const size = { width: 1200, height: 800 };
  const view = { zoom: 0.5, panX: 100, panY: -50 };
  // Centre of the viewport is (600,400) px -> (600-100)/0.5 = 1000, (400+50)/0.5 = 900.
  assert.deepEqual(viewportCentreToBoard(size, view), { x: 1000, y: 900 });
  // Click-to-place uses the same conversion as a drag.
  const els = buildDroppedElements({
    screenPoint: { x: 600, y: 400 },
    view,
    preset: { id: 'r', build: () => [{ id: 'e', type: 'rect', x: 0, y: 0, w: 100, h: 100 }] },
  });
  assert.deepEqual({ x: els[0].x, y: els[0].y }, { x: 950, y: 850 });
});

test('snap applies to the board point, after the conversion', () => {
  assert.deepEqual(snapPoint({ x: 37, y: 12 }, 20, true), { x: 40, y: 20 });
  assert.deepEqual(snapPoint({ x: 37, y: 12 }, 20, false), { x: 37, y: 12 });
  assert.deepEqual(snapPoint({ x: 37, y: 12 }, 0, true), { x: 37, y: 12 });
  const els = buildDroppedElements({
    screenPoint: { x: 1000, y: 1000 },
    view: { zoom: 2, panX: 0, panY: 0 },
    gridSize: 20,
    snapEnabled: true,
    preset: { id: 'r', build: () => [{ id: 'e', type: 'rect', x: 0, y: 0, w: 100, h: 100 }] },
  });
  // 1000/2 = 500 -> snaps to 500; minus half the box -> 450.
  assert.deepEqual({ x: els[0].x, y: els[0].y }, { x: 450, y: 450 });
});

test('a broken preset yields no elements rather than undefined ones', () => {
  assert.deepEqual(buildDroppedElements({ screenPoint: { x: 0, y: 0 }, view: null, preset: null }), []);
  assert.deepEqual(
    buildDroppedElements({ screenPoint: { x: 0, y: 0 }, view: null, preset: { id: 'x' } }),
    [],
  );
  assert.deepEqual(centerElementsAt([], { x: 0, y: 0 }), []);
  assert.deepEqual(boundsOfElements([]), { x: 0, y: 0, w: 0, h: 0 });
});

test('collision: pointerWithin wins, rectIntersection is the fallback', () => {
  const containers = [
    { id: CANVAS_DROPPABLE_ID, data: {} },
    { id: 'palette', data: {} },
  ];
  const rects = new Map([
    [CANVAS_DROPPABLE_ID, { left: 0, top: 0, width: 1200, height: 800 }],
    ['palette', { left: 10, top: 10, width: 220, height: 400 }],
  ]);

  // Pointer inside both: the canvas still wins, because it is the only thing
  // a preset may be dropped ON.
  const over = canvasCollisionDetection({
    droppableContainers: containers,
    droppableRects: rects,
    pointerCoordinates: { x: 100, y: 100 },
  });
  assert.deepEqual(over.map((c) => c.id), [CANVAS_DROPPABLE_ID]);

  // No pointer (a keyboard drag): fall through to rect intersection, which
  // still resolves the canvas.
  const noPointer = canvasCollisionDetection({
    droppableContainers: containers,
    droppableRects: rects,
    pointerCoordinates: null,
  });
  assert.ok(noPointer.length > 0);
  assert.ok(noPointer.some((c) => c.id === CANVAS_DROPPABLE_ID));
});

/* ========================================================================== *
 * 3. Node derivation filters to structural elements only
 * ========================================================================== */

const board = [
  { id: 'frame-1', type: 'rect', x: 0, y: 0, w: 400, h: 300, container: true, label: 'Auth flow' },
  { id: 'plain-1', type: 'rect', x: 10, y: 10, w: 80, h: 40 },
  { id: 'group-1', type: 'ellipse', x: 5, y: 5, w: 100, h: 60, group: true },
  { id: 'note-1', type: 'sticky', x: 1, y: 1, w: 90, h: 90, label: 'Idea' },
  { id: 'arrow-1', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [] },
  { id: 'pen-1', type: 'pen', x: 0, y: 0, w: 0, h: 0, points: [] },
  { id: 'flow-1', type: 'rect', x: 2, y: 3, w: 20, h: 20, flow: true },
];

test('only structural elements become nodes', () => {
  assert.equal(isFlowElement(board[0]), true, 'container: true');
  assert.equal(isFlowElement(board[1]), false, 'a bare rect is not structural');
  assert.equal(isFlowElement(board[2]), true, 'group: true');
  assert.equal(isFlowElement(board[3]), false, 'a bare sticky is not a cluster');
  assert.equal(isFlowElement(board[4]), false, 'connectors are edges, not nodes');
  assert.equal(isFlowElement(board[5]), false, 'pen strokes are not nodes');
  assert.equal(isFlowElement(board[6]), true, 'flow: true');
  assert.equal(isFlowElement(null), false);
  assert.equal(isFlowElement({}), false);

  assert.deepEqual(selectFlowElements(board).map((e) => e.id), ['frame-1', 'group-1', 'flow-1']);
});

test('the store selector overrides the built-in rule when it exists', () => {
  // Flavour A: the store hands back the structural elements themselves.
  const asList = (els) => els.filter((e) => e.type === 'sticky');
  const nodes = deriveFlowNodes(board, { selector: asList });
  assert.deepEqual(nodes.map((n) => n.id), ['note-1']);

  // Flavour B: it is a per-element predicate. An array has no `.type`, so the
  // list-shaped probe answers `false` and we fall through to filtering.
  const asPredicate = (el) => el.type === 'ellipse';
  const nodes2 = deriveFlowNodes(board, { selector: asPredicate });
  assert.deepEqual(nodes2.map((n2) => n2.id), ['group-1']);

  // A selector that is not a function is ignored, not crashed on.
  assert.equal(selectFlowElements(board, undefined).length, 3);
  assert.equal(selectFlowElements(board, 42).length, 3);

  // A selector that rejects the list probe entirely still works as a predicate.
  const awkward = (x) => {
    if (Array.isArray(x)) throw new TypeError('not a list selector');
    return x.id === 'flow-1';
  };
  assert.deepEqual(selectFlowElements(board, awkward).map((e) => e.id), ['flow-1']);
});

test('derived nodes carry position, size, type and the store selection', () => {
  const [frame] = deriveFlowNodes(board, { selection: new Set(['frame-1']) });
  assert.deepEqual(frame.position, { x: 0, y: 0 });
  assert.equal(frame.type, 'box');
  assert.equal(frame.width, 400);
  assert.equal(frame.height, 300);
  assert.equal(frame.data.elementId, 'frame-1');
  assert.equal(frame.data.label, 'Auth flow');
  assert.equal(frame.data.selected, true);
  // Selection and deletion belong to the canvas and the store, not to React Flow.
  assert.equal(frame.selectable, false);
  assert.equal(frame.deletable, false);
  assert.equal(frame.connectable, false);

  const [, group] = deriveFlowNodes(board);
  assert.equal(group.data.selected, false);
  // `group: true` is a structural region, drawn as a frame.
  assert.equal(group.type, 'box');
});

test('a live drag override wins over the stored position', () => {
  const overrides = new Map([['frame-1', { x: 55, y: 66 }]]);
  const [frame] = deriveFlowNodes(board, { overrides });
  assert.deepEqual(frame.position, { x: 55, y: 66 });
});

test('the signature changes only when a rendered field changes', () => {
  const a = deriveFlowNodes(board);
  const b = deriveFlowNodes(board.map((e) => ({ ...e }))); // new object identities, same data
  assert.equal(flowSignature(a), flowSignature(b), 'no re-render on an identity-only change');

  const moved = deriveFlowNodes(board.map((e) => (e.id === 'frame-1' ? { ...e, x: 1 } : e)));
  assert.notEqual(flowSignature(a), flowSignature(moved));

  const relabelled = deriveFlowNodes(board.map((e) => (e.id === 'frame-1' ? { ...e, label: 'Other' } : e)));
  assert.notEqual(flowSignature(a), flowSignature(relabelled));

  // Removing an element removes its node.
  const fewer = deriveFlowNodes(board.filter((e) => e.id !== 'frame-1'));
  assert.equal(fewer.some((n) => n.id === 'frame-1'), false);
});

/* ========================================================================== *
 * 4. Layer reordering produces the exact id order
 * ========================================================================== */

test('reorderIds moves one id and leaves the rest in order', () => {
  assert.deepEqual(reorderIds(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(reorderIds(['a', 'b', 'c', 'd'], 0, 3), ['b', 'c', 'd', 'a']);
  assert.deepEqual(reorderIds(['a', 'b', 'c', 'd'], 1, 2), ['a', 'c', 'b', 'd']);
  // No-ops, and out-of-range, are returned as a copy rather than a mutation.
  assert.deepEqual(reorderIds(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
  assert.deepEqual(reorderIds(['a', 'b', 'c'], -1, 0), ['a', 'b', 'c']);
  assert.deepEqual(reorderIds(['a', 'b', 'c'], 0, 9), ['a', 'b', 'c']);
  assert.deepEqual(reorderIds(null, 0, 1), []);

  const original = ['a', 'b', 'c'];
  reorderIds(original, 2, 0);
  assert.deepEqual(original, ['a', 'b', 'c'], 'the input array is never mutated');
});

test('the layer panel displays top-of-stack first and sends the store order back', () => {
  const elements = [
    { id: 'back', type: 'rect', x: 0, y: 0, w: 1, h: 1 },
    { id: 'mid', type: 'rect', x: 0, y: 0, w: 1, h: 1 },
    { id: 'front', type: 'rect', x: 0, y: 0, w: 1, h: 1 },
  ];
  // Display order is reversed: front of the stack at the top of the panel.
  assert.deepEqual(toLayerOrder(elements).map((e) => e.id), ['front', 'mid', 'back']);
  assert.deepEqual(elements.map((e) => e.id), ['back', 'mid', 'front'], 'store order untouched');

  // Dragging the top row down one slot, reversed back into the store's order.
  const display = ['front', 'mid', 'back'];
  const nextDisplay = reorderIds(display, 0, 1);
  assert.deepEqual(nextDisplay, ['mid', 'front', 'back']);
  assert.deepEqual(nextDisplay.slice().reverse(), ['back', 'front', 'mid']);
});

/* ========================================================================== *
 * 5. Does `locked` survive the server validator? (the honest answer)
 *
 * This test originally asserted the OPPOSITE — it measured that
 * `validateElement` silently dropped `locked`, and the layer panel's lock
 * toggle was therefore local-only state that no other peer would ever see.
 * That was reported to the coordinator and fixed: `locked` is now a
 * first-class field in packages/shared/src/validate.js. The test now pins
 * the fixed behaviour, because a lock that only one client knows about is a
 * toggle that lies to everyone else in the room.
 * ========================================================================== */

test('the server validator KEEPS `locked` — a lock only one client knows is not a lock', () => {
  const el = { id: 'e1', type: 'rect', x: 0, y: 0, w: 10, h: 10, locked: true };
  const res = tryValidateElement(el);
  assert.equal(res.valid, true);
  assert.equal(res.element.locked, true, 'locked survives validation');

  // Absent by default: the field is optional, not defaulted to false, so an
  // element that was never locked stays byte-identical on the wire.
  const bare = tryValidateElement({ id: 'e2', type: 'rect', x: 0, y: 0, w: 1, h: 1 });
  assert.equal('locked' in bare.element, false);

  // And a patch carries it rather than dropping it.
  const ops = tryValidateOps([
    { opId: 'o1', kind: 'update', elementId: 'e1', patch: { locked: true, opacity: 0 } },
  ]);
  assert.equal(ops.valid, true);
  assert.deepEqual(ops.ops[0].patch, { locked: true, opacity: 0 });

  // A non-boolean is still rejected, with the field path — the reason the
  // validator says no to one thing is the same reason it says no to others.
  const bad = tryValidateElement({ id: 'e3', type: 'rect', x: 0, y: 0, w: 1, h: 1, locked: 'sim' });
  assert.equal(bad.valid, false);
  assert.equal(bad.path, 'element.locked');
});

test('the fields the layer panel relies on DO survive', () => {
  // `opacity` is how a hidden layer is stored — it is patchable and survives,
  // which is why the panel hides with opacity rather than inventing a flag.
  const hidden = tryValidateElement({ id: 'e1', type: 'sticky', x: 0, y: 0, w: 1, h: 1, label: 'x', opacity: 0 });
  assert.equal(hidden.valid, true);
  assert.equal(hidden.element.opacity, 0);
});
