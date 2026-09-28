/**
 * scene.js — pure geometry over elements: groups, move, resize, rotate,
 * connector re-binding and grid snapping.
 *
 * Every function here takes the ORIGINAL elements of a gesture (as they were
 * at pointerdown) plus the current pointer, and returns store patches
 * `{id, patch}[]` for the absolute result. Computing from the originals every
 * frame, never from the previous frame, is what keeps a long drag free of
 * accumulated rounding drift and makes the functions trivially testable.
 *
 * Model rules this module enforces (see packages/shared):
 *  - Boxes store an UNROTATED x/y/w/h plus `rotation` (radians, clockwise,
 *    about the box centre). Resizing a rotated box keeps the opposite corner
 *    fixed on screen, which means the box centre moves along the rotated axes.
 *  - pen/arrow/line have their box derived from `points`: they are moved,
 *    scaled and rotated by rewriting `points` (on fresh objects — the shared
 *    translatePolyline/scalePolylinePoints mutate in place, so they are not
 *    used here). Rotating a polyline bakes the rotation into its points; the
 *    selection frame of a polyline is always axis-aligned.
 *  - Bound connector ends are owned by the shared `resolveConnectors`, the
 *    exact function the server runs after every batch, so the points we send
 *    are the points the server persists.
 *  - Locked elements never move: every transform skips them.
 *
 * No DOM, no store: safe in node tests.
 */

import { boundsOfPoints, reboxPolyline, resolveConnectors, normalizeAngle, snapValue } from '@whiteboard/shared';
import { BIND_DISTANCE } from './constants.js';
import { hasPoints, isLinear, isText, isBindable } from './elements.js';
import { commonBounds, rotateAround } from './handles.js';
import { hitShape } from './hitTest.js';

const EPS = 1e-6;
const FONT_MIN = 4;
const FONT_MAX = 512;
const DEFAULT_TEXT_FONT = 24; // what the shared validator gives a text without fontSize

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const centreOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const clonePoints = (points) => points.map((p) => ({ x: p.x, y: p.y }));
const toSet = (ids) => (ids instanceof Set ? ids : new Set(ids ?? []));

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

/**
 * Every element in group `groupId`: those carrying that `groupId`, plus the
 * element whose own id IS the group key (legacy frames: a dashed rect whose
 * children point at it).
 */
export function groupMembers(elements, groupId) {
  if (!groupId) return [];
  return elements.filter((el) => el.groupId === groupId || el.id === groupId);
}

/**
 * Grow a list of ids to whole groups, transitively (a frame that is itself in
 * a group pulls that outer group in too — Excalidraw selects the outermost
 * group). Returns ids in z-order.
 */
export function expandSelectionToGroups(elements, ids) {
  const want = toSet(ids);
  if (want.size === 0) return [];
  const usedAsGroup = new Set();
  for (const el of elements) if (el.groupId) usedAsGroup.add(el.groupId);
  const groups = new Set();
  // Fixed point: each pass may discover an outer group through a frame.
  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const el of elements) {
      const member = want.has(el.id) || (el.groupId && groups.has(el.groupId)) || groups.has(el.id);
      if (!member) continue;
      if (!want.has(el.id)) {
        want.add(el.id);
        grew = true;
      }
      if (el.groupId && !groups.has(el.groupId)) {
        groups.add(el.groupId);
        grew = true;
      }
      if (usedAsGroup.has(el.id) && !groups.has(el.id)) {
        groups.add(el.id);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return elements.filter((el) => want.has(el.id)).map((el) => el.id);
}

/* ------------------------------------------------------------------ *
 * Frames
 * ------------------------------------------------------------------ */

/**
 * The UNPADDED transform frame of a set of elements: the box resize and
 * rotation are computed against. One element: its own box and rotation
 * (polylines: their points' bounds, rotation 0). Several: the axis-aligned
 * union of their painted bounds, rotation 0. Mirrors handles.selectionFrame
 * minus the padding.
 */
export function transformFrame(elements) {
  if (!elements || elements.length === 0) return null;
  if (elements.length === 1) {
    const el = elements[0];
    if (hasPoints(el)) return { ...boundsOfPoints(el.points), rotation: 0 };
    return { x: el.x, y: el.y, w: el.w, h: el.h, rotation: el.rotation || 0 };
  }
  return { ...commonBounds(elements), rotation: 0 };
}

/** Board position of a handle on an (unpadded) frame, rotated with it. */
export function handlePoint(frame, key) {
  const { x, y, w, h } = frame;
  const hx = key.includes('e') ? 1 : key.includes('w') ? -1 : 0;
  const hy = key.includes('s') ? 1 : key.includes('n') ? -1 : 0;
  const p = { x: x + (w * (hx + 1)) / 2, y: y + (h * (hy + 1)) / 2 };
  return frame.rotation ? rotateAround(p, centreOf(frame), frame.rotation) : p;
}

/* ------------------------------------------------------------------ *
 * Applying patches (simulation of the store's merge, for binding passes)
 * ------------------------------------------------------------------ */

/**
 * The element list after `patches`, merged the way the store merges them:
 * several patches for one id apply in order, a null value deletes the key,
 * polylines re-box from their points. Unchanged elements keep identity.
 */
export function applyPatches(elements, patches) {
  if (!patches || patches.length === 0) return elements;
  const byId = new Map();
  for (const p of patches) {
    if (!p || !p.id || !p.patch) continue;
    byId.set(p.id, byId.has(p.id) ? { ...byId.get(p.id), ...p.patch } : p.patch);
  }
  return elements.map((el) => {
    const patch = byId.get(el.id);
    if (!patch) return el;
    const out = { ...el };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || k === 'type') continue;
      if (v === null || v === undefined) delete out[k];
      else out[k] = v;
    }
    return hasPoints(out) && Array.isArray(out.points) && 'points' in patch ? reboxPolyline(out) : out;
  });
}

