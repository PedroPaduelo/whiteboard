/**
 * hitTest.js — "what is under the cursor?"
 *
 * This is pure geometry over the element array, with no DOM and no canvas, so
 * it is testable in node and cheap enough to call on every pointermove.
 *
 * Two rules that make selection feel right, both easy to get wrong:
 *
 *  1. TOLERANCE IS IN SCREEN PIXELS. The caller passes the 6px slop a finger
 *     needs; we convert to board units with `tolerance / zoom`. Use screen
 *     pixels directly and selection becomes impossible at 25% zoom and
 *     absurdly sticky at 400%.
 *
 *  2. TEST WHAT IS PAINTED. A transparent rect is still clickable in its
 *     body, because you drew it and you expect to grab it. A diamond is NOT
 *     clickable in the corner of its bounding box — that corner is not part
 *     of the diamond, and a bbox test there is the classic "why can I click
 *     empty space" bug.
 *
 * Elements are tested in reverse array order, so the topmost wins, matching
 * paint order.
 */

import {
  distToSegmentSq,
  pointInPolygon,
  rectsIntersect,
  rotatePoint,
  connectorEndpoint,
  normalizeRect,
} from '@whiteboard/shared';
import { hasFill, textHeight } from './shapes.js';

/** Default slop, in SCREEN pixels. */
export const DEFAULT_TOLERANCE = 6;

/** How far (screen px) from an element an arrow end will snap onto it. */
export const CONNECTOR_SNAP_TOLERANCE = 14;

/**
 * Normalise options once per call — this runs in a hot loop and must not
 * allocate a fresh options object per element.
 */
function tol(tolerance, view) {
  const zoom = view && view.zoom ? view.zoom : 1;
  return Math.max(0.5, (tolerance == null ? DEFAULT_TOLERANCE : tolerance) / zoom);
}

/** The element's effective stroke width in board units (min 1 for grabbing). */
function grabWidth(el) {
  return Math.max(1, (el.strokeWidth === undefined ? 2 : el.strokeWidth) / 2);
}

/* ------------------------------------------------------------------ *
 * Per-type tests, in the element's OWN unrotated frame.
 * ------------------------------------------------------------------ */

/** `p` is already inverse-rotated. Returns true when it hits. */
function hitsUnrotated(el, p, t) {
  switch (el.type) {
    case 'rect':
    case 'cylinder':
    case 'sticky':
    case 'image': {
      // The WHOLE box is grabbable, interior included, fill or not. A rect you
      // just drew with `fill: 'none'` is still an object the user expects to
      // be able to click and drag by its body — the same rule every diagram
      // tool uses. `image` and `sticky` are always solid anyway.
      if (p.x >= el.x - t && p.x <= el.x + el.w + t && p.y >= el.y - t && p.y <= el.y + el.h + t) {
        return true;
      }
      // Just outside: only the outline band counts, so a click beside a shape
      // does not grab it.
      return nearRectOutline(p, el, t + grabWidth(el));
    }

    case 'ellipse': {
      const cx = el.x + el.w / 2;
      const cy = el.y + el.h / 2;
      const rx = Math.max(el.w / 2, t);
      const ry = Math.max(el.h / 2, t);
      const dx = (p.x - cx) / rx;
      const dy = (p.y - cy) / ry;
      // Interior is grabbable fill or not — the same rule the rect follows, so
      // clicking a shape's body always works regardless of its type.
      return dx * dx + dy * dy <= 1;
    }

    case 'diamond': {
      const cx = el.x + el.w / 2;
      const cy = el.y + el.h / 2;
      const poly = [
        { x: cx, y: el.y },
        { x: el.x + el.w, y: cy },
        { x: cx, y: el.y + el.h },
        { x: el.x, y: cy },
      ];
      // The polygon, not the bounding box: the corners of a diamond's bbox are
      // not part of the diamond, and a bbox test there is how you end up
      // selecting empty space.
      if (pointInPolygon(p, poly)) return true;
      // Just outside the shape: the outline band only.
      const band = t + grabWidth(el);
      for (let i = 0; i < 4; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % 4];
        if (distToSegmentSq(p, a, b) <= band * band) return true;
      }
      return false;
    }

    case 'text': {
      // The measured box: text is laid out from the top-left, so the clickable
      // region is the wrapped lines' extent, not necessarily the element box.
      const lines = (el.text || '').split('\n');
      const h = Math.max(el.h, textHeight(el));
      const w = Math.max(el.w, 8);
      if (p.x >= el.x - t && p.x <= el.x + w + t && p.y >= el.y - t && p.y <= el.y + h + t) {
        // Inside the box: hit if the glyphs actually reach there.
        if (lines.some((l) => l.length > 0)) return true;
      }
      return false;
    }

    case 'pen':
    case 'line':
    case 'arrow': {
      const pts = el.points || [];
      if (pts.length === 0) return false;
      const band = t + grabWidth(el);
      const t2 = band * band;
      if (pts.length === 1) {
        const dx = p.x - pts[0].x;
        const dy = p.y - pts[0].y;
        return dx * dx + dy * dy <= t2;
      }
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSegmentSq(p, pts[i], pts[i + 1]) <= t2) return true;
      }
      // An arrow is also grabbable by its head, which sits at the end point —
      // the segment test already covers it, but a fat head on a very short
      // arrow is worth catching: accept the tip's neighbourhood.
      return false;
    }

    default: {
      const r = normalizeRect(el);
      return p.x >= r.x - t && p.x <= r.x + r.w + t && p.y >= r.y - t && p.y <= r.y + r.h + t;
    }
  }
}

