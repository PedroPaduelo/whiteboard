/**
 * renderScene.js — paints the two canvases of the editor.
 *
 *   renderStatic      the drawing: background, grid, every visible element,
 *                     and the element being created (the draft).
 *   renderInteractive the chrome on top: selection frames and handles, point
 *                     handles of a connector, marquee, bind-target highlight,
 *                     eraser trail, collaborators' cursors and selections.
 *
 * Splitting them is Excalidraw's trick for a smooth editor: moving the mouse
 * repaints only the cheap interactive layer, not every rough shape.
 *
 * Both canvases are sized in DEVICE px (`canvas.width = cssW * dpr`) and
 * every function sets its own transform, so no caller state leaks in:
 *   board space   setTransform(dpr*zoom, 0, 0, dpr*zoom, dpr*panX, dpr*panY)
 *   screen space  setTransform(dpr, 0, 0, dpr, 0, 0)
 * View convention everywhere: screen = board * zoom + pan.
 *
 * The renderer always draws LIGHT colours; dark mode is a CSS filter the
 * Canvas component puts on both canvases (DARK_MODE_FILTER).
 */

import {
  CANVAS_BACKGROUND,
  GRID_SIZE,
  SELECTION_COLOR,
  HANDLE_SIZE,
  POINT_HANDLE_RADIUS,
  BIND_DISTANCE,
  SELECTION_PADDING,
} from '../constants.js';
import { elementBounds, selectionFrame, transformHandles, rotateAround, commonBounds } from '../handles.js';
import { isLinear, isRotatable } from '../elements.js';
import { drawElement } from './renderElement.js';

/** Grid is hidden below this zoom (lines would be a grey smear). */
export const GRID_MIN_ZOOM = 0.3;
/** Every GRID_MAJOR_EVERY-th grid line is darker. */
export const GRID_MAJOR_EVERY = 5;
const GRID_MINOR_COLOR = 'rgba(0, 0, 0, 0.06)';
const GRID_MAJOR_COLOR = 'rgba(0, 0, 0, 0.12)';

const SELECTION_FILL = 'rgba(105, 101, 219, 0.08)';
const BIND_HIGHLIGHT = 'rgba(105, 101, 219, 0.28)';

function normView(view) {
  const zoom = view && Number.isFinite(view.zoom) && view.zoom > 0 ? view.zoom : 1;
  return { zoom, panX: view?.panX || 0, panY: view?.panY || 0 };
}

function asSet(v) {
  if (!v) return null;
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v);
  return null;
}

function entriesOf(v) {
  if (!v) return [];
  if (v instanceof Map) return [...v.entries()];
  if (typeof v === 'object') return Object.entries(v);
  return [];
}

/** Board-space rectangle visible in a viewport of CSS size width x height. */
export function visibleBoardRect(view, width, height) {
  const { zoom, panX, panY } = normView(view);
  return { x: -panX / zoom, y: -panY / zoom, w: width / zoom, h: height / zoom };
}

/**
 * Painted extent of an element beyond its geometric bounds: half the stroke,
 * the rough wobble, arrowheads, the sticky shadow. Generous on purpose — a
 * culled element that should be visible is a bug, an extra one drawn is not.
 */
function paintMargin(el) {
  const sw = typeof el.strokeWidth === 'number' ? el.strokeWidth : 2;
  if (el.type === 'arrow' || el.type === 'line') return 30 + sw * 2;
  if (el.type === 'sticky') return 24;
  if (el.type === 'pen') return sw * 4 + 8;
  return sw * 2 + 8;
}

/** Painted bounds per element object (a pen stroke's bounds are O(points)). */
const boundsCache = new WeakMap();
function cachedBounds(el) {
  let b = boundsCache.get(el);
  if (!b) {
    b = elementBounds(el);
    boundsCache.set(el, b);
  }
  return b;
}

