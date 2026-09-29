/**
 * Geometry for the board.
 *
 * Everything that turns a number into a position lives here, ONCE, and is
 * imported by the renderer, the hit-tester, the interaction reducer and the
 * exporter. That is the entire point: if the canvas and the SVG export each
 * compute "where is the middle of this box" independently they will drift, and
 * an exported PNG that does not match the screen is the single most
 * embarrassing bug a whiteboard can have.
 *
 * Coordinate conventions, restated because every function here depends on them:
 *  - Board units: x grows right, y grows DOWN (screen convention, matching
 *    canvas and DOM). The board is infinite and may have negative coordinates.
 *  - `rotation` is in radians, clockwise on screen, about the element's box
 *    CENTRE. `x/y/w/h` is the UNROTATED box: a rotated element is that box
 *    turned about its centre, so the area it paints is the box's rotated
 *    corners (see boxCorners / rotatePoint), whose axis-aligned bounds are
 *    LARGER than `x/y/w/h`. Pen strokes and connectors derive `x/y/w/h` from
 *    their points instead (see reboxPolyline).
 *  - Screen points are CSS pixels relative to the canvas element's top-left.
 */

import { ZOOM_LIMITS, ZOOM_STEP } from './types.js';

/** @typedef {{x: number, y: number}} Point */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */
/** @typedef {{zoom: number, panX: number, panY: number}} View */

const EPS = 1e-9;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------ *
 * View transform
 * ------------------------------------------------------------------ */

/**
 * Screen (CSS px from the canvas origin) -> board units.
 * @param {{x:number,y:number}} p
 * @param {View} view
 * @returns {Point}
 */
function _screenToBoard(p, view) {
  // A keyboard event has no `screenPt`, so `p` can legitimately be missing.
  // Returning the origin is honest; throwing three frames into a gesture is
  // not, and it took the whole delete path down with it.
  if (!p || typeof p.x !== 'number') return { x: 0, y: 0 };
  return {
    x: (p.x - (view?.panX ?? 0)) / (view?.zoom || 1),
    y: (p.y - (view?.panY ?? 0)) / (view?.zoom || 1),
  };
}

/**
 * Screen px -> board units. Accepts `(view, point)` or `(point, view)`.
 * @returns {Point}
 */
export function screenToBoard(a, b) {
  if (isView(a)) return _screenToBoard(b, a);
  if (isView(b)) return _screenToBoard(a, b);
  // Neither argument is a view. A keyboard event carries no position, so this
  // is reachable — the honest answer is the origin, not a crash three frames
  // into a gesture.
  return { x: 0, y: 0 };
}

/**
 * Board units -> screen (CSS px from the canvas origin).
 * @param {Point} p
 * @param {View} view
 * @returns {Point}
 */
function _boardToScreen(p, view) {
  if (!p || typeof p.x !== 'number') return { x: 0, y: 0 };
  return {
    x: p.x * (view?.zoom || 1) + (view?.panX ?? 0),
    y: p.y * (view?.zoom || 1) + (view?.panY ?? 0),
  };
}

/** Board units -> screen px. Accepts `(view, point)` or `(point, view)`. */
export function boardToScreen(a, b) {
  if (isView(a)) return _boardToScreen(b, a);
  if (isView(b)) return _boardToScreen(a, b);
  return { x: 0, y: 0 };
}

/**
 * Zoom about a fixed screen point, so the board point under the cursor stays
 * under the cursor. This is what makes wheel-zoom feel anchored instead of
 * sliding away.
 *
 * @param {View} view
 * @param {Point} screenPt
 * @param {number} factor  Multiply zoom by this (e.g. 1.1 to zoom in).
 * @param {{min?:number, max?:number}} [limits]  Default ZOOM_LIMITS.
 * @returns {View} a NEW view; never mutates the input.
 */
export function zoomAt(view, screenPt, factor, limits = {}) {
  const min = limits.min ?? ZOOM_LIMITS.min;
  const max = limits.max ?? ZOOM_LIMITS.max;
  const zoom = clamp((view.zoom || 1) * factor, min, max);
  // The board point under the screen point must not move.
  const bx = (screenPt.x - view.panX) / (view.zoom || 1);
  const by = (screenPt.y - view.panY) / (view.zoom || 1);
  return {
    zoom,
    panX: screenPt.x - bx * zoom,
    panY: screenPt.y - by * zoom,
  };
}

/**
 * The zoom level one press of zoom in (`direction` > 0) or zoom out (< 0)
 * goes to: `zoom` plus or minus ZOOM_STEP, clamped to the limits (default
 * ZOOM_LIMITS). Additive like Excalidraw's buttons, so 100% -> 110% -> 120%
 * and a wheel-zoomed 137% -> 147%. Rounded to 1e-6 so a run of steps never
 * shows float noise (0.1 + 0.2). A zoom helper takes a factor, so a caller
 * zooming about a point passes `stepZoom(z, dir) / z`.
 *
 * @param {number} zoom
 * @param {number} direction  > 0 zooms in, < 0 zooms out, 0 keeps the level
 * @param {{min?:number, max?:number}} [limits]
 * @returns {number}
 */
export function stepZoom(zoom, direction, limits = {}) {
  const min = limits.min ?? ZOOM_LIMITS.min;
  const max = limits.max ?? ZOOM_LIMITS.max;
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const d = direction > 0 ? 1 : direction < 0 ? -1 : 0;
  return clamp(Math.round((z + d * ZOOM_STEP) * 1e6) / 1e6, min, max);
}

/**
 * Fit a bounding box into a viewport, with a margin, returning a new view.
 * An empty/absent box returns a sane identity-ish view rather than NaN — a
 * board with nothing on it must still zoom predictably.
 *
 * @param {Rect|null} bounds
 * @param {{width:number, height:number, padding?:number, min?:number, max?:number}} viewport
 * @returns {View}
 */
