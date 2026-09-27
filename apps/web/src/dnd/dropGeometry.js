/**
 * Pure geometry for dropping a preset onto the canvas.
 *
 * No JSX, no dnd-kit, no store: this is the file the "everything landed 200px
 * off" bug lives in, so it is a plain function that `apps/web/test/flow.test.js`
 * can hammer with a non-identity view.
 *
 * `screenToBoard` is the whiteboard's own coordinate conversion
 * (`board = (screen - pan) / zoom`). The shell installs the shared
 * implementation when `@whiteboard/shared/geometry` has landed; the local
 * fallback below is the same maths, so the drop path is correct either way.
 */

import { IDENTITY_VIEW } from '@whiteboard/shared';

/** @typedef {{x:number,y:number}} Point */
/** @typedef {{zoom:number,panX:number,panY:number}} View */

/**
 * The one conversion that matters: viewport pixels -> board units.
 * @param {Point} p
 * @param {View} view
 * @returns {Point}
 */
export function screenToBoard(p, view) {
  const v = view || IDENTITY_VIEW;
  const zoom = Number.isFinite(v.zoom) && v.zoom > 0 ? v.zoom : 1;
  const panX = Number.isFinite(v.panX) ? v.panX : 0;
  const panY = Number.isFinite(v.panY) ? v.panY : 0;
  return { x: (p.x - panX) / zoom, y: (p.y - panY) / zoom };
}

/** Inverse of `screenToBoard`, needed to keep a keyboard/click drop glued to
 * the viewport centre while the user pans and zooms. */
export function boardToScreen(p, view) {
  const v = view || IDENTITY_VIEW;
  const zoom = Number.isFinite(v.zoom) && v.zoom > 0 ? v.zoom : 1;
  const panX = Number.isFinite(v.panX) ? v.panX : 0;
  const panY = Number.isFinite(v.panY) ? v.panY : 0;
  return { x: p.x * zoom + panX, y: p.y * zoom + panY };
}

/** The centre of a viewport, in board units. */
export function viewportCentreToBoard(size, view) {
  return screenToBoard({ x: (size?.width ?? 0) / 2, y: (size?.height ?? 0) / 2 }, view);
}

