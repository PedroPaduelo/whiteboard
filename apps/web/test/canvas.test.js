/**
 * canvas.test.js — the pure half of the canvas, under `node --test`.
 *
 * There is no DOM in node, which is the entire reason `hitTest`,
 * `interaction` and the geometry helpers are pure functions: the pointer
 * state machine and the hit regions can be asserted here, in milliseconds,
 * with no browser and no flaky rendering to wait on.
 *
 *   node --test apps/web/test/canvas.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boundsOfPoints,
  reboxPolyline,
  fitView,
  routeOrthogonal,
  rectFromDrag,
  pointInPolygon,
  connectorEndpoint,
  resolveConnectors,
  snapRect,
  tryValidateElement,
} from '@whiteboard/shared';

import {
  hitTest,
  hitTestAll,
  hitElement,
  hitTestConnectorEnd,
  elementsInSweep,
  selectionBounds,
} from '../src/canvas/hitTest.js';
import { reducePen, idleState as penIdle } from '../src/canvas/penInteraction.js';
import { wrapText, textLines } from '../src/canvas/shapes.js';
import { exportSVG, exportJSON, importJSON, exportBounds } from '../src/canvas/export.js';
import { presetDropBox, snapPresetBox, presetElementAt } from '../src/canvas/presetsGeometry.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const VIEW = { zoom: 1, panX: 0, panY: 0 };

const rect = (id, x, y, w, h, extra = {}) => ({
  id, type: 'rect', x, y, w, h, stroke: '#1f2937', strokeWidth: 2, fill: 'none', ...extra,
});

const diamond = (id, x, y, w, h, extra = {}) => ({
  id, type: 'diamond', x, y, w, h, stroke: '#1f2937', strokeWidth: 2, fill: 'none', ...extra,
});

const pen = (id, pts, extra = {}) => ({
  id, type: 'pen', ...boundsOfPoints(pts), points: pts, stroke: '#1f2937', strokeWidth: 4, ...extra,
});

/** A context for the reducer: fixed clock, deterministic ids, no randomness. */
function makeCtx(over = {}) {
  let n = 0;
  return {
    tool: 'select',
    style: { stroke: '#1f2937', fill: 'none', strokeWidth: 2, strokeStyle: 'solid', stickyFill: '#fde68a' },
    view: { ...VIEW },
    selection: new Set(),
    elements: [],
    gridSize: 0,
    snapEnabled: false,
    width: 1000,
    height: 800,
    now: 1_700_000_000_000,
    authorId: 'peer-test',
    newId: () => `t${++n}`,
    ...over,
  };
}


const count = (effects, type) => effects.filter((e) => e.type === type);

/* ================================================================== *
 * hitTest
 * ================================================================== */

test('hitTest: a rect is hit inside and missed outside', () => {
  const els = [rect('a', 100, 100, 200, 100, { fill: '#ffffff' })];
  assert.equal(hitTest(els, { x: 200, y: 150 }, { view: VIEW }), 'a', 'dead centre hits');
  assert.equal(hitTest(els, { x: 400, y: 150 }, { view: VIEW }), null, 'well outside misses');
});

test('hitTest: a transparent rect is grabbable in its BODY (outline and interior)', () => {
  // fill 'none' but it must still be clickable in the middle, or you can draw
  // a box and never be able to select it.
  const els = [rect('a', 100, 100, 200, 100)];
  assert.equal(els[0].fill, 'none');
  assert.equal(hitTest(els, { x: 200, y: 150 }, { view: VIEW }), 'a', 'interior of a transparent rect hits');
  // ...but a point just outside the outline does not.
  assert.equal(hitTest(els, { x: 200, y: 60 }, { view: VIEW }), null, 'outside the stroke misses');
});

test('hitTest: a diamond hits at its centre and MISSES in a corner of its bbox', () => {
  const els = [diamond('d', 100, 100, 200, 200, { fill: '#ffffff' })];
  // Centre: inside the diamond.
  assert.equal(hitTest(els, { x: 200, y: 200 }, { view: VIEW }), 'd', 'centre hits');
  // The bbox corner (100,100) is OUTSIDE the diamond — this is the case a
  // naive bounding-box test gets wrong, and the reason `pointInPolygon`
  // exists.
  assert.equal(hitTest(els, { x: 101, y: 101 }, { view: VIEW }), null, 'bbox corner must MISS');
  assert.equal(hitTest(els, { x: 299, y: 101 }, { view: VIEW }), null, 'top-right bbox corner must MISS');
  // A point on the diamond's left edge hits.
  assert.equal(hitTest(els, { x: 100, y: 200 }, { view: VIEW }), 'd', 'left vertex hits');
});

test('hitTest: a pen stroke hits near the line and misses far from it', () => {
  const els = [pen('p', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }])];
  assert.equal(hitTest(els, { x: 50, y: 1 }, { view: VIEW }), 'p', 'just off the first segment hits');
  assert.equal(hitTest(els, { x: 99, y: 60 }, { view: VIEW }), 'p', 'on the second segment hits');
  assert.equal(hitTest(els, { x: 50, y: 60 }, { view: VIEW }), null, 'diagonally away misses');
});