export function fitView(bounds, viewport) {
  const pad = viewport.padding ?? 48;
  const min = viewport.min ?? ZOOM_LIMITS.min;
  const max = viewport.max ?? ZOOM_LIMITS.max;
  const W = Math.max(1, viewport.width - pad * 2);
  const H = Math.max(1, viewport.height - pad * 2);

  const hasArea = bounds && Number.isFinite(bounds.w) && Number.isFinite(bounds.h) && bounds.w > 0 && bounds.h > 0;
  if (!hasArea) {
    // A single point, a dot, or a horizontal line (h === 0): keep zoom at 1
    // and centre the content rather than dividing by zero. This is the
    // horizontal-line case, and it is why the "empty board" test exists.
    if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
      return {
        zoom: 1,
        panX: Math.round(viewport.width / 2 - (bounds.x + (bounds.w || 0) / 2)),
        panY: Math.round(viewport.height / 2 - (bounds.y + (bounds.h || 0) / 2)),
      };
    }
    return { zoom: 1, panX: Math.round(viewport.width / 2), panY: Math.round(viewport.height / 2) };
  }

  const zoom = clamp(Math.min(W / bounds.w, H / bounds.h), min, max);
  return {
    zoom,
    panX: Math.round(viewport.width / 2 - (bounds.x + bounds.w / 2) * zoom),
    panY: Math.round(viewport.height / 2 - (bounds.y + bounds.h / 2) * zoom),
  };
}

/* ------------------------------------------------------------------ *
 * Rotation
 * ------------------------------------------------------------------ */

/**
 * Rotate a point about the centre of a box, by `rotation` radians clockwise.
 * Used to hit-test a rotated element in its own unrotated frame, and to place
 * connector endpoints on a box edge.
 *
 * @param {Point} p    Point in world/board space.
 * @param {Rect} box   The box the rotation is about.
 * @param {number} rotation radians
 * @returns {Point} the UN-rotated point (rotate by -rotation)
 */
export function rotatePoint(p, box, rotation) {
  if (!rotation) return { x: p.x, y: p.y };
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const c = Math.cos(-rotation);
  const s = Math.sin(-rotation);
  return {
    x: cx + dx * c - dy * s,
    y: cy + dx * s + dy * c,
  };
}

/** The four corners of `box` AFTER its rotation. Painted in TL,TR,BR,BL order. */
export function boxCorners(box, rotation = 0) {
  const pts = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ];
  if (!rotation) return pts;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return pts.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  });
}

/* ------------------------------------------------------------------ *
 * Boxes
 * ------------------------------------------------------------------ */

/** A zero rect at the origin. Never hand this out as a shared constant. */
export function emptyRect() {
  return { x: 0, y: 0, w: 0, h: 0 };
}

/**
 * Normalise a box so w/h are non-negative. Dragging up/left produces a box
 * with negative extent; this is the one place that flips it, so no draw
 * function ever has to think about it.
 * @param {Rect} r
 * @returns {Rect}
 */
export function normalizeRect(r) {
  return {
    x: r.w < 0 ? r.x + r.w : r.x,
    y: r.h < 0 ? r.y + r.h : r.y,
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

/**
 * Build a box from two arbitrary corner points (a drag from `a` to `b`).
 * @param {Point} a
 * @param {Point} b
 * @returns {Rect} normalised, w/h >= 0
 */
export function rectFromDrag(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** True when a point is inside (or on the edge of) a box. */
export function pointInRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** True when two boxes overlap (touching edges count as NOT overlapping only
 *  if they share no area; a zero-area box never "contains" anything, which is
 *  the right call for marquee-selection of a flat line). */
export function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Union of two boxes; `null` is identity. */
export function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: x2 - x, h: y2 - y };
}

/** Union of a list of boxes, or `null` for an empty list. */
export function boundsOfRectList(list) {
  let out = null;
  for (let i = 0; i < list.length; i++) out = unionRect(out, list[i]);
  return out;
}

/* ------------------------------------------------------------------ *
 * Polylines (pen strokes and connectors share this)
 * ------------------------------------------------------------------ */

/**
 * Tight bounding box of a point list.
 * An empty list gives a zero rect; a single point gives a zero rect at that
 * point. A horizontal line therefore has h === 0, which is legal everywhere.
 * @param {Point[]} points
 * @returns {Rect}
 */
export function boundsOfPoints(points) {
  if (!points || points.length === 0) return emptyRect();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Re-derive `x/y/w/h` from a stroke's points. This is the only thing that
 * writes a polyline's box — call it after ANY point mutation (drawing,
 * resizing, dragging) so the stored box can never disagree with the points.
 * @param {{points: Point[], x?:number, y?:number, w?:number, h?:number, [k:string]:any}} el
 * @returns {object} the element with a corrected box
 */
export function reboxPolyline(el) {
  const b = boundsOfPoints(el.points || []);
  return { ...el, x: b.x, y: b.y, w: b.w, h: b.h };
}

/** Translate every point of a polyline. Mutates the points array in place. */
export function translatePolyline(points, dx, dy) {
  for (let i = 0; i < points.length; i++) {
    points[i].x += dx;
    points[i].y += dy;
  }
  return points;
}

/** Scale a polyline's points from `from` box to `to` box. Mutates in place. */
export function scalePolylinePoints(points, from, to) {
  const sx = from.w === 0 ? 1 : to.w / from.w;
  const sy = from.h === 0 ? 1 : to.h / from.h;
  for (let i = 0; i < points.length; i++) {
    points[i].x = to.x + (points[i].x - from.x) * sx;
    points[i].y = to.y + (points[i].y - from.y) * sy;
  }
  return points;
}

/**
 * Squared distance from a point to the segment `a`->`b`. Squared so the hot
 * path never calls sqrt; compare against `r*r`.
 */
export function distToSegmentSq(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < EPS) return wx * wx + wy * wy;
  let t = (wx * vx + wy * vy) / len2;
  t = clamp(t, 0, 1);
  const cx = a.x + vx * t;
  const cy = a.y + vy * t;
  const dx = p.x - cx;
  const dy = p.y - cy;
  return dx * dx + dy * dy;
}