/** Distance from a point to a rect's outline, in board units. */
function nearRectOutline(p, r, band) {
  const b2 = band * band;
  const segs = [
    [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }],
    [{ x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }],
    [{ x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }],
    [{ x: r.x, y: r.y + r.h }, { x: r.x, y: r.y }],
  ];
  for (let i = 0; i < 4; i++) {
    if (distToSegmentSq(p, segs[i][0], segs[i][1]) <= b2) return true;
  }
  return false;
}

/** Does `el` contain board point `p`? Rotation-aware. */
export function hitElement(el, p, tolerance = DEFAULT_TOLERANCE, view = { zoom: 1 }) {
  if (!el || !el.type) return false;
  const t = tol(tolerance, view);
  // A rotated element is tested in its own frame, so the inverse rotation is
  // applied first. Unrotated elements short-circuit — that is the common case
  // and it must not pay for a trig call.
  const local = el.rotation ? rotatePoint(p, el, el.rotation) : p;
  return hitsUnrotated(el, local, t);
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Topmost element id under `p`, or null.
 * @param {Array<object>} elements in z-order, index 0 furthest back
 * @param {{x:number,y:number}} p board point
 * @param {{tolerance?:number, view?:{zoom:number}}} [opts]
 * @returns {string|null}
 */
export function hitTest(elements, p, opts = {}) {
  if (!elements || !elements.length || !p) return null;
  const tolerance = opts.tolerance;
  const view = opts.view || { zoom: 1 };
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!el) continue;
    if (hitElement(el, p, tolerance, view)) return el.id;
  }
  return null;
}

/**
 * Every element under `p`, topmost first. Alt-click multi-select walks this
 * list: each successive alt-click takes the next hit below the current one.
 * @returns {string[]}
 */
export function hitTestAll(elements, p, opts = {}) {
  if (!elements || !elements.length || !p) return [];
  const tolerance = opts.tolerance;
  const view = opts.view || { zoom: 1 };
  const out = [];
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!el) continue;
    if (hitElement(el, p, tolerance, view)) out.push(el.id);
  }
  return out;
}

/**
 * Every element whose bounding box intersects `rect` — the marquee.
 *
 * Deliberately a BOUNDS test, not a shape test: a rubber band that only
 * catches fully-enclosed shapes is frustrating, and a user dragging a band
 * around a flowchart expects everything it visibly covers.
 * @returns {string[]}
 */
export function elementsInRect(elements, rect) {
  if (!elements || !elements.length || !rect) return [];
  const box = normalizeRect(rect);
  const out = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el) continue;
    if (rectsIntersect(el, box)) out.push(el.id);
  }
  return out;
}

/**
 * For a marquee whose WIDTH OR HEIGHT IS ZERO (a click-drag along a single
 * axis, or the common "flick" gesture), `rectsIntersect` is always false
 * because a zero-area box has no area. Fall back to a containment test on the
 * perpendicular axis so a horizontal drag still selects what it swept.
 */
export function elementsInSweep(elements, rect) {
  const box = normalizeRect(rect);
  if (box.w > 0 && box.h > 0) return elementsInRect(elements, box);
  // Degenerate: sweep a 1-unit band so a flat drag still selects.
  const band =
    box.w === 0 && box.h === 0
      ? { x: box.x - 0.5, y: box.y - 0.5, w: 1, h: 1 }
      : box.w === 0
        ? { x: box.x - 0.5, y: box.y, w: 1, h: box.h }
        : { x: box.x, y: box.y - 0.5, w: box.w, h: 1 };
  return elementsInRect(elements, band);
}

