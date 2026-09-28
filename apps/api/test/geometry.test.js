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
  connectorEndpoint,
  connectorMidpoint,
  detachMissingConnectors,
  BIND_GAP,
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

/** Tolerant point compare: rotation math is exact only to a few ulps. */
function near(actual, expected, msg, eps = 1e-9) {
  assert.ok(
    Math.abs(actual.x - expected.x) <= eps && Math.abs(actual.y - expected.y) <= eps,
    `${msg ?? 'point'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/** Distance from p to the element's outline along the centre ray, signed: +outside. */
function outsideBy(el, p) {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const r = el.rotation || 0;
  // Into the element's frame.
  const c = Math.cos(-r);
  const s = Math.sin(-r);
  const dx = (p.x - cx) * c - (p.y - cy) * s;
  const dy = (p.x - cx) * s + (p.y - cy) * c;
  const len = Math.hypot(dx, dy);
  const hx = el.w / 2;
  const hy = el.h / 2;
  let t;
  if (el.type === 'ellipse') t = 1 / Math.sqrt((dx / hx) ** 2 + (dy / hy) ** 2);
  else if (el.type === 'diamond') t = 1 / (Math.abs(dx) / hx + Math.abs(dy) / hy);
  else t = Math.min(Math.abs(dx) < 1e-12 ? Infinity : hx / Math.abs(dx), Math.abs(dy) < 1e-12 ? Infinity : hy / Math.abs(dy));
  return len - t * len;
}

/** A tiny deterministic PRNG, so a failing random case is reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
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

    // The arrow approached from the left and rests BIND_GAP short of the
    // box's left edge, so the arrowhead never overlaps the stroke.
    assert.equal(BIND_GAP, 4);
    assert.deepEqual(link.points[1], { x: -BIND_GAP, y: 50 }, 'starts just outside the left edge');

    // Now move the box to x 300, y 200 (still 100x100, so y span 200..300).
    list[0].x = 300;
    list[0].y = 200;
    const out2 = resolveConnectors(list);
    const list2 = Array.isArray(out2) ? out2 : list;
    const moved = list2.find((e) => e.id === 'a');
    const end = moved.points[1];

    // It aims at the free end (-50, 50): it crosses the new left edge (x=300)
    // and stops BIND_GAP further out ALONG that ray, so just left of x=300.
    assert.ok(end.x < 300 && end.x >= 300 - BIND_GAP, `the attached end followed the box to its new left edge, got x=${end.x}`);
    assert.ok(Math.abs(outsideBy(list2[0], end) - BIND_GAP) < 1e-9, 'exactly BIND_GAP outside the outline');
    assert.ok(end.y >= 200 && end.y <= 300, `and stayed beside that edge, got y=${end.y}`);
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
    assert.equal(line.points[0].x, 400 - BIND_GAP);
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

describe('connectorEndpoint', () => {
  test('a bare box (legacy callers) lands on the nearer edge, no gap by default', () => {
    const b = { x: 0, y: 0, w: 100, h: 100 };
    assert.deepEqual(connectorEndpoint(b, { x: -50, y: 50 }), { x: 0, y: 50 });
    assert.deepEqual(connectorEndpoint(b, { x: 50, y: 200 }), { x: 50, y: 100 });
    assert.deepEqual(connectorEndpoint(b, { x: 250, y: 50 }), { x: 100, y: 50 });
  });

  test('the gap pushes the point outward along the centre ray', () => {
    const b = box();
    assert.deepEqual(connectorEndpoint(b, { x: -50, y: 50 }, 4), { x: -4, y: 50 });
    // Diagonal: exactly `gap` further from the corner along the 45° ray.
    const p = connectorEndpoint(b, { x: 200, y: 200 }, 10);
    near(p, { x: 100 + 10 / Math.SQRT2, y: 100 + 10 / Math.SQRT2 }, 'diagonal gap');
    assert.ok(Math.abs(outsideBy(b, p) - 10) < 1e-9);
  });

  test('box-like types use the box outline', () => {
    for (const type of ['rect', 'sticky', 'text', 'image', 'cylinder', 'pen']) {
      const p = connectorEndpoint(box({ type }), { x: 200, y: 50 });
      assert.deepEqual(p, { x: 100, y: 50 }, type);
    }
  });

  test('an ellipse uses the ellipse, not its box', () => {
    const e = box({ type: 'ellipse', w: 200, h: 100 });
    // Along an axis the ellipse and the box agree...
    near(connectorEndpoint(e, { x: 500, y: 50 }), { x: 200, y: 50 }, 'major axis');
    near(connectorEndpoint(e, { x: 100, y: -500 }), { x: 100, y: 0 }, 'minor axis');
    // ...but on a diagonal the ellipse is well inside the box corner.
    const p = connectorEndpoint(e, { x: 300, y: 150 });
    assert.ok(Math.abs(outsideBy(e, p)) < 1e-9, 'on the ellipse');
    assert.ok(p.x < 200 && p.y < 100, 'inside the box corner');
    const g = connectorEndpoint(e, { x: 300, y: 150 }, BIND_GAP);
    assert.ok(Math.abs(outsideBy(e, g) - BIND_GAP) < 1e-9, 'gap measured from the ellipse');
  });

  test('a diamond uses the rhombus', () => {
    const d = box({ type: 'diamond' });
    // Toward a corner of the box, the diamond's edge is half-way there.
    near(connectorEndpoint(d, { x: 200, y: 200 }), { x: 75, y: 75 }, 'edge midpoint');
    near(connectorEndpoint(d, { x: 50, y: -300 }), { x: 50, y: 0 }, 'top vertex');
    const p = connectorEndpoint(d, { x: -40, y: 90 }, 6);
    assert.ok(Math.abs(outsideBy(d, p) - 6) < 1e-9);
  });

  test('rotation: the outline is the ROTATED shape', () => {
    // 200x100 rect rotated 90° about (100, 50) spans x 50..150, y -50..150.
    const r = box({ w: 200, h: 100, rotation: Math.PI / 2 });
    near(connectorEndpoint(r, { x: 100, y: -500 }), { x: 100, y: -50 }, 'top of the rotated rect');
    near(connectorEndpoint(r, { x: 500, y: 50 }), { x: 150, y: 50 }, 'right side of the rotated rect');
    near(connectorEndpoint(r, { x: 100, y: -500 }, 4), { x: 100, y: -54 }, 'gap applies after rotation');
    // A rotated ellipse / diamond: still exactly on the rotated outline.
    for (const type of ['ellipse', 'diamond', 'rect']) {
      const el = box({ type, w: 160, h: 60, rotation: 0.7 });
      for (const toward of [{ x: 300, y: 10 }, { x: -80, y: 140 }, { x: 81, y: -200 }]) {
        const p = connectorEndpoint(el, toward, 5);
        assert.ok(Math.abs(outsideBy(el, p) - 5) < 1e-9, `${type} toward ${JSON.stringify(toward)}`);
      }
    }
  });

  test('no direction (toward = centre) is the centre; a zero-size box is its centre', () => {
    assert.deepEqual(connectorEndpoint(box(), { x: 50, y: 50 }, 4), { x: 50, y: 50 });
    assert.deepEqual(connectorEndpoint({ x: 10, y: 20, w: 0, h: 0 }, { x: 99, y: 99 }), { x: 10, y: 20 });
    const flat = connectorEndpoint({ type: 'ellipse', x: 0, y: 0, w: 100, h: 0 }, { x: 500, y: 0 });
    assert.ok(Number.isFinite(flat.x) && Number.isFinite(flat.y), 'a flat ellipse never yields NaN');
    assert.deepEqual(connectorEndpoint(box(), undefined, 4), { x: 50, y: 50 }, 'no aim point: the centre');
    assert.deepEqual(connectorEndpoint(box(), { x: NaN, y: 0 }), { x: 50, y: 50 });
  });
});

describe('resolveConnectors: shapes, rotation and many points', () => {
  const A = { id: 'A', type: 'rect', x: 0, y: 0, w: 100, h: 100 };
  const B = { id: 'B', type: 'ellipse', x: 300, y: 0, w: 100, h: 100 };

  test('2 points, both ends bound: each end aims at the OTHER anchor centre', () => {
    const link = { id: 'l', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], startId: 'A', endId: 'B' };
    const [, , out] = resolveConnectors([A, B, link]);
    assert.deepEqual(out.points[0], { x: 100 + BIND_GAP, y: 50 });
    assert.deepEqual(out.points[1], { x: 300 - BIND_GAP, y: 50 });
    assert.deepEqual([out.x, out.y, out.w, out.h], [104, 50, 192, 0], 'reboxed from the new points');
  });

  test('3+ points: only the ends move, and each aims at its interior neighbour', () => {
    const pts = [{ x: 50, y: 50 }, { x: 50, y: 300 }, { x: 350, y: 300 }, { x: 350, y: 60 }];
    const link = { id: 'l', type: 'line', x: 0, y: 0, w: 0, h: 0, points: pts, startId: 'A', endId: 'B' };
    const [, , out] = resolveConnectors([A, B, link]);
    assert.equal(out.points.length, 4);
    // Start aims straight down at points[1] (50,300): bottom edge of A, plus gap.
    assert.deepEqual(out.points[0], { x: 50, y: 100 + BIND_GAP });
    // End aims straight down at points[2] (350,300): bottom of the ellipse, plus gap.
    near(out.points[3], { x: 350, y: 100 + BIND_GAP }, 'end on the ellipse');
    assert.deepEqual(out.points[1], pts[1], 'interior points never move');
    assert.deepEqual(out.points[2], pts[2]);
    assert.deepEqual(link.points, pts, 'the input is not mutated');
  });

  test('half-bound 2-point connector aims at its free end, which stays put', () => {
    const link = { id: 'l', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 50, y: 400 }, { x: 0, y: 0 }], endId: 'A' };
    const [, out] = resolveConnectors([A, link]);
    assert.deepEqual(out.points[0], { x: 50, y: 400 }, 'free end untouched');
    assert.deepEqual(out.points[1], { x: 50, y: 100 + BIND_GAP }, 'toward the free end: bottom edge');
  });

  test('a rotated anchor is honoured', () => {
    const R = { id: 'R', type: 'rect', x: 0, y: 0, w: 200, h: 100, rotation: Math.PI / 2 };
    const link = { id: 'l', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 100, y: -500 }, { x: 0, y: 0 }], endId: 'R' };
    const [, out] = resolveConnectors([R, link]);
    near(out.points[1], { x: 100, y: -50 - BIND_GAP }, 'end on the rotated top edge');
  });

  test('a two-point self-loop is left as stored; a multi-point one resolves', () => {
    const two = { id: 's2', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 10, y: 0 }, { x: 90, y: 0 }], startId: 'A', endId: 'A' };
    const many = {
      id: 'sN', type: 'arrow', x: 0, y: 0, w: 0, h: 0,
      points: [{ x: 50, y: 50 }, { x: 50, y: -80 }, { x: 180, y: -80 }, { x: 180, y: 50 }, { x: 50, y: 50 }],
      startId: 'A', endId: 'A',
    };
    const out = resolveConnectors([A, two, many]);
    assert.equal(out[1], two, 'untouched, same object');
    assert.deepEqual(out[2].points[0], { x: 50, y: -BIND_GAP }, 'start aims up at points[1] (50,-80)');
    assert.deepEqual(out[2].points[4], { x: 100 + BIND_GAP, y: 50 }, 'end aims right at points[3] (180,50)');
    assert.deepEqual(out[2].points.slice(1, 4), many.points.slice(1, 4), 'interior untouched');
  });

  test('a binding to another connector (or to itself) is ignored', () => {
    const other = { id: 'o', type: 'line', x: 0, y: 0, w: 10, h: 10, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] };
    const link = { id: 'l', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 500, y: 500 }, { x: 600, y: 600 }], startId: 'o', endId: 'l' };
    const out = resolveConnectors([other, link]);
    assert.equal(out[1], link);
  });

  test('a connector with fewer than 2 points is left alone', () => {
    const broken = { id: 'l', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 1, y: 1 }], startId: 'A' };
    assert.equal(resolveConnectors([A, broken])[1], broken);
  });

  test('nothing bound: the SAME array comes back', () => {
    const list = [A, { id: 'l', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }];
    assert.equal(resolveConnectors(list), list);
  });

  test('idempotent across shapes, rotations, gaps and point counts (randomised)', () => {
    const rnd = prng(20260928);
    const types = ['rect', 'ellipse', 'diamond', 'cylinder', 'sticky', 'text', 'image'];
    for (let round = 0; round < 300; round++) {
      const shapes = [0, 1, 2].map((i) => ({
        id: `s${i}`,
        type: types[Math.floor(rnd() * types.length)],
        x: rnd() * 800 - 400,
        y: rnd() * 800 - 400,
        w: 1 + rnd() * 300,
        h: 1 + rnd() * 300,
        rotation: rnd() < 0.5 ? 0 : rnd() * Math.PI * 4 - Math.PI * 2,
      }));
      const n = 2 + Math.floor(rnd() * 4);
      const points = Array.from({ length: n }, () => ({ x: rnd() * 1000 - 500, y: rnd() * 1000 - 500 }));
      const pick = () => (rnd() < 0.2 ? undefined : shapes[Math.floor(rnd() * 3)].id);
      const link = { id: 'l', type: rnd() < 0.5 ? 'arrow' : 'line', ...boundsOfPoints(points), points };
      const s = pick();
      const e = pick();
      if (s) link.startId = s;
      if (e) link.endId = e;

      const once = resolveConnectors([...shapes, link]);
      const twice = resolveConnectors(once);
      assert.equal(twice[3], once[3], `round ${round}: a second pass returns the same object`);
      assert.equal(JSON.stringify(twice), JSON.stringify(once), `round ${round}`);

      const out = once[3];
      assert.equal(out.points.length, n, 'point count preserved');
      for (let i = 1; i < n - 1; i++) assert.deepEqual(out.points[i], points[i], 'interior fixed');
      for (const p of out.points) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
      // Every bound end that is not a degenerate self-loop sits BIND_GAP outside its outline.
      const selfLoop2 = n === 2 && s && s === e;
      if (s && !selfLoop2) {
        const anchor = shapes.find((x) => x.id === s);
        const d = outsideBy(anchor, out.points[0]);
        // (A point aimed exactly at the centre stays there; that is measure zero.)
        assert.ok(Math.abs(d - BIND_GAP) < 1e-6, `round ${round}: start ${d} outside ${anchor.type}`);
      }
      if (e && !selfLoop2) {
        const anchor = shapes.find((x) => x.id === e);
        const d = outsideBy(anchor, out.points[n - 1]);
        assert.ok(Math.abs(d - BIND_GAP) < 1e-6, `round ${round}: end ${d} outside ${anchor.type}`);
      }
      // The box always matches the points.
      const b = boundsOfPoints(out.points);
      assert.deepEqual([out.x, out.y, out.w, out.h], [b.x, b.y, b.w, b.h]);
    }
  });

  test('detachMissingConnectors then resolve: a dead anchor stops steering its end', () => {
    const link = { id: 'l', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 0, y: 0 }, { x: 999, y: 999 }], startId: 'A', endId: 'gone' };
    const list = detachMissingConnectors([A, link]);
    assert.equal('endId' in list[1], false);
    const [, out] = resolveConnectors(list);
    assert.deepEqual(out.points[1], { x: 999, y: 999 });
  });
});

describe('connectorMidpoint', () => {
  test('two points: the plain midpoint', () => {
    assert.deepEqual(connectorMidpoint([{ x: 0, y: 0 }, { x: 10, y: 20 }]), { x: 5, y: 10 });
  });

  test('many points: half-way along the path, not between the ends', () => {
    // An L: 100 right then 100 down; half the length is the corner.
    assert.deepEqual(connectorMidpoint([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]), { x: 100, y: 0 });
    assert.deepEqual(connectorMidpoint([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }]), { x: 20, y: 0 });
  });

  test('degenerate input never yields NaN', () => {
    assert.deepEqual(connectorMidpoint([]), { x: 0, y: 0 });
    assert.deepEqual(connectorMidpoint([{ x: 3, y: 4 }]), { x: 3, y: 4 });
    assert.deepEqual(connectorMidpoint([{ x: 3, y: 4 }, { x: 3, y: 4 }, { x: 3, y: 4 }]), { x: 3, y: 4 });
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
