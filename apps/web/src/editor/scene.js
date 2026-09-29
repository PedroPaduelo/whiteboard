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
import { BIND_DISTANCE, FONT_SIZES } from './constants.js';
import { hasPoints, isLinear, isText, isBindable } from './elements.js';
import { commonBounds, rotateAround } from './handles.js';
import { labelBox, labelKeyOf, lineHeightPx, wrapText } from './text.js';
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
 * points. Locked elements are skipped.
 *
 * A moved connector whose bound element is NOT moving with it comes unbound
 * at that end (`startId: null`) — otherwise the binding pass would snap the
 * end straight back onto the shape while it is being dragged. With
 * `opts.elements` (the scene), an end that still sits within the shape's
 * binding gap after the move KEEPS its binding instead (Excalidraw's
 * getOriginalBindingsIfStillCloseToArrowEnds): that is what a one-shot move
 * such as an arrow-key nudge wants; the caller's resolveBindingPatches then
 * puts the end back on the outline. A live drag passes no scene (the end
 * follows the pointer) and restores close bindings on release with
 * `rebindMovedConnectors`.
 *
 * @param {object[]} originals
 * @param {number} dx
 * @param {number} dy
 * @param {{elements?: object[], zoom?: number}} [opts]
 */
export function moveElements(originals, dx, dy, { elements = null, zoom = 1 } = {}) {
  const movable = originals.filter((el) => !el.locked);
  const moving = new Set(movable.map((el) => el.id));
  const byId = elements ? new Map(elements.map((el) => [el.id, el])) : null;
  return movable.map((el) => {
    if (hasPoints(el)) {
      const points = el.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      const patch = { points };
      if (isLinear(el)) {
        const keep = byId ? keptBindings(el, points, byId, moving, zoom) : {};
        if (el.startId && !moving.has(el.startId) && !keep.startId) patch.startId = null;
        if (el.endId && !moving.has(el.endId) && !keep.endId) patch.endId = null;
      }
      return { id: el.id, patch };
    }
    return { id: el.id, patch: { x: el.x + dx, y: el.y + dy } };
  });
}

/**
 * The ORIGINAL bindings of connector `el` that survive moving its points to
 * `points`: an end bound to a shape that is not moving with it (`moving`)
 * and still within that shape's binding gap of the moved end.
 * @returns {{startId?: string, endId?: string}}
 */
function keptBindings(el, points, byId, moving, zoom) {
  const out = {};
  const n = points.length;
  if (n < 2) return out;
  for (const [key, q] of [
    ['startId', points[0]],
    ['endId', points[n - 1]],
  ]) {
    const id = el[key];
    if (!id || moving.has(id)) continue;
    const target = byId.get(id);
    if (target && isBindable(target) && hitShape(target, q, bindingGap(target, zoom))) out[key] = id;
  }
  return out;
}

/**
 * After a live drag moved connectors by their shaft (which unbinds them while
 * dragging, see moveElements), restore every ORIGINAL binding whose end is
 * still close to its shape, with the bound ends resolved back onto the
 * outlines. Returns the patches to send with the gesture's last update (no
 * new commit: they are part of the same edit).
 *
 * @param {object[]} originals  the moved elements as they were at pointerdown
 * @param {object[]} elements   the scene now (after the move)
 * @param {number} [zoom]
 * @returns {{id, patch}[]}
 */