/**
 * Which end of a connector, if either, should attach to an element.
 *
 * This is what makes "arrows stay attached when the box moves" discoverable:
 * you drag an arrow end onto a box, it snaps, and from then on it follows.
 * Only NEAR an end — dropping an arrow through the middle of a shape attaches
 * nothing, which is the behaviour people expect from a drawing tool.
 *
 * @param {Array<object>} elements
 * @param {{points:Array<{x:number,y:number}>}} connector
 * @param {{x:number,y:number}} p board point (the dragged end)
 * @param {number} [tol] screen px
 * @param {{zoom?:number}} [view]
 * @returns {{startId?:string, endId?:string}} whichever end attached (usually one)
 */
export function hitTestConnectorEnd(elements, connector, p, tolPx = CONNECTOR_SNAP_TOLERANCE, view = { zoom: 1 }) {
  const out = {};
  if (!connector || !connector.points || connector.points.length < 2) return out;
  const t = tolPx / (view && view.zoom ? view.zoom : 1);
  const [a, b] = connector.points;
  const nearStart = Math.hypot(p.x - a.x, p.y - a.y) <= t * 1.5;
  const nearEnd = Math.hypot(p.x - b.x, p.y - b.y) <= t * 1.5;
  if (!nearStart && !nearEnd) return out;

  // Find the closest element that is NOT the connector itself, topmost first.
  const target = findAttachTarget(elements, p, t, connector.id);
  if (!target) return out;

  if (nearStart) out.startId = target.id;
  if (nearEnd) out.endId = target.id;
  return out;
}

/**
 * The topmost attachable element near `p`, or null. Attachables are the
 * boxed kinds; connecting to a pen stroke's middle is meaningless and always
 * surprises.
 */
export function findAttachTarget(elements, p, t, excludeId) {
  if (!elements || !elements.length) return null;
  const ATTACHABLE = new Set(['rect', 'ellipse', 'diamond', 'cylinder', 'sticky', 'image', 'text']);
  let best = null;
  let bestD = Infinity;
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!el || el.id === excludeId) continue;
    if (!ATTACHABLE.has(el.type)) continue;
    const local = el.rotation ? rotatePoint(p, el, el.rotation) : p;
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    // Distance to the box perimeter, and only if within tolerance of it —
    // attaching from the middle of a big box would be surprising.
    const dx = Math.max(el.x - local.x, 0, local.x - (el.x + el.w));
    const dy = Math.max(el.y - local.y, 0, local.y - (el.y + el.h));
    const d = Math.hypot(dx, dy);
    if (d > t * 1.5) continue;
    const centreD = Math.hypot(p.x - cx, p.y - cy);
    if (centreD < bestD) {
      bestD = centreD;
      best = el;
    }
  }
  return best;
}

/**
 * Where a connector end should land on `target`, given the other end. Thin
 * wrapper so the interaction reducer does not re-derive the rule.
 */
export function endpointOn(target, otherEnd) {
  return connectorEndpoint(target, otherEnd);
}

/**
 * The union of the bounding boxes of `ids`. This is what the selection
 * outline and the resize handles are drawn around.
 * @returns {{x,y,w,h}|null}
 */
export function selectionBounds(elements, ids) {
  if (!elements || !ids) return null;
  const set = ids instanceof Set ? ids : new Set(ids);
  // A Set has `.size`, not `.length`. Testing `.length` here silently returned
  // null for every real selection (the store's selection is a Set), which
  // turned off the resize and rotate handles entirely.
  if (set.size === 0) return null;
  let out = null;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el || !set.has(el.id)) continue;
    if (out === null) {
      out = { x: el.x, y: el.y, w: el.w, h: el.h };
    } else {
      // The far edges are read off the PREVIOUS box before it is rewritten,
      // so the running max is against the old origin and not against one
      // already shifted. Getting that wrong silently shrinks the union — and
      // the selection frame, and every resize keyed off it.
      const x0 = Math.min(out.x, el.x);
      const y0 = Math.min(out.y, el.y);
      const x1 = Math.max(out.x + out.w, el.x + el.w);
      const y1 = Math.max(out.y + out.h, el.y + el.h);
      out = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
  }
  return out;
}