test('hitTest: tolerance is in SCREEN px and scales with zoom', () => {
  // A point 20 board units above a 100-unit rect.
  const els = [rect('a', 100, 100, 100, 100, { fill: '#ffffff' })];
  const p = { x: 150, y: 80 };
  // At zoom 1, 20 board units = 20 screen px > 6px tolerance -> miss.
  assert.equal(hitTest(els, p, { view: { zoom: 1 }, tolerance: 6 }), null);
  // At zoom 0.1, 20 board units = 2 screen px < 6px tolerance -> HIT. Without
  // the /zoom conversion selection would be impossible when zoomed out.
  assert.equal(hitTest(els, p, { view: { zoom: 0.1 }, tolerance: 6 }), 'a');
  // At zoom 4, the same 20 board units is 80 screen px -> miss again.
  assert.equal(hitTest(els, p, { view: { zoom: 4 }, tolerance: 6 }), null);
});

test('hitTest: rotation is handled — a rotated rect is tested in its own frame', () => {
  // 100x20 bar rotated 90 degrees about its centre: it now occupies a tall,
  // narrow region, and its ORIGINAL bounding box corners are empty.
  const bar = { ...rect('r', 0, 90, 100, 20, { fill: '#ffffff' }), rotation: Math.PI / 2 };
  const cx = 50;
  const cy = 100;
  // The bar's long axis is now vertical: (50, 55) and (50, 145) are on it.
  assert.equal(hitTest([bar], { x: cx, y: 55 }, { view: VIEW }), 'r', 'rotated bar is hit along its new axis');
  // (5, 95) was inside the unrotated box, but after the rotation it is empty.
  assert.equal(hitTest([bar], { x: 5, y: 95 }, { view: VIEW }), null, 'unrotated corner is empty after rotation');
});

test('hitTest: topmost wins', () => {
  const els = [rect('bottom', 0, 0, 100, 100, { fill: '#ffffff' }), rect('top', 0, 0, 100, 100, { fill: '#ffffff' })];
  assert.equal(hitTest(els, { x: 50, y: 50 }, { view: VIEW }), 'top');
});

test('hitTestAll: returns every hit, topmost first', () => {
  const els = [rect('a', 0, 0, 100, 100, { fill: '#ffffff' }), rect('b', 0, 0, 100, 100, { fill: '#ffffff' }), rect('c', 0, 0, 100, 100, { fill: '#ffffff' })];
  assert.deepEqual(hitTestAll(els, { x: 50, y: 50 }, { view: VIEW }), ['c', 'b', 'a']);
});

test('elementsInSweep: a marquee selects exactly what it intersects', () => {
  const els = [rect('in', 100, 100, 50, 50), rect('out', 500, 500, 50, 50)];
  const ids = elementsInSweep(els, { x: 90, y: 90, w: 80, h: 80 });
  assert.deepEqual(ids, ['in']);
});

test('elementsInSweep: a perfectly flat drag still selects (zero-area box)', () => {
  // A horizontal flick: h === 0. A plain rectsIntersect would return nothing
  // forever, which reads as "the marquee is broken".
  const els = [rect('a', 100, 100, 50, 50)];
  const ids = elementsInSweep(els, { x: 90, y: 125, w: 80, h: 0 });
  assert.deepEqual(ids, ['a'], 'a zero-height sweep still catches what it passed over');
});

test('hitTestConnectorEnd: dropping an arrow end on a shape attaches it', () => {
  const target = rect('box', 300, 300, 100, 100);
  const connector = { id: 'c', type: 'arrow', points: [{ x: 0, y: 0 }, { x: 300, y: 350 }] };
  // The end is right on the left edge of the box -> attaches.
  const hit = hitTestConnectorEnd([target, connector], connector, { x: 300, y: 350 }, 14, VIEW);
  assert.equal(hit.endId, 'box');
  assert.equal(hit.startId, undefined, 'the far end does not attach');
});

/* ================================================================== *
 * geometry
 * ================================================================== */

test('boundsOfPoints: a horizontal line has h === 0 and that is legal', () => {
  const b = boundsOfPoints([{ x: 0, y: 5 }, { x: 10, y: 5 }]);
  assert.deepEqual(b, { x: 0, y: 5, w: 10, h: 0 });
  assert.equal(b.h, 0, 'a flat line has zero height, not a negative one');
});

test('boundsOfPoints: empty and single-point inputs do not produce NaN', () => {
  assert.deepEqual(boundsOfPoints([]), { x: 0, y: 0, w: 0, h: 0 });
  assert.deepEqual(boundsOfPoints([{ x: 3, y: 7 }]), { x: 3, y: 7, w: 0, h: 0 });
});

