/**
 * Geometry helpers the store depends on.
 *
 * The store's one geometric obligation is `resolveConnectors`: after any batch
 * that moves, resizes or deletes a shape, an arrow attached to that shape must
 * follow it and must be re-boxed from its new points. Everything else here is
 * the supporting cast (`boundsOfPoints`, `pointInPolygon`, `fitView`) that the
 * same code path leans on.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsOfPoints,
  resolveConnectors,
  pointInPolygon,
  fitView,
  diamondPolygon,
  rectPolygon,
  distToSegmentSq,
  unionRect,
  screenToBoard,
  boardToScreen,
} from '@whiteboard/shared';

const box = (over = {}) => ({ id: 'b', type: 'rect', x: 0, y: 0, w: 100, h: 100, ...over });
const arrow = (over = {}) => ({
  id: 'a', type: 'arrow', x: 0, y: 0, w: 0, h: 0,
  points: [{ x: -50, y: 50 }, { x: 0, y: 50 }], ...over,
});

describe('boundsOfPoints', () => {
  test('a single point has zero extent but keeps its position', () => {
    assert.deepEqual(boundsOfPoints([{ x: 3, y: 4 }]), { x: 3, y: 4, w: 0, h: 0 });
  });

  test('a horizontal line has h === 0 and is never degenerate to NaN', () => {
    assert.deepEqual(boundsOfPoints([{ x: 0, y: 5 }, { x: 10, y: 5 }]), { x: 0, y: 5, w: 10, h: 0 });
  });

  test('a vertical line has w === 0', () => {
    assert.deepEqual(boundsOfPoints([{ x: 2, y: 0 }, { x: 2, y: 9 }]), { x: 2, y: 0, w: 0, h: 9 });
  });

  test('an empty list is the empty rect, not a crash or NaN', () => {
    assert.deepEqual(boundsOfPoints([]), { x: 0, y: 0, w: 0, h: 0 });
  });

  test('a null/undefined list is the empty rect', () => {
    assert.deepEqual(boundsOfPoints(null), { x: 0, y: 0, w: 0, h: 0 });
    assert.deepEqual(boundsOfPoints(undefined), { x: 0, y: 0, w: 0, h: 0 });
  });

  test('negative coordinates are legal (the canvas is infinite)', () => {
    assert.deepEqual(
      boundsOfPoints([{ x: -30, y: -10 }, { x: -5, y: 20 }]),
      { x: -30, y: -10, w: 25, h: 30 },
    );
  });

  test('many points reduce to their extremes', () => {
    const pts = [
      { x: 5, y: 1 }, { x: -2, y: 9 }, { x: 11, y: 4 }, { x: 3, y: -6 },
    ];
    assert.deepEqual(boundsOfPoints(pts), { x: -2, y: -6, w: 13, h: 15 });
  });
});

describe('resolveConnectors', () => {
  test('moves the ATTACHED endpoint when its box moves, and reboxes the arrow', () => {
    const elements = [box(), arrow({ endId: 'b' })];

    const out = resolveConnectors(elements);
    const list = Array.isArray(out) ? out : elements;
    const link = list.find((e) => e.id === 'a');

    // The arrow approached from the left and rested on the box's left edge.
    assert.deepEqual(link.points[1], { x: 0, y: 50 }, 'starts on the left edge');

    // Now move the box to x 300, y 200 (still 100x100, so y span 200..300).
    list[0].x = 300;
    list[0].y = 200;
    const out2 = resolveConnectors(list);
    const list2 = Array.isArray(out2) ? out2 : list;
    const moved = list2.find((e) => e.id === 'a');
    const end = moved.points[1];

    assert.equal(end.x, 300, 'the attached end followed the box to its new left edge');
    assert.ok(end.y >= 200 && end.y <= 300, `and stayed on that edge, got y=${end.y}`);
    assert.deepEqual(moved.points[0], { x: -50, y: 50 }, 'the FREE end did not move');

    // The arrow's own box is re-derived from its new points.
    const xs = moved.points.map((p) => p.x);
    const ys = moved.points.map((p) => p.y);
    assert.equal(moved.x, Math.min(...xs));
    assert.equal(moved.y, Math.min(...ys));
    assert.equal(moved.w, Math.max(...xs) - Math.min(...xs));
    assert.equal(moved.h, Math.max(...ys) - Math.min(...ys));
  });

  test('is idempotent: resolving twice changes nothing the second time', () => {
    const list = [box(), arrow({ endId: 'b' })];
    const once = resolveConnectors(list);
    const a = Array.isArray(once) ? once : list;
    const snapshot = JSON.stringify(a);
    const twice = resolveConnectors(a);
    const b = Array.isArray(twice) ? twice : a;
    assert.equal(JSON.stringify(b), snapshot);
  });

  test('a connector with no attachment keeps its own points', () => {
    const list = [box(), arrow()];
    const out = resolveConnectors(list);
    const list2 = Array.isArray(out) ? out : list;
    const free = list2.find((e) => e.id === 'a');
    assert.deepEqual(free.points, [{ x: -50, y: 50 }, { x: 0, y: 50 }]);
  });

  test('a line follows its box the same way an arrow does', () => {
    const list = [
      box(),
      { id: 'l', type: 'line', x: 0, y: 0, w: 0, h: 0,
        points: [{ x: -50, y: 50 }, { x: 0, y: 50 }], startId: 'b' },
    ];
    const out = resolveConnectors(list);
    const list2 = Array.isArray(out) ? out : list;
    list2[0].x = 400;
    const out2 = resolveConnectors(list2);
    const list3 = Array.isArray(out2) ? out2 : list2;
    const line = list3.find((e) => e.id === 'l');
    // The attached end now rests on the box's new left edge (x=400) rather than
    // the old one (x=0): the line followed its box just as the arrow did.
    assert.equal(line.points[0].x, 400);
    assert.equal(line.points[0].y, 50);
    assert.deepEqual(line.points[1], { x: 0, y: 50 }, 'the free end stayed put');
  });

  test('an attachment to a box that is NOT in the list is left alone', () => {
    const list = [arrow({ endId: 'ghost' })];
    const out = resolveConnectors(list);
    const list2 = Array.isArray(out) ? out : list;
    const orphan = list2.find((e) => e.id === 'a');
    assert.deepEqual(orphan.points, [{ x: -50, y: 50 }, { x: 0, y: 50 }],
      'a dangling endId must not snap the arrow to the origin');
  });

  test('an empty or invalid list is a no-op, never a throw', () => {
    assert.deepEqual(resolveConnectors([]), []);
    assert.deepEqual(resolveConnectors(null), []);
    assert.deepEqual(resolveConnectors(undefined), []);
  });

  test('every point stays finite after a batch of moves', () => {
    const list = [box(), arrow({ endId: 'b' })];
    for (const [x, y] of [[300, 200], [-900, 45], [0, -12.5]]) {
      list[0].x = x;
      list[0].y = y;
      const out = resolveConnectors(list);
      const l = Array.isArray(out) ? out : list;
      const link = l.find((e) => e.id === 'a');
      for (const p of link.points) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'no NaN leaks into points');
      }
    }
  });
});

describe('pointInPolygon', () => {
  const diamond = diamondPolygon({ x: 0, y: 0, w: 100, h: 100 });

  test('HIT: the centre of a diamond is inside', () => {
    assert.equal(pointInPolygon({ x: 50, y: 50 }, diamond), true);
  });

  test('HIT: a point in the middle of a diamond arm is inside', () => {
    assert.equal(pointInPolygon({ x: 50, y: 10 }, diamond), true, 'near the top vertex');
    assert.equal(pointInPolygon({ x: 50, y: 90 }, diamond), true, 'near the bottom vertex');
  });

  test('MISS: the bounding-box corner is OUTSIDE the diamond', () => {
    // This is the whole reason a diamond needs its own hit test: the corner
    // (0,0) is inside the rect but outside the diamond.
    assert.equal(pointInPolygon({ x: 0, y: 0 }, diamond), false);
    assert.equal(pointInPolygon({ x: 100, y: 0 }, diamond), false);
    assert.equal(pointInPolygon({ x: 0, y: 100 }, diamond), false);
    assert.equal(pointInPolygon({ x: 100, y: 100 }, diamond), false);
  });

  test('MISS: a point clearly outside the box is outside', () => {
    assert.equal(pointInPolygon({ x: -10, y: 50 }, diamond), false);
    assert.equal(pointInPolygon({ x: 150, y: 50 }, diamond), false);
  });

  test('a point inside the diamond but outside the rect is impossible', () => {
    for (let x = -20; x <= 120; x += 10) {
      for (let y = -20; y <= 120; y += 10) {
        const inside = pointInPolygon({ x, y }, diamond);
        if (!inside) continue;
        assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 100,
          `(${x},${y}) is inside the diamond so it must be inside the rect`);
      }
    }
  });

  test('works on a plain rectangle polygon too', () => {
    const r = rectPolygon({ x: 10, y: 10, w: 30, h: 20 });
    assert.equal(pointInPolygon({ x: 20, y: 20 }, r), true);
    assert.equal(pointInPolygon({ x: 5, y: 20 }, r), false);
  });
});

describe('fitView', () => {
  const viewport = { width: 800, height: 600, padding: 0 };

  test('empty input returns a finite, centred view — never NaN', () => {
    for (const empty of [null, undefined, { x: 0, y: 0, w: 0, h: 0 }]) {
      const v = fitView(empty, viewport);
      assert.ok(Number.isFinite(v.zoom), 'zoom is finite');
      assert.ok(Number.isFinite(v.panX) && Number.isFinite(v.panY), 'pan is finite');
      assert.equal(v.zoom, 1, 'and does not zoom into nothing');
    }
  });

  test('content zooms to fit and stays inside the zoom clamp', () => {
    const v = fitView({ x: 0, y: 0, w: 100, h: 50 }, { ...viewport, max: 8 });
    assert.equal(v.zoom, 8, '100x50 into 800x600 is limited by the max clamp');
    assert.ok(Number.isFinite(v.panX) && Number.isFinite(v.panY));
  });

  test('content is centred: the midpoint of the bounds lands mid-viewport', () => {
    const bounds = { x: 0, y: 0, w: 100, h: 100 };
    const v = fitView(bounds, { ...viewport, min: 0, max: 100 });
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    const onScreen = boardToScreen({ x: cx, y: cy }, v);
    assert.ok(Math.abs(onScreen.x - 400) <= 1, `centred in x, got ${onScreen.x}`);
    assert.ok(Math.abs(onScreen.y - 300) <= 1, `centred in y, got ${onScreen.y}`);
  });

  test('a horizontal line (h === 0) does not divide by zero', () => {
    const v = fitView({ x: 0, y: 7, w: 100, h: 0 }, viewport);
    assert.ok(Number.isFinite(v.zoom) && Number.isFinite(v.panY));
    assert.equal(v.zoom, 1);
  });

  test('padding is honoured (less room, less zoom)', () => {
    const bounds = { x: 0, y: 0, w: 100, h: 100 };
    const tight = fitView(bounds, { width: 800, height: 600, padding: 0, min: 0, max: 100 });
    const loose = fitView(bounds, { width: 800, height: 600, padding: 200, min: 0, max: 100 });
    assert.ok(loose.zoom < tight.zoom, 'padding shrinks the usable area');
  });
});

describe('supporting helpers', () => {
  test('distToSegmentSq is zero on the segment and positive off it', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    assert.equal(distToSegmentSq({ x: 5, y: 0 }, a, b), 0, 'on the segment');
    assert.equal(distToSegmentSq({ x: 5, y: 3 }, a, b), 9, 'perpendicular distance squared');
    assert.equal(distToSegmentSq({ x: -5, y: 0 }, a, b), 25, 'clamps to the start');
  });

  test('distToSegmentSq handles a zero-length segment', () => {
    const p = { x: 3, y: 4 };
    assert.equal(distToSegmentSq(p, { x: 0, y: 0 }, { x: 0, y: 0 }), 25);
  });

  test('unionRect spans both boxes', () => {
    assert.deepEqual(
      unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }),
      { x: 0, y: 0, w: 30, h: 15 },
    );
  });

  test('screenToBoard and boardToScreen round-trip', () => {
    const view = { zoom: 2, panX: 10, panY: -5 };
    const screen = { x: 34, y: 78 };
    const back = boardToScreen(screenToBoard(screen, view), view);
    assert.ok(Math.abs(back.x - screen.x) < 1e-9);
    assert.ok(Math.abs(back.y - screen.y) < 1e-9);
  });
});
