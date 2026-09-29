/**
 * hitTest.js — "what is under this point?", with Excalidraw's semantics.
 *
 * Every question the editor asks about a pointer position lands here: hover,
 * click-to-select, the eraser sweep, arrow binding (via scene.findBindTarget),
 * point handles of a selected connector, and the marquee.
 *
 * Rules (the ones users notice when they are wrong):
 *  - Tolerance is specified in SCREEN px (HIT_TOLERANCE) and divided by zoom,
 *    so a thin line is equally easy to grab at 10% and at 800%.
 *  - A FILLED closed shape is hit anywhere inside it. An UNFILLED one is hit
 *    only on its outline (± tolerance and half the stroke), exactly like
 *    Excalidraw: clicking through the middle of an empty rectangle reaches
 *    whatever is behind it. A shape that carries a non-empty label is treated
 *    as filled — the label is ink you can click.
 *  - text, sticky notes and images are always hit anywhere in their box.
 *  - A cylinder is its painted drum (render/shape.js cylinderPaths), not its
 *    box: the corners outside its elliptical caps are empty, and the front
 *    half of the top cap, drawn across the body, is ink you can click.
 *  - A connector with `roundness: 'round'` and more than two points is
 *    painted as a smooth curve (render/shape.js), so it is hit along that
 *    same curve, not along the straight chords between its points.
 *  - Rotated shapes are tested in their own unrotated frame (the point is
 *    rotated back about the box centre), so hit areas turn with the shape.
 *  - Elements with opacity 0 are invisible and therefore not clickable.
 *
 * Pure: no DOM, safe in node tests.
 */

import { rotatePoint, pointNearPolyline, pointInPolygon, diamondPolygon, distToSegmentSq } from '@whiteboard/shared';
import { HIT_TOLERANCE, POINT_HANDLE_RADIUS } from './constants.js';
import { elementBounds, rotateAround } from './handles.js';
import { curveSegments, cylinderCap } from './render/shape.js';

const hasFill = (el) => typeof el.fill === 'string' && el.fill !== 'none' && el.fill !== 'transparent' && el.fill !== '';
const hasLabel = (el) => typeof el.label === 'string' && el.label.trim() !== '';
const strokeHalf = (el) => (Number.isFinite(el.strokeWidth) ? el.strokeWidth : 2) / 2;

/** Half the painted width of a freehand stroke (perfect-freehand size is
 *  strokeWidth * 4.25, min 4, per the render contract). */
const penHalf = (el) => Math.max(4, (Number.isFinite(el.strokeWidth) ? el.strokeWidth : 2) * 4.25) / 2;

/** Corner radius a `roundness: 'round'` rect is painted with (render contract). */
function cornerRadius(el) {
  if (el.type !== 'rect' || el.roundness !== 'round') return 0;
  return Math.min(Math.min(el.w, el.h) * 0.25, 32);
}

/**
 * Signed distance from `q` to a (rounded) box outline, in the box's own
 * unrotated frame: negative inside, positive outside, 0 on the outline.
 */
function roundedBoxSdf(q, box, radius) {
  const hw = box.w / 2;
  const hh = box.h / 2;
  const r = Math.max(0, Math.min(radius, hw, hh));
  const dx = Math.abs(q.x - (box.x + hw)) - (hw - r);
  const dy = Math.abs(q.y - (box.y + hh)) - (hh - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - r;
}

/**
 * Nearest point on an axis-aligned ellipse (semi-axes a, b, centred at the
 * origin) to (px, py). Iterative, trig-free and robust for thin ellipses
 * (three iterations are plenty for hit-testing).
 */
function nearestOnEllipse(px, py, a, b) {
  const ax = Math.abs(px);
  const ay = Math.abs(py);
  let tx = Math.SQRT1_2;
  let ty = Math.SQRT1_2;
  for (let i = 0; i < 3; i++) {
    const x = a * tx;
    const y = b * ty;
    const ex = ((a * a - b * b) * tx ** 3) / a;
    const ey = ((b * b - a * a) * ty ** 3) / b;
    const rx = x - ex;
    const ry = y - ey;
    const qx = ax - ex;
    const qy = ay - ey;
    const r = Math.hypot(rx, ry);
    const q = Math.hypot(qx, qy) || 1e-9;
    tx = Math.min(1, Math.max(0, ((qx * r) / q + ex) / a));
    ty = Math.min(1, Math.max(0, ((qy * r) / q + ey) / b));
    const t = Math.hypot(tx, ty) || 1;
    tx /= t;
    ty /= t;
  }
  return { x: Math.sign(px || 1) * a * tx, y: Math.sign(py || 1) * b * ty };
}

/** Signed distance to an ellipse outline (negative inside). */
function ellipseSdf(q, box) {
  const a = box.w / 2;
  const b = box.h / 2;
  const px = q.x - (box.x + a);
  const py = q.y - (box.y + b);
  if (a <= 1e-9 || b <= 1e-9) return roundedBoxSdf(q, box, 0); // degenerate: a segment
  const n = nearestOnEllipse(px, py, a, b);
  const d = Math.hypot(px - n.x, py - n.y);
  const inside = (px / a) ** 2 + (py / b) ** 2 <= 1;
  return inside ? -d : d;
}

/** Signed distance to the diamond (rhombus) outline (negative inside). */
function diamondSdf(q, box) {
  const poly = diamondPolygon(box);
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d2 = distToSegmentSq(q, poly[i], poly[(i + 1) % poly.length]);
    if (d2 < best) best = d2;
  }
  const d = Math.sqrt(best);
  return pointInPolygon(q, poly) ? -d : d;
}