/** True when the element may paint inside `rect` (board units). */
export function isElementVisible(el, rect) {
  let b;
  try {
    b = cachedBounds(el);
  } catch {
    return true;
  }
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return true;
  const m = paintMargin(el);
  return !(b.x + b.w + m < rect.x || b.y + b.h + m < rect.y || b.x - m > rect.x + rect.w || b.y - m > rect.y + rect.h);
}

/* ------------------------------------------------------------------ *
 * Static layer
 * ------------------------------------------------------------------ */

function drawGrid(ctx, { zoom, panX, panY, width, height, dpr, gridSize }) {
  const step = gridSize * zoom; // CSS px between minor lines
  if (!(step > 0)) return;
  const majorStep = step * GRID_MAJOR_EVERY;
  const drawMinor = step >= 5;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const lw = Math.max(1, Math.round(dpr));
  const half = lw % 2 ? 0.5 : 0;
  const W = width * dpr;
  const H = height * dpr;
  const minor = new Path2DLike();
  const major = new Path2DLike();
  const kx0 = Math.floor(-panX / step);
  const kx1 = Math.ceil((width - panX) / step);
  for (let k = kx0; k <= kx1; k++) {
    const isMajor = k % GRID_MAJOR_EVERY === 0;
    if (!isMajor && !drawMinor) continue;
    const x = Math.round((k * step + panX) * dpr) + half;
    (isMajor ? major : minor).line(x, 0, x, H);
  }
  const ky0 = Math.floor(-panY / step);
  const ky1 = Math.ceil((height - panY) / step);
  for (let k = ky0; k <= ky1; k++) {
    const isMajor = k % GRID_MAJOR_EVERY === 0;
    if (!isMajor && !drawMinor) continue;
    const y = Math.round((k * step + panY) * dpr) + half;
    (isMajor ? major : minor).line(0, y, W, y);
  }
  ctx.lineWidth = lw;
  if (drawMinor) {
    ctx.strokeStyle = GRID_MINOR_COLOR;
    minor.stroke(ctx);
  }
  if (majorStep >= 5) {
    ctx.strokeStyle = GRID_MAJOR_COLOR;
    major.stroke(ctx);
  }
}

/** Collects line segments, then strokes them in one path. */
class Path2DLike {
  constructor() {
    this.segs = [];
  }
  line(x0, y0, x1, y1) {
    this.segs.push(x0, y0, x1, y1);
  }
  stroke(ctx) {
    if (!this.segs.length) return;
    ctx.beginPath();
    const s = this.segs;
    for (let i = 0; i < s.length; i += 4) {
      ctx.moveTo(s[i], s[i + 1]);
      ctx.lineTo(s[i + 2], s[i + 3]);
    }
    ctx.stroke();
  }
}

/**
 * Paint the drawing.
 *
 * @param {CanvasRenderingContext2D} ctx  the static canvas (device-px sized)
 * @param {object} p
 * @param {object[]} p.elements      z-ordered
 * @param {{zoom:number,panX:number,panY:number}} p.view
 * @param {number} p.width  CSS px
 * @param {number} p.height CSS px
 * @param {number} [p.dpr]
 * @param {boolean} [p.showGrid]
 * @param {number} [p.gridSize]
 * @param {string|null} [p.editingId]  its text/label is not painted
 * @param {Set<string>|null} [p.erasingIds] painted at 30% opacity
 * @param {object|null} [p.draft]       element being created, painted last
 * @param {() => void} [p.onImageLoad]  schedule a repaint when an image decodes
 * @returns {{drawn:number, culled:number}} counts, for tests and debugging
 */
