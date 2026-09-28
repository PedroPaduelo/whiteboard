/**
 * handles.js — where the selection frame and its handles are.
 *
 * The renderer DRAWS handles from these functions and the interaction reducer
 * HIT-TESTS handles with these same functions. Keeping one source is what
 * guarantees the square you see is the square you can grab, at every zoom and
 * rotation.
 *
 * All results are in BOARD units. Handle sizes are specified in screen px
 * (constants.js) and divided by zoom here, so handles stay a constant size on
 * screen.
 */

import { boundsOfPoints } from '@whiteboard/shared';
import { HANDLE_SIZE, ROTATE_HANDLE_OFFSET, SELECTION_PADDING } from './constants.js';

/** Rotate `p` about `c` by `angle` radians (clockwise in screen space, y down). */
export function rotateAround(p, c, angle) {
  if (!angle) return { x: p.x, y: p.y };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** The four corners of an element's box, rotated about its centre. */
export function elementCorners(el) {
  const c = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  const r = el.rotation || 0;
  return [
    rotateAround({ x: el.x, y: el.y }, c, r),
    rotateAround({ x: el.x + el.w, y: el.y }, c, r),
    rotateAround({ x: el.x + el.w, y: el.y + el.h }, c, r),
    rotateAround({ x: el.x, y: el.y + el.h }, c, r),
  ];
}

/**
 * Axis-aligned bounds of an element AS PAINTED (rotation included; for
 * polylines, the points). Use for marquee, zoom-to-fit, culling and export.
 */
export function elementBounds(el) {
  if ((el.type === 'pen' || el.type === 'arrow' || el.type === 'line') && Array.isArray(el.points) && el.points.length) {
    return boundsOfPoints(el.points);
  }
  if (!el.rotation) return { x: el.x, y: el.y, w: el.w, h: el.h };
  return boundsOfPoints(elementCorners(el));
}

/** Union of `elementBounds` over a list; null for an empty list. */
export function commonBounds(elements) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const b = elementBounds(el);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * The selection frame for a set of selected elements.
 *
 * - exactly one element: its own (unrotated) box plus its rotation, so the
 *   frame turns with the shape, like Excalidraw;
 * - several elements: the axis-aligned union, rotation 0.
 *
 * The frame is padded by SELECTION_PADDING screen px so the dashed outline does
 * not sit on top of the stroke.
 *
 * @param {object[]} selected  the selected elements (not ids)
 * @param {number} zoom
 * @returns {null | {x:number,y:number,w:number,h:number,rotation:number, single:boolean}}
 */
export function selectionFrame(selected, zoom = 1) {
  if (!selected || selected.length === 0) return null;
  const pad = SELECTION_PADDING / zoom;
  if (selected.length === 1) {
    const el = selected[0];
    const isPoly = el.type === 'pen' || el.type === 'arrow' || el.type === 'line';
    const b = isPoly ? elementBounds(el) : { x: el.x, y: el.y, w: el.w, h: el.h };
    return {
      x: b.x - pad,
      y: b.y - pad,
      w: b.w + pad * 2,
      h: b.h + pad * 2,
      rotation: isPoly ? 0 : el.rotation || 0,
      single: true,
    };
  }
  const b = commonBounds(selected);
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2, rotation: 0, single: false };
}

/** Handle keys, in drawing order. `rotation` is the round handle above `n`. */
export const HANDLE_KEYS = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rotation']);

/**
 * Centre points of every transform handle for a frame, in board units,
 * rotated with the frame. Side handles are omitted when the frame is too small
 * on screen to fit them without overlapping the corners (Excalidraw does the
 * same), and `rotation` is omitted when `opts.rotatable === false`.
 *
 * @param {{x,y,w,h,rotation}} frame
 * @param {number} zoom
 * @param {{rotatable?: boolean, sides?: boolean}} [opts]
 * @returns {Record<string, {x:number,y:number}>} key -> centre
 */
export function transformHandles(frame, zoom = 1, opts = {}) {
  const { rotatable = true, sides = true } = opts;
  const { x, y, w, h } = frame;
  const c = { x: x + w / 2, y: y + h / 2 };
  const r = frame.rotation || 0;
  const pts = {
    nw: { x, y },
    ne: { x: x + w, y },
    se: { x: x + w, y: y + h },
    sw: { x, y: y + h },
  };
  const minSide = (HANDLE_SIZE * 4) / zoom;
  if (sides && w > minSide) {
    pts.n = { x: c.x, y };
    pts.s = { x: c.x, y: y + h };
  }
  if (sides && h > minSide) {
    pts.e = { x: x + w, y: c.y };
    pts.w = { x, y: c.y };
  }
  if (rotatable) pts.rotation = { x: c.x, y: y - ROTATE_HANDLE_OFFSET / zoom };
  const out = {};
  for (const k of HANDLE_KEYS) if (pts[k]) out[k] = rotateAround(pts[k], c, r);
  return out;
}

/**
 * Which handle (if any) is under board point `p`. Hit area is the handle square
 * plus 2 screen px of slop.
 * @returns {string|null} a HANDLE_KEYS value
 */
export function hitHandle(frame, p, zoom = 1, opts = {}) {
  const handles = transformHandles(frame, zoom, opts);
  const half = (HANDLE_SIZE / 2 + 2) / zoom;
  // Rotation first: it sits outside the frame, never under a corner.
  for (const k of ['rotation', 'nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w']) {
    const hp = handles[k];
    if (!hp) continue;
    if (Math.abs(p.x - hp.x) <= half && Math.abs(p.y - hp.y) <= half) return k;
  }
  return null;
}

/** CSS cursor for a handle, accounting for the frame's rotation. */
export function cursorForHandle(key, rotation = 0) {
  if (key === 'rotation') return 'grab';
  const order = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  const cursors = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
  const idx = order.indexOf(key);
  if (idx < 0) return 'default';
  const steps = Math.round(((rotation || 0) * 180) / Math.PI / 45);
  const i = (((idx + steps) % 8) + 8) % 8;
  return cursors[i % 4];
}