/** Samples per half ellipse of a cylinder cap: the chord error stays under half a pixel even for a very wide drum. */
const CAP_SAMPLES = 48;

/** Half of the ellipse centred on (cx, cy) with semi-axes rx, ry — the upper (y ≤ cy) or the lower half — as points from left to right. */
function halfEllipse(cx, cy, rx, ry, upper) {
  const out = [];
  for (let i = 0; i <= CAP_SAMPLES; i++) {
    const a = Math.PI - (Math.PI * i) / CAP_SAMPLES;
    out.push({ x: cx + rx * Math.cos(a), y: cy + (upper ? -ry : ry) * Math.sin(a) });
  }
  return out;
}

/**
 * A cylinder as the renderer paints it (render/shape.js cylinderPaths, same
 * cap height `cylinderCap`), in its unrotated frame: `outline` is the closed
 * silhouette — the back half of the top cap, the right side, the front half
 * of the bottom cap, the left side — and `rim` the front half of the top cap,
 * drawn across the body. Cached per element object (the store replaces
 * objects on change), re-checked against the box.
 * @returns {{outline: {x,y}[], rim: {x,y}[]}}
 */
const cylinderCache = new WeakMap();
function cylinderGeometry(el) {
  const c = cylinderCache.get(el);
  if (c && c.x === el.x && c.y === el.y && c.w === el.w && c.h === el.h) return c.geo;
  const ry = cylinderCap(el.w, el.h);
  const rx = el.w / 2;
  const cx = el.x + rx;
  const top = halfEllipse(cx, el.y + ry, rx, ry, true);
  const bottom = halfEllipse(cx, el.y + el.h - ry, rx, ry, false).reverse();
  const geo = { outline: [...top, ...bottom], rim: halfEllipse(cx, el.y + ry, rx, ry, false) };
  cylinderCache.set(el, { x: el.x, y: el.y, w: el.w, h: el.h, geo });
  return geo;
}

/** Squared distance from `q` to a polyline (closed: back to its first point too). */
function polylineDistSq(q, pts, closed = false) {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) best = Math.min(best, distToSegmentSq(q, pts[i], pts[i + 1]));
  if (closed && n > 1) best = Math.min(best, distToSegmentSq(q, pts[n - 1], pts[0]));
  return best;
}

/** Signed distance to a cylinder's silhouette (negative inside). */
function cylinderSdf(q, el) {
  const { outline } = cylinderGeometry(el);
  const d = Math.sqrt(polylineDistSq(q, outline, true));
  return pointInPolygon(q, outline) ? -d : d;
}

/** Signed distance to a closed shape's outline, in its unrotated frame. */
function shapeSdf(el, q) {
  if (el.type === 'ellipse') return ellipseSdf(q, el);
  if (el.type === 'diamond') return diamondSdf(q, el);
  if (el.type === 'cylinder') return cylinderSdf(q, el);
  return roundedBoxSdf(q, el, cornerRadius(el));
}

/** Cheap reject: is `p` anywhere near the element's painted bounds? */
function nearBounds(el, p, pad) {
  const b = elementBounds(el);
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
}