export function renderStatic(ctx, p) {
  const {
    elements = [],
    view,
    width = 0,
    height = 0,
    dpr = 1,
    showGrid = false,
    gridSize = GRID_SIZE,
    editingId = null,
    erasingIds = null,
    draft = null,
    onImageLoad,
  } = p || {};
  const { zoom, panX, panY } = normView(view);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = CANVAS_BACKGROUND;
  ctx.fillRect(0, 0, ctx.canvas?.width ?? width * dpr, ctx.canvas?.height ?? height * dpr);

  if (showGrid && zoom >= GRID_MIN_ZOOM && gridSize > 0) {
    drawGrid(ctx, { zoom, panX, panY, width, height, dpr, gridSize });
  }

  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);
  const visible = visibleBoardRect(view, width, height);
  const erasing = asSet(erasingIds);
  let drawn = 0;
  let culled = 0;
  const opts = { zoom, onImageLoad, isEditing: false };
  for (const el of elements) {
    if (!el) continue;
    if (!isElementVisible(el, visible)) {
      culled++;
      continue;
    }
    opts.isEditing = el.id === editingId;
    const ghost = erasing?.has(el.id);
    if (ghost) {
      ctx.save();
      ctx.globalAlpha = 0.3;
    }
    drawElement(ctx, el, opts);
    if (ghost) ctx.restore();
    drawn++;
  }
  if (draft) {
    drawElement(ctx, draft, { zoom, onImageLoad, isEditing: draft.id === editingId });
    drawn++;
  }
  return { drawn, culled };
}

/* ------------------------------------------------------------------ *
 * Interactive layer helpers (all in SCREEN space unless noted)
 * ------------------------------------------------------------------ */

function frameCorners(frame) {
  const c = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
  const r = frame.rotation || 0;
  return [
    rotateAround({ x: frame.x, y: frame.y }, c, r),
    rotateAround({ x: frame.x + frame.w, y: frame.y }, c, r),
    rotateAround({ x: frame.x + frame.w, y: frame.y + frame.h }, c, r),
    rotateAround({ x: frame.x, y: frame.y + frame.h }, c, r),
  ];
}