test('reboxPolyline: the box always equals boundsOfPoints of the points', () => {
  const pts = [{ x: 5, y: 9 }, { x: -3, y: 40 }, { x: 22, y: -8 }];
  const el = reboxPolyline({ id: 'x', type: 'pen', points: pts, x: 999, y: 999, w: 1, h: 1 });
  assert.deepEqual(el, reboxPolyline({ id: 'x', type: 'pen', points: pts, x: 0, y: 0, w: 0, h: 0 }));
  assert.deepEqual({ x: el.x, y: el.y, w: el.w, h: el.h }, boundsOfPoints(pts));
});

test('rectFromDrag: normalises a drag up and to the left', () => {
  assert.deepEqual(rectFromDrag({ x: 100, y: 100 }, { x: 40, y: 30 }), { x: 40, y: 30, w: 60, h: 70 });
});

test('pointInPolygon: the four diamond corners are outside, the centre is inside', () => {
  const poly = [
    { x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 },
  ];
  assert.equal(pointInPolygon({ x: 50, y: 50 }, poly), true);
  assert.equal(pointInPolygon({ x: 1, y: 1 }, poly), false);
  assert.equal(pointInPolygon({ x: 99, y: 1 }, poly), false);
});

test('fitView: an empty board yields a usable, non-NaN view', () => {
  const v = fitView(null, { width: 1000, height: 800 });
  assert.ok(Number.isFinite(v.zoom) && Number.isFinite(v.panX) && Number.isFinite(v.panY));
  assert.ok(v.zoom > 0);
});

test('fitView: a single horizontal line (h === 0) does not divide by zero', () => {
  const v = fitView({ x: 0, y: 100, w: 400, h: 0 }, { width: 1000, height: 800 });
  assert.ok(Number.isFinite(v.zoom), 'zoom must be finite, not Infinity or NaN');
  assert.ok(Number.isFinite(v.panX) && Number.isFinite(v.panY));
});

test('fitView: real content is centred and fits', () => {
  const v = fitView({ x: 0, y: 0, w: 400, h: 200 }, { width: 1000, height: 800, padding: 0 });
  assert.ok(v.zoom <= 8 && v.zoom >= 0.05);
  // The content's centre lands on the viewport's centre.
  const cx = 0 + 400 / 2;
  const sx = cx * v.zoom + v.panX;
  assert.ok(Math.abs(sx - 500) < 1, `content centre should be at 500, got ${sx}`);
});

test('routeOrthogonal: with no obstacles it returns a simple Manhattan path', () => {
  const pts = routeOrthogonal({ x: 0, y: 0 }, { x: 100, y: 50 });
  assert.ok(pts.length >= 2);
  // Every segment is axis-aligned.
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    assert.ok(a.x === b.x || a.y === b.y, `segment ${i} is diagonal`);
  }
  // The true endpoints are preserved exactly.
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[pts.length - 1], { x: 100, y: 50 });
});

test('routeOrthogonal: routes AROUND an obstacle rather than through it', () => {
  const a = { x: 0, y: 50 };
  const b = { x: 200, y: 50 };
  // A wall directly between the two points.
  const wall = { x: 80, y: 0, w: 40, h: 100 };
  const pts = routeOrthogonal(a, b, { obstacles: [wall], clearance: 8 });
  assert.ok(pts.length > 2, 'a detour needs more than the straight L');
  // No vertex of the path may sit inside the wall.
  for (const p of pts) {
    const inside = p.x > wall.x && p.x < wall.x + wall.w && p.y > wall.y && p.y < wall.y + wall.h;
    assert.equal(inside, false, `path passes through the obstacle at ${JSON.stringify(p)}`);
  }
  assert.deepEqual(pts[0], a);
  assert.deepEqual(pts[pts.length - 1], b);
});

test('connectorEndpoint: lands on the nearer edge of the box', () => {
  const box = { x: 0, y: 0, w: 100, h: 100 };
  // Coming from the left -> hits the left edge at the mid-height.
  assert.deepEqual(connectorEndpoint(box, { x: -50, y: 50 }), { x: 0, y: 50 });
  // Coming from below -> hits the bottom edge.
  assert.deepEqual(connectorEndpoint(box, { x: 50, y: 200 }), { x: 50, y: 100 });
});

test('resolveConnectors: an attached arrow follows its box when the box moves', () => {
  const box = rect('box', 0, 0, 100, 100);
  const arrow = {
    id: 'a', type: 'arrow',
    x: 100, y: 50, w: 100, h: 0,
    points: [{ x: 100, y: 50 }, { x: 200, y: 50 }],
    startId: 'box', endId: undefined,
  };
  const before = resolveConnectors([box, arrow]);
  assert.deepEqual(before[1].points[0], { x: 100, y: 50 }, 'starts on the box right edge');

  // Move the box 300 to the right. The arrow's attached end must follow.
  const moved = rect('box', 300, 0, 100, 100);
  const after = resolveConnectors([moved, arrow]);
  assert.deepEqual(after[1].points[0], { x: 300, y: 50 }, 'the attached end rode the box');
  // The FREE end did not move — the user put it there.
  assert.deepEqual(after[1].points[1], { x: 200, y: 50 }, 'the free end stayed put');
  // And the box was re-derived from the moved points.
  assert.equal(after[1].x, 200);
  assert.equal(after[1].w, 100);
});
