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
 *  - Rotated shapes are tested in their own unrotated frame (the point is
 *    rotated back about the box centre), so hit areas turn with the shape.
 *  - Elements with opacity 0 are invisible and therefore not clickable.
 *
 * Pure: no DOM, safe in node tests.
 */

import { rotatePoint, pointNearPolyline, pointInPolygon, diamondPolygon, distToSegmentSq } from '@whiteboard/shared';
import { HIT_TOLERANCE, POINT_HANDLE_RADIUS } from './constants.js';
import { elementBounds, rotateAround } from './handles.js';

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

/** Signed distance to a closed shape's outline, in its unrotated frame. */
function shapeSdf(el, q) {
  if (el.type === 'ellipse') return ellipseSdf(q, el);
  if (el.type === 'diamond') return diamondSdf(q, el);
  return roundedBoxSdf(q, el, cornerRadius(el));
}

/** Cheap reject: is `p` anywhere near the element's painted bounds? */
function nearBounds(el, p, pad) {
  const b = elementBounds(el);
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
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
      const t = tol + strokeHalf(el);
      return nearBounds(el, p, t) && pointNearPolyline(p, el.points, t);
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
      return Math.abs(d) <= band;
    }
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
  if (!el || !Array.isArray(el.points)) return -1;
  const t = HIT_TOLERANCE / (zoom || 1) + strokeHalf(el);
  let best = -1;
  let bestD = t * t;
  for (let i = 0; i < el.points.length - 1; i++) {
    const d2 = distToSegmentSq(p, el.points[i], el.points[i + 1]);
    if (d2 <= bestD) {
      best = i;
      bestD = d2;
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