function strokeFrame(ctx, frame, toScreen, { color = SELECTION_COLOR, dash = null, width = 1 } = {}) {
  const pts = frameCorners(frame).map(toScreen);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash || []);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawHandles(ctx, frame, zoom, toScreen, opts) {
  const handles = transformHandles(frame, zoom, opts);
  const size = HANDLE_SIZE;
  const rotation = frame.rotation || 0;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = SELECTION_COLOR;
  ctx.fillStyle = '#ffffff';
  ctx.setLineDash([]);
  for (const [key, bp] of Object.entries(handles)) {
    const s = toScreen(bp);
    if (key === 'rotation') {
      ctx.beginPath();
      ctx.arc(s.x, s.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      continue;
    }
    ctx.save();
    ctx.translate(s.x, s.y);
    if (rotation) ctx.rotate(rotation);
    roundedRectPath(ctx, -size / 2, -size / 2, size, size, 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawPointHandles(ctx, points, toScreen, { hoverIndex = -1, activeIndex = -1, selectedIndices = null } = {}) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  points.forEach((p, i) => {
    const s = toScreen(p);
    const active = i === activeIndex || selectedIndices?.has?.(i);
    ctx.beginPath();
    ctx.arc(s.x, s.y, POINT_HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = active ? SELECTION_COLOR : i === hoverIndex ? 'rgba(105, 101, 219, 0.35)' : '#ffffff';
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

/** The outline of an element's shape, as a path in BOARD space. */
function shapeOutlinePath(ctx, el, pad) {
  const x = el.x - pad;
  const y = el.y - pad;
  const w = el.w + pad * 2;
  const h = el.h + pad * 2;
  ctx.beginPath();
  if (el.type === 'ellipse') {
    ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
  } else if (el.type === 'diamond') {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    // Offset each edge outward by `pad`: the vertices move by pad / sin.
    const k = Math.hypot(el.w / 2, el.h / 2) || 1;
    const dx = (pad * k) / (el.h / 2 || 1);
    const dy = (pad * k) / (el.w / 2 || 1);
    ctx.moveTo(cx, el.y - dy);
    ctx.lineTo(el.x + el.w + dx, cy);
    ctx.lineTo(cx, el.y + el.h + dy);
    ctx.lineTo(el.x - dx, cy);
    ctx.closePath();
  } else {
    const r = el.type === 'rect' && el.roundness === 'round' ? Math.min(Math.min(el.w, el.h) * 0.25, 32) + pad : pad;
    roundedRectPath(ctx, x, y, w, h, r);
  }
}

function drawBindHighlight(ctx, el, view, dpr) {
  const { zoom, panX, panY } = normView(view);
  ctx.save();
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);
  if (el.rotation) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(el.rotation);
    ctx.translate(-cx, -cy);
  }
  const width = BIND_DISTANCE / 2 / zoom;
  shapeOutlinePath(ctx, el, width / 2 + 2 / zoom);
  ctx.strokeStyle = BIND_HIGHLIGHT;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

function normRect(r) {
  if (!r) return null;
  let x;
  let y;
  let w;
  let h;
  if (Number.isFinite(r.w) && Number.isFinite(r.h)) {
    ({ x, y, w, h } = r);
  } else if (Number.isFinite(r.x1) && Number.isFinite(r.x2)) {
    x = r.x1;
    y = r.y1;
    w = r.x2 - r.x1;
    h = r.y2 - r.y1;
  } else if (r.start && r.end) {
    x = r.start.x;
    y = r.start.y;
    w = r.end.x - r.start.x;
    h = r.end.y - r.start.y;
  } else return null;
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return { x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.abs(w), h: Math.abs(h) };
}

function drawEraserTrail(ctx, trail, toScreen) {
  const pts = (Array.isArray(trail) ? trail : trail?.points ?? []).filter((p) => p && Number.isFinite(p.x));
  if (pts.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  const n = pts.length;
  let prev = toScreen(pts[0]);
  for (let i = 1; i < n; i++) {
    const s = toScreen(pts[i]);
    const t = i / (n - 1); // 0 = oldest, 1 = newest
    ctx.strokeStyle = `rgba(0, 0, 0, ${(0.05 + 0.2 * t).toFixed(3)})`;
    ctx.lineWidth = 1 + 4 * t;
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
    prev = s;
  }
  ctx.restore();
}

/** Excalidraw-like pointer arrow + name tag, in the peer's colour. */
function drawRemoteCursor(ctx, s, name, color, width, height) {
  const margin = 8;
  const off = s.x < 0 || s.y < 0 || s.x > width || s.y > height;
  const x = Math.min(Math.max(s.x, margin), width - margin);
  const y = Math.min(Math.max(s.y, margin), height - margin);
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  if (off) {
    // Off-screen peer: a dot pinned to the viewport edge.
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 15);
    ctx.lineTo(x + 4.2, y + 11);
    ctx.lineTo(x + 7.2, y + 17.5);
    ctx.lineTo(x + 9.6, y + 16.4);
    ctx.lineTo(x + 6.8, y + 10.2);
    ctx.lineTo(x + 12, y + 10);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
  }
  if (name) {
    ctx.font = '600 12px Helvetica, "Segoe UI", Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const label = String(name).slice(0, 32);
    const tw = ctx.measureText(label).width;
    const padX = 6;
    const bh = 20;
    const bw = tw + padX * 2;
    let bx = x + (off ? 8 : 10);
    let by = y + (off ? -bh / 2 : 18);
    // Pinned to the right edge: put the tag on the dot's left.
    if (bx + bw > width - 2) bx = off ? x - 8 - bw : width - bw - 2;
    bx = Math.max(2, bx);
    by = Math.min(Math.max(by, 2), height - bh - 2);
    ctx.fillStyle = color;
    roundedRectPath(ctx, bx, by, bw, bh, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, bx + padX, by + bh / 2 + 0.5);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Interactive layer
 * ------------------------------------------------------------------ */

/**
 * Paint the interactive overlay (transparent canvas on top of the static one).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} p
 * @param {object[]} p.elements
 * @param {Set<string>} p.selection
 * @param {{zoom,panX,panY}} p.view
 * @param {number} p.width  CSS px
 * @param {number} p.height CSS px
 * @param {number} [p.dpr]
 * @param {object} [p.interaction]  reducer state: mode, marquee (board rect),
 *   bindTarget (element or id), linearEdit {id, hoverIndex, activeIndex},
 *   eraserTrail (board points, oldest first), draft
 * @param {Map<string,{x,y,name,color,at}>} [p.remoteCursors]  board units
 * @param {string} [p.myPeerId]
 * @param {string|null} [p.hoveredId]
 * @param {string|null} [p.editingId]
 * @param {Map<string,{ids:string[], color:string}>} [p.peerSelections]
 * @param {object|null} [p.draft]  OPTIONAL: paint the element being created
 *   here instead of on the static layer (pass it to exactly one of the two).
 *   On a big board this keeps a drag-to-create from repainting every shape
 *   on every pointer move.
 * @param {() => void} [p.onImageLoad]
 */
export function renderInteractive(ctx, p) {
  const {
    elements = [],
    selection,
    view,
    width = 0,
    height = 0,
    dpr = 1,
    interaction,
    remoteCursors,
    myPeerId,
    hoveredId = null,
    editingId = null,
    peerSelections,
    draft = null,
    onImageLoad,
  } = p || {};
  const { zoom, panX, panY } = normView(view);
  const it = interaction || {};
  const mode = it.mode || 'idle';

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, ctx.canvas?.width ?? width * dpr, ctx.canvas?.height ?? height * dpr);
  if (draft) {
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);
    drawElement(ctx, draft, { zoom, onImageLoad, isEditing: draft.id === editingId });
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const toScreen = (b) => ({ x: b.x * zoom + panX, y: b.y * zoom + panY });
  const sel = asSet(selection) ?? new Set();
  let byId = null;
  const lookup = (id) => {
    if (!byId) byId = new Map(elements.map((e) => [e?.id, e]));
    return byId.get(id);
  };

  // --- collaborators' selections -------------------------------------
  for (const [peerId, ps] of entriesOf(peerSelections)) {
    if (peerId === myPeerId || !ps) continue;
    const ids = Array.isArray(ps.ids) ? ps.ids : ps.ids instanceof Set ? [...ps.ids] : [];
    for (const id of ids) {
      const el = lookup(id);
      if (!el) continue;
      const f = selectionFrame([el], zoom);
      if (f) strokeFrame(ctx, f, toScreen, { color: ps.color || '#868e96', width: 1.5 });
    }
  }

  // --- hover -----------------------------------------------------------
  if (hoveredId && mode === 'idle' && !sel.has(hoveredId) && hoveredId !== editingId) {
    const el = lookup(hoveredId);
    if (el && !el.locked) {
      const f = selectionFrame([el], zoom);
      if (f) strokeFrame(ctx, f, toScreen, { color: 'rgba(105, 101, 219, 0.45)' });
    }
  }

  // --- bind target -----------------------------------------------------
  if (it.bindTarget) {
    const el = typeof it.bindTarget === 'string' ? lookup(it.bindTarget) : it.bindTarget;
    if (el) {
      drawBindHighlight(ctx, el, view, dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // --- selection -------------------------------------------------------
  const selected = [];
  if (sel.size) {
    for (const el of elements) if (el && sel.has(el.id) && el.id !== editingId) selected.push(el);
  }
  const linearEditId = it.linearEdit?.id ?? null;
  const linearEl = linearEditId
    ? lookup(linearEditId)
    : selected.length === 1 && isLinear(selected[0])
      ? selected[0]
      : null;

  if (selected.length && mode !== 'erasing') {
    const anyLocked = selected.some((e) => e.locked);
    const hideHandles = mode === 'moving' || mode === 'rotating' || anyLocked;
    if (selected.length === 1) {
      const el = selected[0];
      if (!(linearEl && linearEl.id === el.id)) {
        const f = selectionFrame([el], zoom);
        if (f) {
          strokeFrame(ctx, f, toScreen);
          if (!hideHandles) drawHandles(ctx, f, zoom, toScreen, { rotatable: isRotatable(el) });
        }
      }
    } else {
      // Excalidraw: every selected element (or selected group) gets a thin
      // solid frame, and the whole selection a dashed frame with handles.
      const groups = new Map();
      const singles = [];
      for (const el of selected) {
        if (el.groupId) {
          if (!groups.has(el.groupId)) groups.set(el.groupId, []);
          groups.get(el.groupId).push(el);
        } else singles.push(el);
      }
      // A selection that is exactly one group is framed by the common frame.
      const oneGroup = groups.size === 1 && singles.length === 0;
      for (const members of groups.values()) {
        if (members.length === 1) singles.push(members[0]);
        else if (!oneGroup) {
          const b = commonBounds(members);
          const pad = SELECTION_PADDING / 2 / zoom;
          if (b) {
            strokeFrame(
              ctx,
              { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2, rotation: 0 },
              toScreen,
              { dash: [4, 3], color: 'rgba(105, 101, 219, 0.8)' },
            );
          }
        }
      }
      // Inset by half the padding so they do not merge with the common frame.
      const inset = SELECTION_PADDING / 2 / zoom;
      for (const el of singles) {
        const f = selectionFrame([el], zoom);
        if (f) {
          const g = { ...f, x: f.x + inset, y: f.y + inset, w: f.w - inset * 2, h: f.h - inset * 2 };
          strokeFrame(ctx, g, toScreen, { color: 'rgba(105, 101, 219, 0.7)' });
        }
      }
      // Exactly the frame the reducer hit-tests handles against (handles.js):
      // the square you see must be the square you can grab.
      const all = selectionFrame(selected, zoom);
      if (all) {
        strokeFrame(ctx, all, toScreen, { dash: [2, 2] });
        if (!hideHandles) drawHandles(ctx, all, zoom, toScreen, { rotatable: true });
      }
    }
  }

  // --- connector point handles ----------------------------------------
  if (linearEl && Array.isArray(linearEl.points) && !linearEl.locked && mode !== 'moving' && mode !== 'erasing') {
    const le = it.linearEdit && it.linearEdit.id === linearEl.id ? it.linearEdit : {};
    drawPointHandles(ctx, linearEl.points, toScreen, {
      hoverIndex: le.hoverIndex ?? -1,
      activeIndex: le.activeIndex ?? -1,
      selectedIndices: asSet(le.selectedIndices),
    });
  }
  // While clicking out a multi-point connector, show the points placed so far.
  if (mode === 'linear' && it.draft && isLinear(it.draft) && Array.isArray(it.draft.points)) {
    drawPointHandles(ctx, it.draft.points.slice(0, -1), toScreen);
  }

  // --- marquee ---------------------------------------------------------
  const mq = normRect(it.marquee);
  if (mq) {
    const a = toScreen({ x: mq.x, y: mq.y });
    const w = mq.w * zoom;
    const h = mq.h * zoom;
    ctx.save();
    ctx.fillStyle = SELECTION_FILL;
    ctx.fillRect(a.x, a.y, w, h);
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(w), Math.round(h));
    ctx.restore();
  }

  // --- eraser trail ----------------------------------------------------
  if (it.eraserTrail) drawEraserTrail(ctx, it.eraserTrail, toScreen);

  // --- collaborators' cursors -----------------------------------------
  for (const [peerId, c] of entriesOf(remoteCursors)) {
    if (!c || peerId === myPeerId || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    drawRemoteCursor(ctx, toScreen(c), c.name, c.color || '#1971c2', width, height);
  }
}