/** True when `p` is within `tol` board units of any segment of the polyline. */
export function pointNearPolyline(p, points, tol) {
  const t2 = tol * tol;
  if (points.length === 1) {
    const dx = p.x - points[0].x;
    const dy = p.y - points[0].y;
    return dx * dx + dy * dy <= t2;
  }
  for (let i = 0; i < points.length - 1; i++) {
    if (distToSegmentSq(p, points[i], points[i + 1]) <= t2) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Polygons
 * ------------------------------------------------------------------ */

/**
 * Even-odd / ray-crossing point-in-polygon. Works for any simple polygon,
 * including the 4-point diamond. Uses a half-open vertical span so a point
 * exactly on a horizontal edge is not double-counted.
 * @param {Point} p
 * @param {Point[]} poly
 */
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    if (pi.y > p.y !== pj.y > p.y) {
      const x = ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

/** The axis-aligned rect as a 4-point polygon, in TL,TR,BR,BL order. */
export function rectPolygon(r) {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

/** The diamond inscribed in a rect: midpoints of the four edges. */
export function diamondPolygon(box) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return [
    { x: cx, y: box.y },
    { x: box.x + box.w, y: cy },
    { x: cx, y: box.y + box.h },
    { x: box.x, y: cy },
  ];
}

/* ------------------------------------------------------------------ *
 * Connectors
 * ------------------------------------------------------------------ */

/**
 * How far (board units) a bound connector end stops short of the shape's
 * outline, so the arrowhead never overlaps the stroke (Excalidraw leaves a
 * similar gap), measured for the DEFAULT stroke width on both sides.
 * `resolveConnectors` widens it for thicker strokes: see `bindGap`.
 */
export const BIND_GAP = 4;

/** The stroke width the renderer draws when an element has none. */
const DEFAULT_STROKE_WIDTH = 2;

/** Types whose outline is drawn with their own `strokeWidth`. */
const OUTLINED_TYPES = new Set(['rect', 'ellipse', 'diamond', 'cylinder']);

function strokeWidthOf(el) {
  const w = el && el.strokeWidth;
  return typeof w === 'number' && Number.isFinite(w) && w >= 0 ? w : DEFAULT_STROKE_WIDTH;
}

/**
 * The gap a bound end keeps from `anchor`'s outline, for this `connector`.
 *
 * Both strokes are centred on their geometry, so each reaches half its width
 * past it: a fixed 4 left 2 units of air between two default (2-wide)
 * strokes, and NONE between two extra-bold (4-wide) ones — the arrowhead sat
 * on the outline. Every unit of stroke beyond the default widens the gap by
 * half a unit per side, so the VISIBLE gap stays what it is at the default.
 * Default strokes (or none given) give exactly BIND_GAP. An anchor with no
 * drawn outline (text, image, sticky) adds nothing for its own stroke.
 *
 * @param {Object} anchor     the element the end is bound to
 * @param {Object} [connector] the arrow/line
 * @returns {number} board units, >= 0
 */
export function bindGap(anchor, connector) {
  const own = anchor && OUTLINED_TYPES.has(anchor.type) ? strokeWidthOf(anchor) : DEFAULT_STROKE_WIDTH;
  const line = strokeWidthOf(connector);
  return Math.max(0, BIND_GAP + (own - DEFAULT_STROKE_WIDTH) / 2 + (line - DEFAULT_STROKE_WIDTH) / 2);
}

/**
 * Corner radius of a round rect, and of each rounded vertex of a round
 * diamond, for a side of `size` units: 25% of it, at most 32. The renderer
 * (apps/web render/shape.js `cornerRadius`) draws exactly this, and a bound
 * end must stop at the curve it draws, not at the sharp corner it cut off.
 */
export function cornerRadius(size) {
  return Math.min(Math.max(0, size) * 0.25, 32);
}

/** Which outline an element presents to a connector. Anything unknown (and a
 *  bare `{x,y,w,h}` box) is a box. `roundness: 'round'` rounds a rect's
 *  corners and a diamond's vertices, exactly as they are drawn. */
function outlineKind(el) {
  const t = el && el.type;
  const round = el && el.roundness === 'round';
  if (t === 'ellipse') return 'ellipse';
  if (t === 'diamond') return round ? 'round-diamond' : 'diamond';
  if (t === 'rect' && round) return 'round-box';
  return 'box';
}

/** Samples per rounded corner when a rounded outline is turned into a polygon. */
const CORNER_STEPS = 16;

/**
 * A rounded outline as a polygon about the centre (unrotated frame), traced
 * like the renderer's paths: a round rect has quadratic corners from
 * (r, 0) through the sharp corner to (0, r) (render/shape.js roundRectPath);
 * a round diamond cuts each vertex at (±vr, ±hr) with a cubic whose two
 * control points both sit on the vertex (roundDiamondPath).
 */
function roundedOutline(kind, hx, hy) {
  const pts = [];
  const quad = (p0, c, p2) => {
    for (let i = 0; i <= CORNER_STEPS; i++) {
      const t = i / CORNER_STEPS;
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      const d = t * t;
      pts.push({ x: a * p0.x + b * c.x + d * p2.x, y: a * p0.y + b * c.y + d * p2.y });
    }
  };
  const cubicAtVertex = (p0, v, p3) => {
    for (let i = 0; i <= CORNER_STEPS; i++) {
      const t = i / CORNER_STEPS;
      const a = (1 - t) ** 3;
      const b = 3 * (1 - t) * (1 - t) * t + 3 * (1 - t) * t * t;
      const d = t ** 3;
      pts.push({ x: a * p0.x + b * v.x + d * p3.x, y: a * p0.y + b * v.y + d * p3.y });
    }
  };
  if (kind === 'round-box') {
    const r = cornerRadius(Math.min(2 * hx, 2 * hy));
    quad({ x: hx - r, y: -hy }, { x: hx, y: -hy }, { x: hx, y: -hy + r });
    quad({ x: hx, y: hy - r }, { x: hx, y: hy }, { x: hx - r, y: hy });
    quad({ x: -hx + r, y: hy }, { x: -hx, y: hy }, { x: -hx, y: hy - r });
    quad({ x: -hx, y: -hy + r }, { x: -hx, y: -hy }, { x: -hx + r, y: -hy });
  } else {
    const vr = cornerRadius(hx);
    const hr = cornerRadius(hy);
    cubicAtVertex({ x: hx - vr, y: -hr }, { x: hx, y: 0 }, { x: hx - vr, y: hr }); // right
    cubicAtVertex({ x: vr, y: hy - hr }, { x: 0, y: hy }, { x: -vr, y: hy - hr }); // bottom
    cubicAtVertex({ x: -hx + vr, y: hr }, { x: -hx, y: 0 }, { x: -hx + vr, y: -hr }); // left
    cubicAtVertex({ x: -vr, y: -hy + hr }, { x: 0, y: -hy }, { x: vr, y: -hy + hr }); // top
  }
  return pts;
}

/**
 * Where the ray from the centre along (dx, dy) leaves a closed polygon given
 * about that centre, as a multiple of (dx, dy). The outlines here are
 * star-shaped about their centre, so the ray crosses them once; the farthest
 * crossing is taken to be safe at a vertex. 0 when nothing is crossed.
 */
function rayPolygonScale(poly, dx, dy) {
  let best = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < EPS) continue;
    const t = (a.x * ey - a.y * ex) / denom;
    const u = (a.x * dy - a.y * dx) / denom;
    if (u >= -EPS && u <= 1 + EPS && t > best) best = t;
  }
  return best;
}

/**
 * Distance from the centre to the outline along the direction (dx, dy), as a
 * multiple of that direction vector, in the element's UNROTATED frame. The
 * outline point is `centre + (dx, dy) * t`. Infinity/NaN-free: returns 0 for a
 * degenerate (zero-extent) outline so the caller falls back to the centre.
 *
 *  - box:     the nearer of the two edge crossings, min(hx/|dx|, hy/|dy|).
 *  - ellipse: (t·dx/hx)^2 + (t·dy/hy)^2 = 1.
 *  - diamond: |t·dx|/hx + |t·dy|/hy = 1 (the four edges of the rhombus).
 */
function outlineScale(kind, hx, hy, dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  // A flat or thin element degenerates to its box, which handles one zero
  // half-extent (it is the segment itself) without dividing by zero.
  if (kind !== 'box' && (hx <= EPS || hy <= EPS)) kind = 'box';
  if (kind === 'round-box' || kind === 'round-diamond') {
    const t = rayPolygonScale(roundedOutline(kind, hx, hy), dx, dy);
    return Number.isFinite(t) ? t : 0;
  }
  if (kind === 'ellipse') {
    const q = (dx / hx) ** 2 + (dy / hy) ** 2;
    return q > 0 ? 1 / Math.sqrt(q) : 0;
  }
  if (kind === 'diamond') {
    const q = ax / hx + ay / hy;
    return q > 0 ? 1 / q : 0;
  }
  const sx = ax < EPS ? Infinity : hx / ax;
  const sy = ay < EPS ? Infinity : hy / ay;
  const t = Math.min(sx, sy);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Where a connector meets an element: the point on the element's OUTLINE, on
 * the ray from its centre toward `toward`, pushed `gap` units further out
 * along that ray.
 *
 * The outline follows the shape as it is DRAWN — rect/sticky/text/image/
 * cylinder use the box, `ellipse` the ellipse, `diamond` the rhombus, and a
 * `roundness: 'round'` rect or diamond its rounded corners (see
 * cornerRadius) — and the element's `rotation`
 * (radians, clockwise, about the box centre): `toward` is rotated into the
 * element's unrotated frame, intersected there, and the result is rotated
 * back out. A bare `{x,y,w,h}` is treated as an unrotated box, which is what
 * callers written before this was shape-aware pass.
 *
 * Aiming toward the other end (rather than at a fixed port) is what an end
 * does when the user did not drop it on a particular spot of the outline;
 * one that was dropped there is pinned instead (see bindingFixedPoint and
 * resolveConnectors).
 *
 * @param {{x:number,y:number,w:number,h:number,type?:string,rotation?:number}} el
 * @param {Point} toward  The point the connector comes from.
 * @param {number} [gap]  Board units to stay clear of the outline (>= 0).
 * @returns {Point} the attach point (the centre when there is no direction).
 */
export function connectorEndpoint(el, toward, gap = 0) {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  if (!toward || !Number.isFinite(toward.x) || !Number.isFinite(toward.y)) return { x: cx, y: cy };
  const rotation = Number.isFinite(el.rotation) ? el.rotation : 0;
  // Into the unrotated frame: rotatePoint un-rotates by `rotation`.
  const local = rotation ? rotatePoint(toward, el, rotation) : toward;
  // No direction (the other end sits on the centre): the centre is the only
  // honest answer, and it is stable.
  return endpointAlong(el, local.x - cx, local.y - cy, gap) ?? { x: cx, y: cy };
}

/**
 * The outline point of `el` along the direction (dx, dy) from its centre,
 * given in the element's UNROTATED frame, pushed `gap` units further out and
 * rotated back into board space. Null when there is no direction.
 */
function endpointAlong(el, dx, dy, gap) {
  const len = Math.hypot(dx, dy);
  if (!(len > EPS)) return null;
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const rotation = Number.isFinite(el.rotation) ? el.rotation : 0;
  const t = outlineScale(outlineKind(el), el.w / 2, el.h / 2, dx, dy);
  const g = Number.isFinite(gap) && gap > 0 ? gap / len : 0;
  const k = t + g;
  let x = cx + dx * k;
  let y = cy + dy * k;
  if (rotation) {
    // Back out: rotate by +rotation about the centre.
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    const ox = x - cx;
    const oy = y - cy;
    x = cx + ox * c - oy * s;
    y = cy + ox * s + oy * c;
  }
  return { x, y };
}

/**
 * How far from the centre (as a fraction of the way to the outline) a drop
 * must land for `bindingFixedPoint` to pin the end there. Closer in than
 * this, the user pointed at the shape as a whole rather than at a spot on its
 * outline, and the end keeps aiming (see resolveConnectors).
 */
export const FIXED_POINT_MIN_RATIO = 0.5;

/** A usable fixed point: `{x, y}` with both finite. */
function isFixedPoint(v) {
  return !!v && typeof v === 'object' && Number.isFinite(v.x) && Number.isFinite(v.y);
}

/** Samples of an ellipse outline when it is treated as a polygon. */
const ELLIPSE_STEPS = 128;

/**
 * An element's outline as a closed polygon about its centre, in its
 * unrotated frame (the same outlines connectorEndpoint intersects).
 */
function outlinePolygon(kind, hx, hy) {
  if (kind !== 'box' && (hx <= EPS || hy <= EPS)) kind = 'box';
  if (kind === 'round-box' || kind === 'round-diamond') return roundedOutline(kind, hx, hy);
  if (kind === 'diamond') return [{ x: 0, y: -hy }, { x: hx, y: 0 }, { x: 0, y: hy }, { x: -hx, y: 0 }];
  if (kind === 'ellipse') {
    const pts = [];
    for (let i = 0; i < ELLIPSE_STEPS; i++) {
      const a = (i / ELLIPSE_STEPS) * Math.PI * 2;
      pts.push({ x: hx * Math.cos(a), y: hy * Math.sin(a) });
    }
    return pts;
  }
  return [{ x: -hx, y: -hy }, { x: hx, y: -hy }, { x: hx, y: hy }, { x: -hx, y: hy }];
}

/** The point of a closed polygon's boundary nearest to `p`. */
function nearestOnPolygon(poly, p) {
  let best = poly[0];
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len2 = ex * ex + ey * ey;
    const u = len2 > EPS ? clamp(((p.x - a.x) * ex + (p.y - a.y) * ey) / len2, 0, 1) : 0;
    const q = { x: a.x + ex * u, y: a.y + ey * u };
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/**
 * The fixed point to store for a connector end dropped at `point` on the
 * element `el` (its `startFixedPoint` / `endFixedPoint`), or null when the
 * end should not be pinned.
 *
 * The result is the point of `el`'s outline NEAREST to the drop, as
 * fractions of the element's UNROTATED box: `{x: 0, y: 0}` is its top-left
 * corner, `{x: 1, y: 1}` its bottom-right, so `{x: 0.5, y: 0}` is the middle
 * of the top edge. Being relative to the box, it rides along when the shape
 * moves, rotates or is resized, which is what lets a straight arrow stay on
 * the side it was dropped on (Excalidraw's `fixedPoint`). Rounded to 1e-4 to
 * keep the stored value short.
 *
 * Null when the drop is closer to the centre than FIXED_POINT_MIN_RATIO of
 * the way to the outline (`opts.minRatio`; the user pointed at the shape, not
 * at a spot on it), or when `el` has no area.
 *
 * @param {{x:number,y:number,w:number,h:number,type?:string,rotation?:number,roundness?:string}} el
 * @param {Point} point  where the end was dropped, board units
 * @param {{minRatio?: number}} [opts]
 * @returns {{x:number,y:number}|null}
 */
export function bindingFixedPoint(el, point, opts = {}) {
  if (!el || !isFixedPoint(point)) return null;
  const { x, y, w, h } = el;
  if (![x, y, w, h].every(Number.isFinite) || !(w > EPS) || !(h > EPS)) return null;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rotation = Number.isFinite(el.rotation) ? el.rotation : 0;
  const local = rotation ? rotatePoint(point, el, rotation) : point;
  const dx = local.x - cx;
  const dy = local.y - cy;
  if (!(Math.hypot(dx, dy) > EPS)) return null;
  const kind = outlineKind(el);
  const t = outlineScale(kind, w / 2, h / 2, dx, dy);
  if (!(t > 0)) return null;
  const minRatio = Number.isFinite(opts.minRatio) ? opts.minRatio : FIXED_POINT_MIN_RATIO;
  if (1 / t < minRatio) return null;
  const q = nearestOnPolygon(outlinePolygon(kind, w / 2, h / 2), { x: dx, y: dy });
  const round = (v) => Math.round(clamp(v, 0, 1) * 1e4) / 1e4;
  return { x: round(q.x / w + 0.5), y: round(q.y / h + 0.5) };
}

/** Half-angle (radians) of the chord a rounded outline's normal is taken from. */
const NORMAL_DELTA = 1e-4;

/**
 * The outward unit normal of an outline at its point (ox, oy), which lies on
 * the ray from the centre along (dx, dy) (unrotated frame, about the centre).
 * Exact for the box (the diagonal at a corner), the rhombus and the ellipse;
 * a rounded outline takes it from the chord between its points a hair either
 * side of the ray.
 */
function outlineNormal(kind, hx, hy, ox, oy, dx, dy) {
  if (kind !== 'box' && (hx <= EPS || hy <= EPS)) kind = 'box';
  const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  let nx;
  let ny;
  if (kind === 'box') {
    const sx = Math.abs(dx) < EPS ? Infinity : hx / Math.abs(dx);
    const sy = Math.abs(dy) < EPS ? Infinity : hy / Math.abs(dy);
    if (Math.abs(sx - sy) <= 1e-9 * Math.max(sx, sy)) {
      nx = sgn(dx);
      ny = sgn(dy);
    } else if (sx < sy) {
      nx = sgn(dx);
      ny = 0;
    } else {
      nx = 0;
      ny = sgn(dy);
    }
  } else if (kind === 'diamond') {
    nx = sgn(ox) / hx;
    ny = sgn(oy) / hy;
  } else if (kind === 'ellipse') {
    nx = ox / (hx * hx);
    ny = oy / (hy * hy);
  } else {
    const at = (a) => {
      const k = outlineScale(kind, hx, hy, Math.cos(a), Math.sin(a));
      return { x: Math.cos(a) * k, y: Math.sin(a) * k };
    };
    const theta = Math.atan2(dy, dx);
    const p1 = at(theta - NORMAL_DELTA);
    const p2 = at(theta + NORMAL_DELTA);
    nx = p2.y - p1.y;
    ny = p1.x - p2.x;
    if (nx * dx + ny * dy < 0) {
      nx = -nx;
      ny = -ny;
    }
  }
  const len = Math.hypot(nx, ny);
  if (!(len > EPS)) {
    // No usable normal: fall back to the ray itself.
    const l = Math.hypot(dx, dy);
    return { x: dx / l, y: dy / l };
  }
  return { x: nx / len, y: ny / len };
}

/**
 * Where an end pinned at `fixed` (a bindingFixedPoint) lands on `el`: the
 * outline point on the ray from the centre through the fixed point, `gap`
 * units out along the outline's outward NORMAL there — so the arrowhead
 * keeps the same clearance from the stroke wherever on the outline it is
 * pinned (along the ray, a spot near the corner of a wide box would get only
 * a fraction of it). A pure function of the anchor and the pin. Null when
 * there is no pin, or it sits on the centre.
 */
function pinnedEndpoint(el, fixed, gap) {
  if (!isFixedPoint(fixed)) return null;
  const dx = (fixed.x - 0.5) * el.w;
  const dy = (fixed.y - 0.5) * el.h;
  if (!(Math.hypot(dx, dy) > EPS)) return null;
  const kind = outlineKind(el);
  const hx = el.w / 2;
  const hy = el.h / 2;
  const t = outlineScale(kind, hx, hy, dx, dy);
  let ox = dx * t;
  let oy = dy * t;
  if (Number.isFinite(gap) && gap > 0) {
    const n = outlineNormal(kind, hx, hy, ox, oy, dx, dy);
    ox += n.x * gap;
    oy += n.y * gap;
  }
  const cx = el.x + hx;
  const cy = el.y + hy;
  const rotation = Number.isFinite(el.rotation) ? el.rotation : 0;
  if (!rotation) return { x: cx + ox, y: cy + oy };
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return { x: cx + ox * c - oy * s, y: cy + ox * s + oy * c };
}

/** Centre of a box — the direction an attached connector points from. */
function centreOf(box) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

const isConnector = (el) => !!el && (el.type === 'arrow' || el.type === 'line');

/**
 * The element a bound end rides on, or null. A connector is never an anchor:
 * its own box moves during this very pass, so binding to it could not be
 * idempotent (and the editor never offers it). A missing id is null too —
 * the store drops those with detachMissingConnectors.
 */
function anchorOf(byId, id) {
  if (!id) return null;
  const target = byId.get(id);
  return target && !isConnector(target) ? target : null;
}

/**
 * Re-derive every bound connector's END points from its `startId`/`endId`.
 *
 * Called after ANY geometry mutation that moved a box (the web store after
 * local and remote edits, and the API after applying every batch, which
 * persists the result). Only the first and last point are ever moved; interior
 * points of a multi-point connector are exactly where the user put them, and so
 * is an unbound end.
 *
 * A bound end with a fixed point (`startFixedPoint` / `endFixedPoint`, see
 * bindingFixedPoint) is PINNED: it lands where the ray from its anchor's
 * centre through that point meets the outline — the spot the user dropped it
 * on, riding along as the shape moves, rotates or resizes — `bindGap` out
 * along the outline's normal there. Any other bound end aims at:
 *  - 2 points, BOTH ends bound: where the other end is pinned, or else the
 *    centre of the OTHER anchor;
 *  - otherwise: its adjacent point (`points[1]` for the start, `points[n-2]`
 *    for the end) — the direction the user drew the connector in.
 * and lands `bindGap(anchor, connector)` outside the anchor's outline (see
 * connectorEndpoint): BIND_GAP for default strokes, more for thicker ones.
 * A fixed point without its `startId`/`endId` is inert (kept, not applied).
 *
 * IDEMPOTENT, and that is not a nicety: the server runs this on every batch
 * and persists the result, and peers run it again on what they receive. Every
 * aim point above is something this function never moves or derives from the
 * connector's own ends (a pinned end, an anchor centre, an interior point, or
 * an unbound end), so one pass is a pure function of the anchors, the pins
 * and the fixed points, and a second pass is a no-op. Aiming an end at the
 * other end's RESOLVED position (unless that end is pinned) would make the
 * two chase each other and creep across the board a little on every save.
 *
 * A two-point connector bound at both ends to the SAME element has no stable
 * aim for an unpinned end (it would aim at the other's moving position, or
 * both at the centre and collapse), so an unpinned end there is left exactly
 * as stored. A binding to another connector, or to an id that is not in the
 * list, is ignored.
 *
 * @param {Object[]} elements
 * @returns {Object[]} a NEW array; elements that do not change keep identity
 *   (an invalid input returns `[]`, an input with nothing bound returns itself)
 */
export function resolveConnectors(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return Array.isArray(elements) ? elements : [];

  // Index by id only if some connector actually needs it.
  const needsIndex = elements.some((e) => isConnector(e) && (e.startId || e.endId));
  if (!needsIndex) return elements;

  const byId = new Map();
  for (const el of elements) byId.set(el.id, el);

  return elements.map((el) => {
    if (!isConnector(el)) return el;
    if (!el.startId && !el.endId) return el;
    const pts = Array.isArray(el.points) && el.points.length >= 2 ? el.points : null;
    if (!pts) return el;
    const n = pts.length;

    const startTarget = anchorOf(byId, el.startId);
    const endTarget = anchorOf(byId, el.endId);
    if (!startTarget && !endTarget) return el;

    const start = pts[0];
    const end = pts[n - 1];
    let s = start;
    let e = end;

    // Pinned ends first: each is a function of its own anchor alone.
    const startPin = startTarget ? pinnedEndpoint(startTarget, el.startFixedPoint, bindGap(startTarget, el)) : null;
    const endPin = endTarget ? pinnedEndpoint(endTarget, el.endFixedPoint, bindGap(endTarget, el)) : null;

    if (n === 2 && startTarget && endTarget) {
      if (startTarget === endTarget) {
        // Self-loop: only a pinned end has a stable aim, see above.
        if (!startPin && !endPin) return el;
        s = startPin ?? start;
        e = endPin ?? end;
      } else {
        // An unpinned end aims at where the other end is pinned, or else at
        // the other anchor's centre.
        s = startPin ?? connectorEndpoint(startTarget, endPin ?? centreOf(endTarget), bindGap(startTarget, el));
        e = endPin ?? connectorEndpoint(endTarget, startPin ?? centreOf(startTarget), bindGap(endTarget, el));
      }
    } else {
      // n === 2 with one end bound aims at the other (free, unmoved) end;
      // n > 2 aims at the interior neighbour, which binding never moves.
      if (startTarget) s = startPin ?? connectorEndpoint(startTarget, pts[1], bindGap(startTarget, el));
      if (endTarget) e = endPin ?? connectorEndpoint(endTarget, pts[n - 2], bindGap(endTarget, el));
    }

    if (s.x === start.x && s.y === start.y && e.x === end.x && e.y === end.y) return el;
    const points = pts.map((p, i) => (i === 0 ? { x: s.x, y: s.y } : i === n - 1 ? { x: e.x, y: e.y } : { x: p.x, y: p.y }));
    return reboxPolyline({ ...el, points });
  });
}

/**
 * The visual midpoint of a connector (half-way along its length), for the
 * label anchor and the midpoint handle. Works for 2..N points; a straight
 * connector gives the plain midpoint of its two ends.
 * @param {Point[]} points
 */
export function connectorMidpoint(points) {
  if (!Array.isArray(points) || points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y };
  if (points.length === 2) {
    const a = points[0];
    const b = points[1];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  if (!(total > EPS)) return { x: points[0].x, y: points[0].y };
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = distance(a, b);
    if (seg >= left && seg > EPS) {
      const t = left / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= seg;
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y };
}

/* ------------------------------------------------------------------ *
 * Snapping
 * ------------------------------------------------------------------ */

/**
 * Snap a value to the nearest multiple of `step` (and to 0), or pass it
 * through when snapping is off.
 * @param {number} v
 * @param {number} step grid size, <= 0 disables
 */
export function snapValue(v, step) {
  if (!step || step <= 0) return v;
  return Math.round(v / step) * step;
}

/**
 * Snap a point to the grid.
 * @param {Point} p
 * @param {number} step
 * @returns {Point}
 */
export function snap(p, step) {
  if (!step || step <= 0) return { x: p.x, y: p.y };
  return { x: snapValue(p.x, step), y: snapValue(p.y, step) };
}

/**
 * Snap a BOX's edges (not its size) to the grid, so a box of an odd width
 * still lands flush. This is what makes snap feel right when creating: you
 * want the left edge and the right edge on grid lines, and the width to be
 * whatever falls out.
 * @param {Rect} r
 * @param {number} step
 * @returns {Rect}
 */
export function snapRect(r, step) {
  if (!step || step <= 0) return { ...r };
  const x = snapValue(r.x, step);
  const y = snapValue(r.y, step);
  return {
    x,
    y,
    w: Math.max(0, snapValue(r.x + r.w, step) - x),
    h: Math.max(0, snapValue(r.y + r.h, step) - y),
  };
}

/** Snap a connector's free endpoint (not the attached one). */
export function snapPoints(points, step) {
  if (!step || step <= 0) return points;
  return points.map((p) => snap(p, step));
}

/* ------------------------------------------------------------------ *
 * Orthogonal connector routing
 * ------------------------------------------------------------------ */

/**
 * Turn a two-point connector into an orthogonal (Manhattan) path, and route
 * it AROUND obstacles when an avoidance list is given.
 *
 * Without obstacles this is the simple 3-segment L that diagram tools draw.
 * With obstacles it runs a coarse grid A* over the obstacle-expanded lattice —
 * coarse on purpose: this runs on a background thread's input cadence, and a
 * fine lattice over a 5000-element board would be a hang, not a feature.
 *
 * @param {Point} a  start
 * @param {Point} b  end
 * @param {object} [opts]
 * @param {Array<{x,y,w,h}>} [opts.obstacles] boxes to route around
 * @param {number} [opts.clearance] board units of padding around each obstacle
 * @param {number} [opts.grid] lattice cell size; defaults to the larger of
 *   16 and a tenth of the path's span, so the search stays small.
 * @returns {Point[]} the routed path INCLUDING a and b as first and last.
 */
export function routeOrthogonal(a, b, opts = {}) {
  const clearance = opts.clearance ?? 8;
  const obstacles = (opts.obstacles || []).filter((o) => o && o.w > 0 && o.h > 0);
  if (obstacles.length === 0) {
    return simpleOrthogonal(a, b);
  }

  const spanX = Math.abs(b.x - a.x);
  const spanY = Math.abs(b.y - a.y);
  const cell = opts.grid ?? Math.max(16, Math.max(spanX, spanY) / 20 || 16);

  // Expand obstacles by the clearance and snap to the lattice, so the search
  // never threads a 1-unit gap between two boxes.
  const pad = clearance + cell * 0.5;
  const blocked = obstacles.map((o) => ({
    x0: snapValue(o.x - pad, cell),
    y0: snapValue(o.y - pad, cell),
    x1: snapValue(o.x + o.w + pad, cell),
    y1: snapValue(o.y + o.h + pad, cell),
  }));

  // The search rectangle must contain the endpoints AND every expanded
  // obstacle; otherwise routing silently clips around something it should
  // have gone through.
  let minX = Math.min(a.x, b.x);
  let minY = Math.min(a.y, b.y);
  let maxX = Math.max(a.x, b.x);
  let maxY = Math.max(a.y, b.y);
  for (const o of blocked) {
    minX = Math.min(minX, o.x0);
    minY = Math.min(minY, o.y0);
    maxX = Math.max(maxX, o.x1);
    maxY = Math.max(maxY, o.y1);
  }
  const margin = cell * 2;
  minX -= margin;
  minY -= margin;
  maxX += margin;
  maxY += margin;

  const cols = Math.min(160, Math.max(2, Math.ceil((maxX - minX) / cell) + 1));
  const rows = Math.min(160, Math.max(2, Math.ceil((maxY - minY) / cell) + 1));
  const ix = (x) => clamp(Math.round((x - minX) / cell), 0, cols - 1);
  const iy = (y) => clamp(Math.round((y - minY) / cell), 0, rows - 1);
  const gx = (i) => minX + i * cell;
  const gy = (j) => minY + j * cell;

  const N = cols * rows;
  const start = iy(a.y) * cols + ix(a.x);
  const goal = iy(b.y) * cols + ix(b.x);
  if (start === goal) return simpleOrthogonal(a, b);

  // g-score, f-score and a binary-heap-backed open set. Plain arrays beat a
  // real priority queue here: the grids are small and a flat array with a
  // linear scan on a 160x160 lattice is still sub-millisecond.
  const g = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const open = new Set();
  const hcost = (idx) => {
    const j = (idx / cols) | 0;
    const i = idx % cols;
    return (Math.abs(ix(b.x) - i) + Math.abs(iy(b.y) - j)) * cell;
  };

  g[start] = 0;
  open.add(start);
  let found = false;
  let guard = 0;
  const GUARD_MAX = N * 4;

  while (open.size > 0 && guard++ < GUARD_MAX) {
    // Pop the lowest f.
    let best = -1;
    let bestF = Infinity;
    for (const idx of open) {
      const f = g[idx] + hcost(idx);
      if (f < bestF) {
        bestF = f;
        best = idx;
      }
    }
    if (best === goal) {
      found = true;
      break;
    }
    open.delete(best);
    closed[best] = 1;
    const j = (best / cols) | 0;
    const i = best % cols;

    for (let d = 0; d < 4; d++) {
      const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const nIdx = nj * cols + ni;
      if (closed[nIdx]) continue;
      const wx = gx(ni);
      const wy = gy(nj);
      if (blocked.some((o) => wx > o.x0 && wx < o.x1 && wy > o.y0 && wy < o.y1)) continue;
      const tentative = g[best] + cell;
      if (tentative < g[nIdx]) {
        g[nIdx] = tentative;
        came[nIdx] = best;
        open.add(nIdx);
      }
    }
  }

  if (!found) return simpleOrthogonal(a, b);

  // Walk the parent chain back, then simplify collinear runs and re-attach
  // the exact endpoints.
  const cellsOut = [];
  let cur = goal;
  let safety = 0;
  while (cur !== -1 && safety++ <= N) {
    cellsOut.push(cur);
    if (cur === start) break;
    cur = came[cur];
  }
  cellsOut.reverse();
  const raw = cellsOut.map((idx) => ({ x: gx(idx % cols), y: gy((idx / cols) | 0) }));
  return simplifyManhattan(raw, a, b);
}

/** The plain 3-segment L between two points. */
function simpleOrthogonal(a, b) {
  if (Math.abs(a.x - b.x) < EPS || Math.abs(a.y - b.y) < EPS) return [{ ...a }, { ...b }];
  const midX = (a.x + b.x) / 2;
  return [
    { x: a.x, y: a.y },
    { x: midX, y: a.y },
    { x: midX, y: b.y },
    { x: b.x, y: b.y },
  ];
}

/** Drop duplicate and collinear interior vertices, then pin the true ends. */
function simplifyManhattan(pts, a, b) {
  if (pts.length < 2) return [{ ...a }, { ...b }];
  const out = [{ ...a }];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const collinear =
      (Math.abs(prev.x - cur.x) < EPS && Math.abs(cur.x - next.x) < EPS) ||
      (Math.abs(prev.y - cur.y) < EPS && Math.abs(cur.y - next.y) < EPS);
    if (collinear) continue;
    out.push({ x: cur.x, y: cur.y });
  }
  out.push({ ...b });
  return out;
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

/** Constrain an angle to `stepDeg` increments (15° by default) for Shift-drag. */
export function constrainAngle(dx, dy, stepDeg = 15) {
  const len = Math.hypot(dx, dy);
  if (len < EPS) return { x: 0, y: 0 };
  const step = (stepDeg * Math.PI) / 180;
  const angle = Math.atan2(dy, dx);
  const snapped = Math.round(angle / step) * step;
  return { x: Math.cos(snapped) * len, y: Math.sin(snapped) * len };
}

/** Keep a rotation within (-PI, PI] so a handle dragged through 10 turns does
 *  not produce a rotation of 62.8 that means nothing. */
export function normalizeAngle(r) {
  if (!Number.isFinite(r)) return 0;
  const twoPi = Math.PI * 2;
  return ((((r + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
}

/** Distance between two points. */
export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Scale `f` about an anchor point — the primitive every resize is built on.
 * @param {Point} p
 * @param {Point} anchor stays fixed
 * @param {number} f
 */
export function scaleAbout(p, anchor, f) {
  return { x: anchor.x + (p.x - anchor.x) * f, y: anchor.y + (p.y - anchor.y) * f };
}

/* ------------------------------------------------------------------ *
 * Small helpers
 *
 * `screenToBoard` / `boardToScreen` (top of this file) take their two
 * arguments in either order, `(view, point)` or `(point, view)`, telling them
 * apart with `isView`: a view carries zoom/pan, a bare point only x/y, so the
 * test is unambiguous. The web editor itself converts with its own
 * `screenToBoardPoint(p, view)` (editor/actions.js); these are for tests and
 * scripts. The web store clamps every zoom with `clampZoom` below.
 * ------------------------------------------------------------------ */

/** A view carries zoom/pan; a bare point carries only x/y. */
const isView = (v) => v != null && typeof v === 'object' && ('zoom' in v || 'panX' in v || 'panY' in v);

/** Clamp a zoom level into range: `clampZoom(z)` (ZOOM_LIMITS) or `clampZoom(z, min, max)`. */
export function clampZoom(z, min, max) {
  if (!Number.isFinite(z) || z <= 0) return 1;
  return clamp(z, min ?? ZOOM_LIMITS.min, max ?? ZOOM_LIMITS.max);
}

/** Centre of a rect. */
export function rectCenter(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Alias of rectCenter. */
export function rectCenterPoint(r) {
  return rectCenter(r);
}

/** The four corners of an element's box, rotated if the element is rotated. */
export function cornersOf(el) {
  return boxCorners({ x: el.x, y: el.y, w: el.w, h: el.h }, el.rotation || 0);
}

/** Axis-aligned size of a rotated element. */
export function rotatedSize(el) {
  const r = el.rotation || 0;
  if (!r) return { w: el.w, h: el.h };
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { w: el.w * c + el.h * s, h: el.w * s + el.h * c };
}

/** Snap both axes of a point to the grid. */
export function snapPoint(p, step) {
  if (!step || step <= 0) return { x: p.x, y: p.y };
  return { x: snapValue(p.x, step), y: snapValue(p.y, step) };
}

/**
 * Drop `startId`/`endId` pointing at elements no longer in the list. A
 * connector whose anchor was deleted can otherwise never be repositioned
 * again, because every resolve pass looks up an id that does not exist.
 * A `startFixedPoint`/`endFixedPoint` stays: without its id it is inert, and
 * the clients' own twins of this helper leave it too.
 * @param {Object[]} elements
 * @returns {Object[]} the same array, mutated in place
 */
export function detachMissingConnectors(elements) {
  if (!Array.isArray(elements)) return elements;
  const ids = new Set(elements.map((el) => el.id));
  for (const el of elements) {
    if (el.type !== 'arrow' && el.type !== 'line') continue;
    if (el.startId && !ids.has(el.startId)) delete el.startId;
    if (el.endId && !ids.has(el.endId)) delete el.endId;
  }
  return elements;
}

/**
 * Fit a list of boxes into a viewport, padded and centred:
 * `fitViewCompat(boxes, vw, vh, pad)`, or `fitViewCompat(bounds, vw, vh, pad)`
 * for a single box: fitView over the union of the boxes.
 */
export function fitViewCompat(boxes, vw, vh, pad) {
  const list = Array.isArray(boxes) ? boxes : boxes ? [boxes] : [];
  if (list.length === 0 || !vw || !vh) return { zoom: 1, panX: 0, panY: 0 };
  let bounds = list[0];
  for (let i = 1; i < list.length; i++) bounds = unionRect(bounds, list[i]);
  return fitView(bounds, { width: vw, height: vh, padding: pad });
}