/* ------------------------------------------------------------------ *
 * Move
 * ------------------------------------------------------------------ */

/**
 * Translate `originals` by (dx, dy). Boxes patch x/y; polylines patch fresh
 * points. A moved connector whose bound element is NOT moving with it comes
 * unbound at that end (`startId: null`), as in Excalidraw — otherwise the
 * binding pass would snap the end straight back onto the shape.
 * Locked elements are skipped.
 */
export function moveElements(originals, dx, dy) {
  const movable = originals.filter((el) => !el.locked);
  const moving = new Set(movable.map((el) => el.id));
  return movable.map((el) => {
    if (hasPoints(el)) {
      const patch = { points: el.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
      if (isLinear(el)) {
        if (el.startId && !moving.has(el.startId)) patch.startId = null;
        if (el.endId && !moving.has(el.endId)) patch.endId = null;
      }
      return { id: el.id, patch };
    }
    return { id: el.id, patch: { x: el.x + dx, y: el.y + dy } };
  });
}

/* ------------------------------------------------------------------ *
 * Resize
 * ------------------------------------------------------------------ */

function handleAxes(handle) {
  return {
    hx: handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0,
    hy: handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0,
  };
}

const ratio = (num, den) => (Math.abs(den) < EPS ? 1 : num / den);

/**
 * The scale transform produced by dragging `handle` of `box` to `p` (all in
 * the box's own unrotated frame). Returns the anchor (the point that stays
 * fixed: the opposite edge/corner, or the centre with `fromCenter`) and the
 * SIGNED scale factors (negative = flipped past the anchor).
 *
 * keepAspect: corners take the larger of the two factors (Excalidraw); side
 * handles scale the other axis by the same amount, about the centre.
 */
export function resizeTransform(box, handle, p, { keepAspect = false, fromCenter = false } = {}) {
  const { hx, hy } = handleAxes(handle);
  const c = centreOf(box);
  const ax = fromCenter || hx === 0 ? c.x : hx > 0 ? box.x : box.x + box.w;
  const ay = fromCenter || hy === 0 ? c.y : hy > 0 ? box.y : box.y + box.h;
  const ex = hx > 0 ? box.x + box.w : box.x;
  const ey = hy > 0 ? box.y + box.h : box.y;
  let sx = hx === 0 ? 1 : ratio(p.x - ax, ex - ax);
  let sy = hy === 0 ? 1 : ratio(p.y - ay, ey - ay);
  if (keepAspect) {
    if (hx !== 0 && hy !== 0) {
      const m = Math.max(Math.abs(sx), Math.abs(sy));
      sx = (sx < 0 ? -1 : 1) * m;
      sy = (sy < 0 ? -1 : 1) * m;
    } else if (hx !== 0) {
      sy = Math.abs(sx);
    } else if (hy !== 0) {
      sx = Math.abs(sy);
    }
  }
  return { ax, ay, sx, sy, hx, hy };
}

function scaleBox(box, t) {
  const x1 = t.ax + (box.x - t.ax) * t.sx;
  const x2 = t.ax + (box.x + box.w - t.ax) * t.sx;
  const y1 = t.ay + (box.y - t.ay) * t.sy;
  const y2 = t.ay + (box.y + box.h - t.ay) * t.sy;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

const scalePoint = (q, t) => ({ x: t.ax + (q.x - t.ax) * t.sx, y: t.ay + (q.y - t.ay) * t.sy });

function textFont(el) {
  return Number.isFinite(el.fontSize) ? el.fontSize : DEFAULT_TEXT_FONT;
}

/** One element, possibly rotated, resized through its own frame. */
function resizeSingle(el, frame, handle, pointer, opts) {
  const r = frame.rotation || 0;
  const box = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
  const c = centreOf(box);
  const local = r ? rotateAround(pointer, c, -r) : pointer;
  let keepAspect = Boolean(opts.keepAspect);
  if (el.type === 'image') keepAspect = !keepAspect; // images keep their proportions unless Shift
  if (isText(el)) keepAspect = true; // text scales, it never stretches
  const t = resizeTransform(box, handle, local, { keepAspect, fromCenter: Boolean(opts.fromCenter) });
  const patch = {};

  if (isText(el)) {
    // Text never mirrors; its font scales with the box and is clamped to
    // what the validator accepts, and the box follows the clamped scale.
    const s0 = t.hx !== 0 ? Math.abs(t.sx) : Math.abs(t.sy);
    const f0 = textFont(el);
    const f = clamp(f0 * s0, FONT_MIN, FONT_MAX);
    const s = f / f0;
    t.sx = s;
    t.sy = s;
    patch.fontSize = f;
  }

  if (hasPoints(el)) {
    // Polyline frames are axis-aligned (rotation 0): map the points directly.
    return { id: el.id, patch: { points: el.points.map((q) => scalePoint(q, t)) } };
  }

  const nb = scaleBox(box, t);
  const nc = centreOf(nb);
  // The new box is expressed in the ORIGINAL frame; rotating its centre about
  // the original centre keeps the anchor fixed on screen.
  const wc = r ? rotateAround(nc, c, r) : nc;
  patch.x = wc.x - nb.w / 2;
  patch.y = wc.y - nb.h / 2;
  patch.w = nb.w;
  patch.h = nb.h;
  return { id: el.id, patch };
}

/**
 * Resize.
 *
 * @param {object[]} originals  the selection at pointerdown
 * @param {{x,y,w,h,rotation}|null} frame  the UNPADDED frame at pointerdown
 *   (`transformFrame(originals)`, computed when null)
 * @param {string} handle  'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw'
 * @param {{x,y}} pointer  where the dragged handle is now, board units
 * @param {{keepAspect?:boolean, fromCenter?:boolean}} [opts]
 * @returns {{id, patch}[]}
 *
 * One element: resized in its own rotated frame, opposite corner fixed; text
 * scales its fontSize; images keep their aspect unless keepAspect (Shift).
 * Several: positions and sizes scale about the anchor of the common box;
 * rotated members keep their angle (mirrored when flipped on one axis);
 * polylines scale their points; text scales its font on corner (or
 * aspect-locked) drags and only moves on a free side drag.
 */
export function resizeElements(originals, frame, handle, pointer, opts = {}) {
  const list = originals.filter((el) => !el.locked);
  if (list.length === 0 || !handle || handle === 'rotation' || !pointer) return [];
  const f = frame ?? transformFrame(list);
  if (list.length === 1 && originals.length === 1) return [resizeSingle(list[0], f, handle, pointer, opts)];

  const t = resizeTransform(f, handle, pointer, opts);
  const asx = Math.abs(t.sx);
  const asy = Math.abs(t.sy);
  const mirrored = t.sx < 0 !== t.sy < 0;
  const uniformText = (t.hx !== 0 && t.hy !== 0) || opts.keepAspect ? Math.min(asx, asy) : 1;
  const out = [];
  for (const el of list) {
    if (hasPoints(el)) {
      out.push({ id: el.id, patch: { points: el.points.map((q) => scalePoint(q, t)) } });
      continue;
    }
    const nc = scalePoint(centreOf(el), t);
    let rot = el.rotation || 0;
    if (mirrored) rot = -rot;
    const patch = {};
    let w;
    let h;
    if (isText(el)) {
      const f0 = textFont(el);
      const fs = clamp(f0 * uniformText, FONT_MIN, FONT_MAX);
      const s = fs / f0;
      if (fs !== f0) patch.fontSize = fs;
      w = el.w * s;
      h = el.h * s;
    } else if (rot) {
      // A rotated box under a non-uniform scale: keep its angle, stretch each
      // of its own axes by how much the scale stretches that direction.
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      w = el.w * Math.hypot(asx * cos, asy * sin);
      h = el.h * Math.hypot(asx * sin, asy * cos);
      rot = Math.atan2(asy * sin, asx * cos);
    } else {
      w = el.w * asx;
      h = el.h * asy;
    }
    patch.x = nc.x - w / 2;
    patch.y = nc.y - h / 2;
    patch.w = w;
    patch.h = h;
    if ((el.rotation || 0) !== rot) patch.rotation = normalizeAngle(rot);
    out.push({ id: el.id, patch });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Rotate
 * ------------------------------------------------------------------ */

const STEP_15 = Math.PI / 12;

/**
 * Rotate about the frame centre so the rotation handle (which sits above the
 * centre) points at `pointer`. `snap15` snaps the resulting angle (single
 * element) or the turn (several elements) to 15° steps.
 *
 * Boxes turn their `rotation` (and orbit the centre when several are
 * selected); polylines have the turn baked into their points. A lone
 * connector is not rotatable (shared resolveConnectors ignores rotation).
 */
export function rotateElements(originals, frame, pointer, { snap15 = false } = {}) {
  const list = originals.filter((el) => !el.locked);
  if (list.length === 0 || !pointer) return [];
  if (list.length === 1 && isLinear(list[0])) return [];
  const f = frame ?? transformFrame(list);
  const c = centreOf(f);
  let target = Math.atan2(pointer.y - c.y, pointer.x - c.x) + Math.PI / 2;
  if (snap15) target = Math.round(target / STEP_15) * STEP_15;
  const delta = target - (f.rotation || 0);
  const out = [];
  for (const el of list) {
    if (hasPoints(el)) {
      out.push({ id: el.id, patch: { points: el.points.map((q) => rotateAround(q, c, delta)) } });
      continue;
    }
    const ec = centreOf(el);
    const nc = list.length === 1 ? ec : rotateAround(ec, c, delta);
    let rotation = normalizeAngle((el.rotation || 0) + delta);
    if (Math.abs(rotation) < 1e-9) rotation = 0;
    const patch = { rotation };
    if (list.length > 1) {
      patch.x = nc.x - el.w / 2;
      patch.y = nc.y - el.h / 2;
    }
    out.push({ id: el.id, patch });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Binding
 * ------------------------------------------------------------------ */

function samePoints(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].x - b[i].x) > EPS || Math.abs(a[i].y - b[i].y) > EPS) return false;
  }
  return true;
}

/**
 * Patches for the connectors that must follow `changedIds`: every arrow/line
 * bound to a changed element (or itself changed) is re-resolved with the
 * shared `resolveConnectors` against `nextElements` (the list AFTER the
 * gesture's own patches), and only those whose points actually moved are
 * returned. Include them in the SAME updateElements batch as the gesture.
 */
export function resolveBindingPatches(nextElements, changedIds) {
  if (!Array.isArray(nextElements) || nextElements.length === 0) return [];
  const changed = toSet(changedIds);
  if (changed.size === 0) return [];
  const resolved = resolveConnectors(nextElements);
  if (!Array.isArray(resolved) || resolved === nextElements || resolved.length !== nextElements.length) return [];
  const out = [];
  for (let i = 0; i < nextElements.length; i++) {
    const before = nextElements[i];
    const after = resolved[i];
    if (before === after || !isLinear(before)) continue;
    if (!changed.has(before.id) && !changed.has(before.startId) && !changed.has(before.endId)) continue;
    if (samePoints(before.points, after.points)) continue;
    out.push({ id: before.id, patch: { points: clonePoints(after.points) } });
  }
  return out;
}

/** Largest binding gap (board units) granted by a shape's size (Excalidraw's maxBindingGap). */
const BIND_GAP_MAX = 32;

/**
 * How close (board units) to `el`'s outline an arrow end must be to bind:
 * at least BIND_DISTANCE screen px, and — like Excalidraw's maxBindingGap —
 * up to a quarter of the shape's smaller side (capped), so big shapes are
 * easy targets without every pixel of their empty middle being one.
 */
export function bindingGap(el, zoom = 1) {
  const bySize = Math.min(0.25 * Math.min(el.w || 0, el.h || 0), BIND_GAP_MAX);
  return Math.max(BIND_DISTANCE / (zoom || 1), bySize);
}

/**
 * The shape an arrow end at `point` would bind to: the topmost BINDABLE
 * element whose outline is within `bindingGap` of the point, with the same
 * filled/unfilled rules as clicking — a filled shape (or text, sticky, image,
 * labelled shape) binds anywhere inside too, an unfilled one only in the band
 * around its outline. Otherwise every arrow drawn inside a big container
 * would glue itself to the container.
 */
export function findBindTarget(elements, point, zoom = 1, excludeIds = []) {
  if (!point) return null;
  const exclude = toSet(excludeIds);
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!isBindable(el) || exclude.has(el.id) || el.opacity === 0) continue;
    if (hitShape(el, point, bindingGap(el, zoom))) return el;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Grid
 * ------------------------------------------------------------------ */

/** Snap a board point to the grid when grid mode is on. */
export function snapToGrid(point, gridSize, enabled) {
  if (!enabled || !(gridSize > 0)) return { x: point.x, y: point.y };
  return { x: snapValue(point.x, gridSize), y: snapValue(point.y, gridSize) };
}
