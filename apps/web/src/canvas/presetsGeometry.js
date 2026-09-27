/**
 * presetsGeometry.js — the geometry side of dragging a shape out of the
 * palette.
 *
 * The palette (owned by the dnd agent) hands the canvas a `preset`; this turns
 * that preset plus a drop point into a finished element, centred on the cursor
 * and snapped to the grid when snapping is on.
 *
 * Kept separate from the pen reducer because the palette drag is not a
 * pointer drag — there is no down/move/up to reduce — it is a single drop
 * event. Putting it in the reducer would mean faking a gesture to reuse four
 * lines of arithmetic.
 */

import { snapRect, rectFromDrag } from '@whiteboard/shared';

/** The box a preset lands in when dropped with no size of its own. */
export const PRESET_FALLBACK_SIZE = Object.freeze({ w: 120, h: 80 });

/**
 * The bounding box of a palette drag, in board units.
 *
 * dnd-kit reports a drop as a point, but a user who drags a shape expects the
 * shape to appear where they let go, AT ITS NATURAL SIZE, centred under the
 * cursor. If the drag covered a meaningful distance we honour that rectangle
 * instead — a user who drew a box on the palette meant that box.
 *
 * @param {{x:number,y:number}} from where the drag started on the canvas
 * @param {{x:number,y:number}} to   where it was released
 * @param {{w?:number,h?:number}} [size] the preset's natural size
 * @param {number} [threshold=6] board units below which it counts as a click
 * @returns {{x,y,w,h}}
 */
export function presetDropBox(from, to, size, threshold = 6) {
  const s = size || PRESET_FALLBACK_SIZE;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dragged = Math.hypot(dx, dy) > threshold;
  if (dragged) {
    // Honour the drawn rectangle, but never collapse to zero: a shape with no
    // area cannot be selected afterwards, and the user would think it vanished.
    const box = rectFromDrag(from, to);
    return {
      w: Math.max(s.w * 0.5, box.w),
      h: Math.max(s.h * 0.5, box.h),
      x: box.x,
      y: box.y,
    };
  }
  // A click: centre the preset's natural size on the cursor.
  return { x: to.x - s.w / 2, y: to.y - s.h / 2, w: s.w, h: s.h };
}

/**
 * Final geometry for a dropped preset: the drop box, then snapped.
 *
 * Snapping the box's EDGES (not its size) means a preset of 160x160 dropped
 * on a 20-unit grid lands flush on both sides, which is what "it snapped" is
 * supposed to look like.
 *
 * @param {{x,y,w,h}} box
 * @param {number} gridSize 0 disables
 * @returns {{x,y,w,h}}
 */
export function snapPresetBox(box, gridSize) {
  if (!gridSize || gridSize <= 0) return { ...box };
  // `snapRect` is the shared box-edge snapper and already rounds BOTH edges,
  // which is what "snapped" should look like: the left edge and the right edge
  // on grid lines, and whatever width falls out between them.
  return snapRect(box, gridSize);
}

/**
 * The complete geometry for a palette drop.
 *
 * @param {object} preset  the palette item: `{type, w?, h?, ...}`
 * @param {{x,y}} from     drag start in board units
 * @param {{x,y}} to       drop point in board units
 * @param {object} [opts]  `{gridSize, snapEnabled, id, now, authorId}`
 * @returns {object} a full element ready for `validateElement`
 */
export function presetElementAt(preset, from, to, opts = {}) {
  const natural = { w: preset.w || PRESET_FALLBACK_SIZE.w, h: preset.h || PRESET_FALLBACK_SIZE.h };
  let box = presetDropBox(from, to, natural);
  if (opts.snapEnabled) box = snapPresetBox(box, opts.gridSize || 0);

  const el = {
    ...preset,
    id: opts.id,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
  };
  // Fields the element owns that the palette must not supply.
  if (el.opacity === undefined) el.opacity = 1;
  if (opts.authorId) el.authorId = opts.authorId;
  if (opts.now) el.createdAt = opts.now;
  return el;
}

/**
 * Where a preset's connection stub attaches when dropped next to a box. Used
 * by the flow agent to wire a "flowchart start" preset to the first node
 * under the drop point; the canvas does not need it, so it lives here rather
 * than bloating the reducer.
 *
 * @param {Array<object>} elements
 * @param {{x,y}} at
 * @param {number} [radius] board units
 * @returns {object|null}
 */
export function nearestElement(elements, at, radius = 40) {
  let best = null;
  let bestD = radius;
  for (const el of elements || []) {
    if (!el) continue;
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const d = Math.hypot(at.x - cx, at.y - cy);
    if (d < bestD) {
      bestD = d;
      best = el;
    }
  }
  return best;
}