/** Bounding box of a set of elements, in board units. */
export function boundsOfElements(els) {
  if (!Array.isArray(els) || els.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of els) {
    const x = Number.isFinite(el?.x) ? el.x : 0;
    const y = Number.isFinite(el?.y) ? el.y : 0;
    const w = Number.isFinite(el?.w) ? el.w : 0;
    const h = Number.isFinite(el?.h) ? el.h : 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

/**
 * Translate a preset's elements so the preset's own bounding box is centred on
 * `at`, instead of its origin landing on the cursor. A 320x200 frame dropped by
 * its corner would otherwise put its whole area down-right of the pointer.
 *
 * @param {any[]} els
 * @param {Point} at board units
 * @returns {any[]} new array; elements are copied, never mutated
 */
export function centerElementsAt(els, at) {
  if (!Array.isArray(els) || els.length === 0) return [];
  const b = boundsOfElements(els);
  const dx = at.x - (b.x + b.w / 2);
  const dy = at.y - (b.y + b.h / 2);
  return els.map((el) => {
    const x = (Number.isFinite(el?.x) ? el.x : 0) + dx;
    const y = (Number.isFinite(el?.y) ? el.y : 0) + dy;
    const out = { ...el, x, y };
    // Connectors carry absolute endpoints as well as a derived box; move them
    // in lockstep or the arrow detaches from the shapes it points between.
    if (Array.isArray(el?.points)) {
      out.points = el.points.map((p) => ({
        x: (Number.isFinite(p?.x) ? p.x : 0) + dx,
        y: (Number.isFinite(p?.y) ? p.y : 0) + dy,
      }));
    }
    return out;
  });
}

/**
 * Snap a board point to the grid, honouring the store's `gridSize`/`snapEnabled`.
 * @param {Point} p
 * @param {number} gridSize 0 = snapping off
 * @param {boolean} enabled
 * @returns {Point}
 */
export function snapPoint(p, gridSize, enabled) {
  const g = Number.isFinite(gridSize) && gridSize > 0 ? gridSize : 0;
  if (!enabled || g === 0) return p;
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}

/**
 * The whole drop path in one pure function, so the test can assert the exact
 * board coordinates a preset lands on under an arbitrary view.
 *
 * @param {Object} p
 * @param {Point} p.screenPoint viewport pixels
 * @param {View} p.view
 * @param {Object} [p.style] style from the store
 * @param {number} [p.gridSize]
 * @param {boolean} [p.snapEnabled]
 * @param {{build:(box:Object, style:Object)=>any[]}} p.preset
 * @param {Point} [p.size] preset size override {w,h}
 * @returns {any[]} elements ready for `addElements`
 */
export function buildDroppedElements({
  screenPoint,
  view,
  style,
  gridSize = 0,
  snapEnabled = false,
  preset,
  size,
}) {
  if (!preset || typeof preset.build !== 'function') return [];
  const boardPoint = screenToBoard(screenPoint, view);
  const at = snapPoint(boardPoint, gridSize, snapEnabled);

  // The preset decides its own default box; `size` is only a nudge for palettes
  // that want a consistent footprint.
  const box =
    size && Number.isFinite(size.w) && Number.isFinite(size.h)
      ? { w: size.w, h: size.h }
      : undefined;

  const built = preset.build(box, style);
  const els = Array.isArray(built) ? built : built ? [built] : [];
  return centerElementsAt(els, at);
}

/** The droppable id registered by `useDropOnCanvas`. */
export const CANVAS_DROPPABLE_ID = 'canvas';

/**
 * A collision detector tuned for one huge droppable.
 *
 * `pointerWithin` is first because the canvas droppable covers the whole
 * viewport: if the pointer is anywhere over it, that is the answer, and it is
 * exact. But it is not sufficient on its own — a palette item dragged *out of*
 * the panel and released over the canvas is still geometrically "within" the
 * palette's own rect for that frame, so the palette would win and the drop
 * would land on nothing. So the canvas is filtered to the front of the list.
 *
 * `rectIntersection` is the fallback for the case dnd-kit cannot resolve by
 * pointer at all: a keyboard drag, or a pointer that left the window mid-drag.
 *
 * The built-in `closestCenter` would be actively wrong here — it would happily
 * pick a layer row over a canvas that contains it.
 *
 * @param {any} args dnd-kit collision args
 * @returns {any[]}
 */
export function canvasCollisionDetection(args) {
  const canvasFirst = (list) => {
    if (!Array.isArray(list)) return [];
    const canvas = list.filter((c) => c.id === CANVAS_DROPPABLE_ID);
    return canvas.length > 0 ? canvas : list;
  };

  const within = canvasFirst((args.pointerWithin || vendoredPointerWithin)(args));
  if (within.length > 0) return within;

  const rects = canvasFirst((args.rectIntersection || vendoredRectIntersection)(args));
  if (rects.length > 0) return rects;

  return args.droppableContainers?.filter((c) => c.id === CANVAS_DROPPABLE_ID) ?? [];
}

// --- dnd-kit detectors, vendored so this file stays dependency-free ----------
// They are ~30 lines each and the contract is stable across @dnd-kit 6.x.

function vendoredPointerWithin({ droppableContainers, droppableRects, pointerCoordinates }) {
  if (!pointerCoordinates) return [];
  const hits = [];
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    if (
      pointerCoordinates.x >= rect.left &&
      pointerCoordinates.x <= rect.left + rect.width &&
      pointerCoordinates.y >= rect.top &&
      pointerCoordinates.y <= rect.top + rect.height
    ) {
      hits.push(container);
    }
  }
  return hits;
}

function vendoredRectIntersection({ droppableContainers, droppableRects }) {
  const intersections = [];
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    const intersectionsMap = new Map();
    for (const other of droppableContainers) {
      if (container.id === other.id) continue;
      const otherRect = droppableRects.get(other.id);
      if (!otherRect) continue;
      const intersection = intersectRects(rect, otherRect);
      if (intersection) {
        intersectionsMap.set(other.id, { id: other.id, data: other.data, rect: intersection });
      }
    }
    intersections.push({ id: container.id, data: container.data, rect, intersectionsMap });
  }
  return intersections;
}

function intersectRects(a, b) {
  const top = Math.max(a.top, b.top);
  const left = Math.max(a.left, b.left);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { top, left, width, height };
}