/** Is this connector painted as a smooth curve (render contract: round, > 2 points)? */
const isCurved = (el) => el.roundness === 'round' && Array.isArray(el.points) && el.points.length > 2;

/** Samples per cubic segment: enough that the chord error stays well under a pixel for any sane arrow. */
const CURVE_SAMPLES = 24;

/** Point on a cubic bezier. */
function bezierAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/**
 * The path a connector is PAINTED along, as polylines, one per segment
 * between consecutive points: the straight segments themselves, or — for a
 * curved connector — each cubic of the renderer's `curveSegments` (the exact
 * Catmull-Rom curve roughjs draws) sampled finely. Cached per element object:
 * the store replaces objects on change, so the cache invalidates itself.
 * @returns {{x,y}[][]}
 */
const pathCache = new WeakMap();
function paintedSegments(el) {
  const cached = pathCache.get(el);
  if (cached && cached.points === el.points && cached.round === el.roundness) return cached.segs;
  let segs;
  if (isCurved(el)) {
    segs = curveSegments(el.points).map(([p0, c1, c2, p3]) => {
      const out = [];
      for (let i = 0; i <= CURVE_SAMPLES; i++) out.push(bezierAt(p0, c1, c2, p3, i / CURVE_SAMPLES));
      return out;
    });
  } else {
    segs = [];
    for (let i = 0; i < el.points.length - 1; i++) segs.push([el.points[i], el.points[i + 1]]);
    if (segs.length === 0) segs.push([el.points[0]]);
  }
  pathCache.set(el, { points: el.points, round: el.roundness, segs });
  return segs;
}

/** Bounds of a set of polylines (a curve can overshoot the bounds of its points). */
function segmentsBounds(segs) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const seg of segs) {
    for (const q of seg) {
      if (q.x < x1) x1 = q.x;
      if (q.y < y1) y1 = q.y;
      if (q.x > x2) x2 = q.x;
      if (q.y > y2) y2 = q.y;
    }
  }
  return { x1, y1, x2, y2 };
}

/** Is `p` within `t` of the connector as painted (chords, or the sampled curve)? */
function nearConnector(el, p, t) {
  if (!isCurved(el)) return nearBounds(el, p, t) && pointNearPolyline(p, el.points, t);
  const segs = paintedSegments(el);
  const b = segmentsBounds(segs);
  if (p.x < b.x1 - t || p.x > b.x2 + t || p.y < b.y1 - t || p.y > b.y2 + t) return false;
  return segs.some((seg) => pointNearPolyline(p, seg, t));
}

/**
 * The shape test with an explicit tolerance in BOARD units. `hitElement` uses
 * HIT_TOLERANCE/zoom; binding uses BIND_DISTANCE/zoom with the same rules.
 */
export function hitShape(el, p, tol) {
  if (!el || !p) return false;
  switch (el.type) {
    case 'pen': {
      if (!Array.isArray(el.points) || el.points.length === 0) return false;
      const t = tol + penHalf(el);
      return nearBounds(el, p, t) && pointNearPolyline(p, el.points, t);
    }
    case 'arrow':
    case 'line': {
      if (!Array.isArray(el.points) || el.points.length === 0) return false;
      return nearConnector(el, p, tol + strokeHalf(el));
    }
    default:
      break;
  }
  if (!nearBounds(el, p, tol + strokeHalf(el))) return false;
  const q = el.rotation ? rotatePoint(p, el, el.rotation) : p;
  switch (el.type) {
    case 'text':
    case 'sticky':
    case 'image':
      return q.x >= el.x - tol && q.x <= el.x + el.w + tol && q.y >= el.y - tol && q.y <= el.y + el.h + tol;
    case 'rect':
    case 'ellipse':
    case 'diamond':
    case 'cylinder': {
      const d = shapeSdf(el, q);
      const band = tol + strokeHalf(el);
      if (hasFill(el) || hasLabel(el)) return d <= band;
      if (Math.abs(d) <= band) return true;
      // The front half of a cylinder's top cap is painted across its body.
      return el.type === 'cylinder' && polylineDistSq(q, cylinderGeometry(el).rim) <= band * band;
    }
    default:
      return false;
  }
}

/**
 * Is `p` INSIDE the element's closed shape (or its box, for text, sticky
 * notes and images), however it is filled, give or take `tol` board units?
 * Rotation-aware. This is not a click test (an unfilled shape's middle is
 * not ink): it is how a text gesture finds the container whose label it
 * writes when the pointer is over a transparent shape's empty middle.
 */