export function rebindMovedConnectors(originals, elements, zoom = 1) {
  if (!Array.isArray(elements) || !originals || originals.length === 0) return [];
  const moving = new Set(originals.filter((el) => !el.locked).map((el) => el.id));
  const byId = new Map(elements.map((el) => [el.id, el]));
  const patches = [];
  for (const orig of originals) {
    if (!isLinear(orig) || orig.locked || (!orig.startId && !orig.endId)) continue;
    const now = byId.get(orig.id);
    if (!now || !Array.isArray(now.points)) continue;
    const keep = keptBindings(orig, now.points, byId, moving, zoom);
    const patch = {};
    if (keep.startId && now.startId !== keep.startId) patch.startId = keep.startId;
    if (keep.endId && now.endId !== keep.endId) patch.endId = keep.endId;
    if (Object.keys(patch).length) patches.push({ id: orig.id, patch });
  }
  if (!patches.length) return [];
  const ids = patches.map((p) => p.id);
  const resolved = new Map(resolveBindingPatches(applyPatches(elements, patches), ids).map((p) => [p.id, p.patch]));
  return patches.map((p) => ({ id: p.id, patch: { ...p.patch, ...(resolved.get(p.id) ?? {}) } }));
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

/** Is `r` (radians) a multiple of 90°? */
function isRightAngle(r) {
  const q = r / (Math.PI / 2);
  return Math.abs(q - Math.round(q)) < 1e-9;
}

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
    // Text scales uniformly: its font follows the box and is clamped to what
    // the validator accepts, and the box follows the clamped scale. Dragged
    // past the anchor, the BOX flips to the other side of it (with the
    // pointer, like every other shape) — the glyphs never mirror, there is
    // nothing to mirror them with — so the scale keeps its sign per axis.
    const s0 = t.hx !== 0 ? Math.abs(t.sx) : Math.abs(t.sy);
    const f0 = textFont(el);
    const f = clamp(f0 * s0, FONT_MIN, FONT_MAX);
    const s = f / f0;
    t.sx = t.sx < 0 ? -s : s;
    t.sy = t.sy < 0 ? -s : s;
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
 * aspect-locked) drags and only moves on a free side drag. A member turned
 * by an angle that is not a multiple of 90° cannot follow a non-uniform
 * scale without shearing, so such a selection always scales uniformly
 * (Excalidraw's resizeMultipleElements does the same for rotated members):
 * every member keeps its angle and stays inside the frame being dragged.
 */
export function resizeElements(originals, frame, handle, pointer, opts = {}) {
  const list = originals.filter((el) => !el.locked);
  if (list.length === 0 || !handle || handle === 'rotation' || !pointer) return [];
  const f = frame ?? transformFrame(list);
  if (list.length === 1 && originals.length === 1) return [resizeSingle(list[0], f, handle, pointer, opts)];

  const skewed = list.some((el) => !hasPoints(el) && !isRightAngle(el.rotation || 0));
  const t = resizeTransform(f, handle, pointer, { ...opts, keepAspect: Boolean(opts.keepAspect) || skewed });
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
      // A rotated box: the scale is uniform (see `skewed`) or the box is
      // turned by a right angle, so its own axes map onto the frame's axes —
      // each is stretched by the scale along the direction it points in and
      // the angle is unchanged (atan2 below returns `rot` in both cases).
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
 * selected); polylines have the turn baked into their points (shared
 * resolveConnectors ignores `rotation`, so a connector never carries one).
 * A lone 2-point connector is not rotated: it shows no transform box, its
 * two point handles do that job (Excalidraw); one with more points turns
 * like any polyline.
 */
export function rotateElements(originals, frame, pointer, { snap15 = false } = {}) {
  const list = originals.filter((el) => !el.locked);
  if (list.length === 0 || !pointer) return [];
  if (list.length === 1 && isLinear(list[0]) && !(Array.isArray(list[0].points) && list[0].points.length > 2)) return [];
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
 * Labels
 * ------------------------------------------------------------------ */

/**
 * The height container `el` needs for `label` to fit its label box, wrapped
 * at the container's CURRENT width (the width never changes: a label grows
 * its shape downward, like Excalidraw's bound text). Uses the same
 * labelBox/wrapText as the renderer and the editor, so what fits here is
 * exactly what is painted. 0 for an empty label.
 */
export function labelFitHeight(el, label) {
  if (!labelKeyOf(el)) return 0;
  const text = String(label ?? '');
  if (text === '') return 0;
  const fontFamily = el.fontFamily ?? 'hand';
  const fontSize = el.fontSize ?? FONT_SIZES.M;
  const lines = wrapText(text, labelBox(el).w, fontFamily, fontSize);
  const need = Math.max(1, lines.length) * lineHeightPx(fontSize);
  // The label box height is linear in the element's height (an inset, and
  // a factor for ellipses and diamonds) once past its 1-unit floor: solve
  // labelBox({...el, h}).h === need from two probes on that line.
  const H0 = 1000;
  const H1 = 2000;
  const b0 = labelBox({ ...el, h: H0 }).h;
  const b1 = labelBox({ ...el, h: H1 }).h;
  const slope = (b1 - b0) / (H1 - H0);
  if (!(slope > 0)) return 0;
  return H0 + (need - b0) / slope;
}

/**
 * The patch that makes container `el` tall enough for `label`, or null when
 * its height is already right. Only the height changes, and the TOP edge
 * stays where it is on screen (for a rotated shape too). The result is never
 * shorter than `minH` (default: the current height, i.e. grow only); the
 * text editor passes the height the shape had when editing started, so
 * deleting text shrinks it back down to that, never below (Excalidraw).
 *
 * Used by the text editor while a label is typed and when it is committed.
 * (A font change goes through actions.fitContainerToLabel, which may also
 * widen the shape so no word is split.)
 * @returns {{h:number, x?:number, y?:number}|null}
 */
export function growContainerForLabel(el, label, { minH } = {}) {
  if (!el || !labelKeyOf(el) || !(el.w > 0) || !(el.h >= 0)) return null;
  const floor = Number.isFinite(minH) ? minH : el.h;
  const h = Math.max(floor, Math.ceil(labelFitHeight(el, label) - 1e-6));
  if (Math.abs(h - el.h) < 0.5) return null;
  const r = el.rotation || 0;
  if (!r) return { h };
  // Keep the top edge fixed on screen: the centre moves half the growth
  // along the shape's own (rotated) downward axis.
  const d = rotateAround({ x: 0, y: (h - el.h) / 2 }, { x: 0, y: 0 }, r);
  const cx = el.x + el.w / 2 + d.x;
  const cy = el.y + el.h / 2 + d.y;
  return { h, x: cx - el.w / 2, y: cy - h / 2 };
}

/* ------------------------------------------------------------------ *
 * Grid
 * ------------------------------------------------------------------ */

/** Snap a board point to the grid when grid mode is on. */
export function snapToGrid(point, gridSize, enabled) {
  if (!enabled || !(gridSize > 0)) return { x: point.x, y: point.y };
  return { x: snapValue(point.x, gridSize), y: snapValue(point.y, gridSize) };
}
