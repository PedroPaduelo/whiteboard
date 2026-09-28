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
 *    CENTRE. Elements store an axis-aligned, always-tight `x/y/w/h` even when
 *    rotated, so there is exactly one rectangular source of truth and paint,
 *    hit-testing, snapping and export can never disagree about the box.
 *  - Screen points are CSS pixels relative to the canvas element's top-left.
 */

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
 * @param {{min?:number, max?:number}} [limits]
 * @returns {View} a NEW view; never mutates the input.
 */
export function zoomAt(view, screenPt, factor, limits = {}) {
  const min = limits.min ?? 0.05;
  const max = limits.max ?? 8;
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
  const min = viewport.min ?? 0.05;
  const max = viewport.max ?? 8;
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
 * similar gap). `resolveConnectors` uses it for every bound end.
 */
export const BIND_GAP = 4;

/** Which outline an element presents to a connector. Anything unknown (and a
 *  bare `{x,y,w,h}` box) is a box. */
function outlineKind(el) {
  const t = el && el.type;
  if (t === 'ellipse') return 'ellipse';
  if (t === 'diamond') return 'diamond';
  return 'box';
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
 * The outline follows the shape — rect/sticky/text/image/cylinder use the box,
 * `ellipse` the ellipse, `diamond` the rhombus — and the element's `rotation`
 * (radians, clockwise, about the box centre): `toward` is rotated into the
 * element's unrotated frame, intersected there, and the result is rotated
 * back out. A bare `{x,y,w,h}` is treated as an unrotated box, which is what
 * callers written before this was shape-aware pass.
 *
 * We pick the intersection toward the other end rather than a fixed anchor
 * because it is stable as the other end moves and never runs through a corner
 * the way a fixed port does.
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
  const dx = local.x - cx;
  const dy = local.y - cy;
  const len = Math.hypot(dx, dy);
  // No direction (the other end sits on the centre): the centre is the only
  // honest answer, and it is stable.
  if (!(len > EPS)) return { x: cx, y: cy };

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
 * A bound end aims at:
 *  - 2 points, BOTH ends bound: the centre of the OTHER anchor;
 *  - otherwise: its adjacent point (`points[1]` for the start, `points[n-2]`
 *    for the end) — the direction the user drew the connector in.
 * and lands BIND_GAP outside the anchor's outline (see connectorEndpoint).
 *
 * IDEMPOTENT, and that is not a nicety: the server runs this on every batch
 * and persists the result, and peers run it again on what they receive. Every
 * aim point above is something this function never moves (an anchor centre,
 * an interior point, or an unbound end), so one pass is a pure function of the
 * anchors and the fixed points and a second pass is a no-op. Aiming an end at
 * the other end's RESOLVED position would make the two chase each other and
 * creep across the board a little on every save.
 *
 * A two-point connector bound at both ends to the SAME element has no stable
 * aim (each end would aim at the other's moving position, or both at the
 * centre and collapse), so it is left exactly as stored. A binding to another
 * connector, or to an id that is not in the list, is ignored.
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

    if (n === 2 && startTarget && endTarget) {
      if (startTarget === endTarget) return el; // self-loop: no stable aim, see above
      s = connectorEndpoint(startTarget, centreOf(endTarget), BIND_GAP);
      e = connectorEndpoint(endTarget, centreOf(startTarget), BIND_GAP);
    } else {
      // n === 2 with one end bound aims at the other (free, unmoved) end;
      // n > 2 aims at the interior neighbour, which binding never moves.
      if (startTarget) s = connectorEndpoint(startTarget, pts[1], BIND_GAP);
      if (endTarget) e = connectorEndpoint(endTarget, pts[n - 2], BIND_GAP);
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
 * Compatibility layer
 *
 * Two agents wrote geometry independently during the parallel build and
 * disagreed on ARGUMENT ORDER for the view transforms: the documented form
 * here is `screenToBoard(view, point)`, while the web side adopted
 * `screenToBoard(point, view)`. Both are in use, and rewriting call sites
 * across five in-flight agents costs far more than accepting both, so the
 * canonical transform detects the order it was handed. A view carries
 * zoom/pan; a bare point carries only x/y — the test is unambiguous.
 *
 * The rest of this block is the surface the store and the interaction reducer
 * were written against before the two geometries were reconciled.
 * ------------------------------------------------------------------ */

/** A view carries zoom/pan; a bare point carries only x/y. */
const isView = (v) => v != null && typeof v === 'object' && ('zoom' in v || 'panX' in v || 'panY' in v);

/** Clamp a zoom level into range: `clampZoom(z)` or `clampZoom(z, min, max)`. */
export function clampZoom(z, min, max) {
  if (!Number.isFinite(z) || z <= 0) return 1;
  return clamp(z, min ?? 0.05, max ?? 8);
}

/** Centre of a rect. */
export function rectCenter(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Centre of a rect, as a point — the name the canvas agent reaches for. */
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
 * for a single box. This is the array form the store's `fitToContent` uses.
 */
export function fitViewCompat(boxes, vw, vh, pad) {
  const list = Array.isArray(boxes) ? boxes : boxes ? [boxes] : [];
  if (list.length === 0 || !vw || !vh) return { zoom: 1, panX: 0, panY: 0 };
  let bounds = list[0];
  for (let i = 1; i < list.length; i++) bounds = unionRect(bounds, list[i]);
  return fitView(bounds, { width: vw, height: vh, padding: pad });
}