export function pointInShape(el, p, tol = 0) {
  if (!el || !p || !(el.w >= 0) || !(el.h >= 0)) return false;
  const q = el.rotation ? rotatePoint(p, el, el.rotation) : p;
  switch (el.type) {
    case 'text':
    case 'sticky':
    case 'image':
      return q.x >= el.x - tol && q.x <= el.x + el.w + tol && q.y >= el.y - tol && q.y <= el.y + el.h + tol;
    case 'rect':
    case 'ellipse':
    case 'diamond':
    case 'cylinder':
      return shapeSdf(el, q) <= tol;
    default:
      return false;
  }
}

/**
 * Is board point `p` on the element as painted? See the module header for
 * the filled/unfilled/label rules.
 */
export function hitElement(el, p, zoom = 1) {
  if (!el || el.opacity === 0) return false;
  return hitShape(el, p, HIT_TOLERANCE / (zoom || 1));
}

/**
 * Topmost element under `p` (the array order IS the z-order, last on top).
 * @param {{skipLocked?: boolean}} [opts]
 * @returns {object|null}
 */
export function hitTest(elements, p, zoom = 1, { skipLocked = false } = {}) {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (skipLocked && el.locked) continue;
    if (hitElement(el, p, zoom)) return el;
  }
  return null;
}

/** Every element under `p`, topmost first. */
export function hitTestAll(elements, p, zoom = 1) {
  const out = [];
  for (let i = elements.length - 1; i >= 0; i--) {
    if (hitElement(elements[i], p, zoom)) out.push(elements[i]);
  }
  return out;
}

/**
 * Ids of the elements FULLY inside `rect` (Excalidraw marquee semantics: a
 * shape half inside the box is not selected). Uses the painted bounds, so a
 * rotated shape counts by its rotated corners and a polyline by its points.
 * @param {{x,y,w,h}} rect  board units; negative w/h are accepted
 */
export function elementsInMarquee(elements, rect) {
  if (!rect) return [];
  const x1 = Math.min(rect.x, rect.x + rect.w);
  const y1 = Math.min(rect.y, rect.y + rect.h);
  const x2 = Math.max(rect.x, rect.x + rect.w);
  const y2 = Math.max(rect.y, rect.y + rect.h);
  const out = [];
  for (const el of elements) {
    const b = elementBounds(el);
    if (b.x >= x1 && b.y >= y1 && b.x + b.w <= x2 && b.y + b.h <= y2) out.push(el.id);
  }
  return out;
}

/**
 * Index of the connector point whose handle is under `p`, or -1. When two
 * handles overlap (a zero-length segment) the nearest wins, and on a tie the
 * LAST one, so dragging out of a collapsed end grabs the end, not the start.
 */
export function hitLinearPoint(el, p, zoom = 1) {
  if (!el || !Array.isArray(el.points)) return -1;
  const r = (POINT_HANDLE_RADIUS + 2) / (zoom || 1);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < el.points.length; i++) {
    const q = el.points[i];
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= r && d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/**
 * Index `i` of the connector segment [points[i], points[i+1]] under `p`, or -1.
 * Used to insert a point where the user double-clicks a segment.
 */
export function hitLinearSegment(el, p, zoom = 1) {
  if (!el || !Array.isArray(el.points) || el.points.length < 2) return -1;
  const t = HIT_TOLERANCE / (zoom || 1) + strokeHalf(el);
  // Segment i of the painted path (a straight chord, or the curve piece
  // between points i and i+1 of a round connector).
  const segs = paintedSegments(el);
  let best = -1;
  let bestD = t * t;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    for (let j = 0; j < seg.length - 1; j++) {
      const d2 = distToSegmentSq(p, seg[j], seg[j + 1]);
      if (d2 <= bestD) {
        best = i;
        bestD = d2;
      }
    }
  }
  return best;
}

/**
 * Is `p` inside a selection frame (as returned by handles.selectionFrame),
 * honouring the frame's rotation? A pointerdown here grabs the selection even
 * over the transparent middle of an unfilled shape.
 */
export function pointInFrame(frame, p) {
  if (!frame || !p) return false;
  const c = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
  const q = frame.rotation ? rotateAround(p, c, -frame.rotation) : p;
  return q.x >= frame.x && q.x <= frame.x + frame.w && q.y >= frame.y && q.y <= frame.y + frame.h;
}
