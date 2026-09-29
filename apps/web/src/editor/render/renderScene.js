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
 * repaints only the cheap interactive layer, not every rough shape. And a
 * static repaint (every pan and zoom step) does not replay the shapes either:
 * each element is blitted from a bitmap of its own (elementCache.js).
 *
 * Both canvases are sized in DEVICE px (`canvas.width = cssW * dpr`) and
 * every function sets its own transform, so no caller state leaks in:
 *   board space   setTransform(dpr*zoom, 0, 0, dpr*zoom, dpr*panX, dpr*panY)
 *   screen space  setTransform(dpr, 0, 0, dpr, 0, 0)
 * View convention everywhere: screen = board * zoom + pan.
 *
 * The renderer always draws LIGHT colours; dark mode is a CSS filter the
 * Canvas component puts on both canvases (DARK_MODE_FILTER). Two things must
 * not change colour under it, so in dark mode they are painted through its
 * inverse: raster images (a photo is not a drawing) and collaborators'
 * cursors and selections (their colour must match their avatar, which is
 * plain DOM).
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
import { expandSelectionToGroups } from '../scene.js';
import { onFontsLoaded } from '../fonts.js';
import { drawElement, textPaintBounds } from './renderElement.js';
import { darkPreimage, segmentMidpoints, curveSegments } from './shape.js';
import { beginBitmapFrame } from './elementCache.js';

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

/**
 * The view both layers paint with: its pan rounded to whole DEVICE px.
 * Element bitmaps (elementCache.js) are blitted 1:1 at whole device px to
 * stay crisp, so the static layer's board origin must sit on a device pixel;
 * everything else on both layers (grid, directly drawn elements, selection
 * chrome) uses the same rounded pan, so nothing drifts apart. Off by at most
 * half a device px from the exact view.
 * `originX/Y`: device px of board (0, 0), whole numbers.
 */
export function deviceView(view, dpr = 1) {
  const { zoom, panX, panY } = normView(view);
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const originX = Math.round(panX * d) || 0;
  const originY = Math.round(panY * d) || 0;
  return { zoom, panX: originX / d, panY: originY / d, originX, originY };
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

/**
 * Everything an element may paint, board units, as {x0, y0, x1, y1}: its
 * geometric bounds plus the paint margin, united with its text (a label runs
 * past a box that is too small for it). null when the element has no usable
 * geometry. Cached per element object (a pen stroke's bounds are
 * O(points)); text widths change when the fonts load, so the cache goes too.
 */
let boundsCache = new WeakMap();
onFontsLoaded(() => {
  boundsCache = new WeakMap();
});

function computePaintedBounds(el) {
  const b = elementBounds(el);
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.w) || !Number.isFinite(b.h)) return null;
  const m = paintMargin(el);
  const out = { x0: b.x - m, y0: b.y - m, x1: b.x + b.w + m, y1: b.y + b.h + m };
  const t = textPaintBounds(el);
  if (t) {
    out.x0 = Math.min(out.x0, t.x);
    out.y0 = Math.min(out.y0, t.y);
    out.x1 = Math.max(out.x1, t.x + t.w);
    out.y1 = Math.max(out.y1, t.y + t.h);
  }
  return out;
}

function paintedBounds(el) {
  let b = boundsCache.get(el);
  if (b === undefined) {
    b = computePaintedBounds(el);
    boundsCache.set(el, b);
  }
  return b;
}

/** True when the element may paint inside `rect` (board units). */
export function isElementVisible(el, rect) {
  let b;
  try {
    b = paintedBounds(el);
  } catch {
    return true;
  }
  if (!b) return true;
  return !(b.x1 < rect.x || b.y1 < rect.y || b.x0 > rect.x + rect.w || b.y0 > rect.y + rect.h);
}

/**
 * Whether the canvas is shown through DARK_MODE_FILTER: the `theme` the
 * caller passes ('light' | 'dark'), or, when it passes none, whatever filter
 * the canvas element itself carries (the Canvas component sets it inline) —
 * so what gets countered is exactly what is applied.
 */
export function isDarkCanvas(theme, ctx) {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  try {
    const f = ctx?.canvas?.style?.filter;
    return typeof f === 'string' && f.includes('invert');
  } catch {
    return false;
  }
}

/*
 * When the theme is inferred from the canvas's filter, the painted pixels
 * depend on that filter, so a theme switch must repaint — even when nothing
 * the caller tracks changed. Each such canvas gets one MutationObserver on
 * its style that calls the caller's latest repaint callback when the filter
 * changes. (Not used when the caller passes `theme` and repaints on its own.)
 */
const filterWatches = new WeakMap(); // canvas element -> {filter, repaint}

function watchCanvasFilter(canvas, repaint) {
  if (typeof MutationObserver === 'undefined' || typeof repaint !== 'function') return;
  if (!canvas || canvas.nodeType !== 1 || !canvas.style) return;
  let w = filterWatches.get(canvas);
  if (!w) {
    w = { filter: canvas.style.filter || '', repaint };
    const watch = w;
    new MutationObserver(() => {
      const f = canvas.style.filter || '';
      if (f === watch.filter) return;
      watch.filter = f;
      try {
        watch.repaint();
      } catch (err) {
        console.error('[render] repaint after a theme change failed', err);
      }
    }).observe(canvas, { attributes: true, attributeFilter: ['style'] });
    filterWatches.set(canvas, w);
  }
  w.repaint = repaint;
}

/* ------------------------------------------------------------------ *
 * Colours that must survive the dark filter
 * ------------------------------------------------------------------ */

const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function hslToRgb(h, s, l) {
  const hh = (((h % 360) + 360) % 360) / 30;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hh) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [f(0), f(8), f(4)];
}

/** [r, g, b (0..255), a (0..1)] of a hex / rgb() / hsl() colour, or null. */
export function parseColor(c) {
  if (typeof c !== 'string') return null;
  const s = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^(rgb|hsl)a?\(([^)]*)\)$/.exec(s);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const pct = (p, scale) => (p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p));
  const alpha = parts[3] === undefined ? 1 : pct(parts[3], 1);
  const rgb =
    m[1] === 'rgb'
      ? parts.slice(0, 3).map((p) => pct(p, 255))
      : hslToRgb(parseFloat(parts[0]), parseFloat(parts[1]) / 100, parseFloat(parts[2]) / 100);
  if (![...rgb, alpha].every(Number.isFinite)) return null;
  return [...rgb.map((v) => clampTo(Math.round(v), 0, 255)), clampTo(alpha, 0, 1)];
}

/** Any CSS colour a 2D context understands, read back as #rrggbb / rgba(). */
function normalizeColor(c, ctx) {
  if (!ctx) return c;
  try {
    const prev = ctx.fillStyle;
    ctx.fillStyle = c;
    const norm = ctx.fillStyle;
    ctx.fillStyle = prev;
    return typeof norm === 'string' ? norm : c;
  } catch {
    return c;
  }
}

const darkColors = new Map();

/**
 * The colour to paint on a dark-filtered canvas so that it SHOWS as `color`
 * (see darkPreimage), alpha kept. Unparseable colours come back unchanged.
 * @param {string} color
 * @param {CanvasRenderingContext2D} [ctx]  parses colour names / modern syntax
 */
export function colorForDarkCanvas(color, ctx) {
  const key = String(color);
  let out = darkColors.get(key);
  if (out) return out;
  const rgba = parseColor(key) ?? parseColor(normalizeColor(key, ctx));
  if (!rgba) out = key;
  else {
    const [r, g, b] = darkPreimage(rgba[0], rgba[1], rgba[2]);
    out = rgba[3] < 1 ? `rgba(${r}, ${g}, ${b}, ${rgba[3]})` : `rgb(${r}, ${g}, ${b})`;
  }
  if (darkColors.size > 256) darkColors.clear();
  darkColors.set(key, out);
  return out;
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
 * @param {'light'|'dark'} [p.theme]  'dark': the canvas is shown through
 *   DARK_MODE_FILTER, so images are drawn through its inverse. Pass it (and
 *   repaint when it changes). Omitted: read from the canvas element's own
 *   inline filter, and `onImageLoad` is also called when that filter changes.
 * @param {boolean} [p.bitmapCache=true]  paint elements from per-element
 *   bitmaps (elementCache.js) where possible; false draws every element
 *   directly. `onImageLoad` doubles as the repaint that sharpens bitmaps
 *   stretched during a zoom.
 * @returns {{drawn:number, culled:number, cached:number}} counts, for tests
 *   and debugging (`cached`: drawn from a bitmap)
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
    theme,
    bitmapCache = true,
  } = p || {};
  const { zoom, panX, panY, originX, originY } = deviceView(view, dpr);
  const dark = isDarkCanvas(theme, ctx);
  if (theme !== 'light' && theme !== 'dark') watchCanvasFilter(ctx.canvas, onImageLoad);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = CANVAS_BACKGROUND;
  ctx.fillRect(0, 0, ctx.canvas?.width ?? width * dpr, ctx.canvas?.height ?? height * dpr);

  if (showGrid && zoom >= GRID_MIN_ZOOM && gridSize > 0) {
    drawGrid(ctx, { zoom, panX, panY, width, height, dpr, gridSize });
  }

  const scale = dpr * zoom;
  const toBoard = () => ctx.setTransform(scale, 0, 0, scale, originX, originY);
  toBoard();
  const visible = visibleBoardRect(view, width, height);
  const shown = [];
  let culled = 0;
  for (const el of elements) {
    if (!el) continue;
    if (isElementVisible(el, visible)) shown.push(el);
    else culled++;
  }
  // Elements come from their bitmaps where they can (elementCache.js): pass
  // 1 rasterises whatever bitmaps are missing, pass 2 paints in z-order —
  // blits (which leave the transform at identity) and, for the rest, direct
  // drawing in board space.
  const bitmaps = bitmapCache
    ? beginBitmapFrame(ctx, { scale, originX, originY, zoom, viewportPx: width * height * dpr * dpr, repaint: onImageLoad })
    : null;
  const prepared = bitmaps ? shown.map((el) => (el.id === editingId ? null : bitmaps.prepare(el))) : null;
  let inBoard = true;
  const erasing = asSet(erasingIds);
  let drawn = 0;
  let cached = 0;
  const opts = { zoom, onImageLoad, isEditing: false, dark };
  shown.forEach((el, i) => {
    opts.isEditing = el.id === editingId;
    const ghost = erasing?.has(el.id);
    if (ghost) {
      ctx.save();
      ctx.globalAlpha = 0.3;
    }
    if (prepared?.[i] && bitmaps.paint(prepared[i], el)) {
      inBoard = false;
      cached++;
    } else {
      if (!inBoard) toBoard();
      inBoard = true;
      drawElement(ctx, el, opts);
    }
    if (ghost) {
      ctx.restore();
      inBoard = false; // whichever transform was saved
    }
    drawn++;
  });
  bitmaps?.end();
  if (draft) {
    toBoard();
    drawElement(ctx, draft, { zoom, onImageLoad, isEditing: draft.id === editingId, dark });
    drawn++;
  }
  return { drawn, culled, cached };
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

/** Screen px a segment must span before it gets a midpoint "+" marker. */
const MIDPOINT_MIN_SEGMENT = POINT_HANDLE_RADIUS * 4 + 8;

/**
 * Point-editing mode (double-click on a connector) must LOOK different from a
 * plain selection, or the double-click seems to do nothing: the connector
 * gets a soft violet halo along the path it draws, a round one also shows its
 * control polygon dashed, and every segment long enough gets a "+" marker at
 * its middle — where a double-click (or Ctrl/⌘-click) adds a point. Drawn
 * under the point handles.
 */
function drawPointEditing(ctx, el, toScreen) {
  const pts = el.points.map(toScreen);
  if (pts.length < 2) return;
  const curved = el.roundness === 'round' && el.points.length > 2;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // The halo follows what is drawn: the curve pieces for a round connector
  // (screen = affine image of board, so the control points map directly).
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (curved) {
    for (const [, c1, c2, p3] of curveSegments(el.points)) {
      const a = toScreen(c1);
      const b = toScreen(c2);
      const c = toScreen(p3);
      ctx.bezierCurveTo(a.x, a.y, b.x, b.y, c.x, c.y);
    }
  } else {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.strokeStyle = 'rgba(105, 101, 219, 0.2)';
  ctx.lineWidth = POINT_HANDLE_RADIUS * 2;
  ctx.stroke();
  if (curved) {
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(105, 101, 219, 0.6)';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const mids = segmentMidpoints(el.points, curved);
  const r = POINT_HANDLE_RADIUS;
  ctx.lineWidth = 1;
  mids.forEach((mb, i) => {
    const a = pts[i];
    const b = pts[i + 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) < MIDPOINT_MIN_SEGMENT) return;
    const m = toScreen(mb);
    ctx.beginPath();
    ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.strokeStyle = 'rgba(105, 101, 219, 0.7)';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(m.x - r + 2, m.y);
    ctx.lineTo(m.x + r - 2, m.y);
    ctx.moveTo(m.x, m.y - r + 2);
    ctx.lineTo(m.x, m.y + r - 2);
    ctx.strokeStyle = SELECTION_COLOR;
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

/** Width (screen px) of the eraser trail at its newest and oldest ends. */
const TRAIL_HEAD_WIDTH = 5;
const TRAIL_TAIL_WIDTH = 1;

/**
 * Outline of the eraser trail as ONE polygon, in the points' own space: a
 * stroke that tapers from TRAIL_TAIL_WIDTH at the oldest point to
 * TRAIL_HEAD_WIDTH at the newest (by distance along the path), with a round
 * head. Filled in a single `fill`, it has no overlapping translucent caps —
 * stroking segment by segment darkened every joint into a bead.
 * @param {{x:number,y:number}[]} points  oldest first
 * @returns {{x:number,y:number}[]} polygon (empty for fewer than 2 points)
 */
export function eraserTrailOutline(points, headWidth = TRAIL_HEAD_WIDTH, tailWidth = TRAIL_TAIL_WIDTH) {
  const pts = [];
  for (const p of points || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const q = pts[pts.length - 1];
    if (q && Math.hypot(p.x - q.x, p.y - q.y) < 0.5) continue; // no zero-length segments
    pts.push({ x: p.x, y: p.y });
  }
  const n = pts.length;
  if (n < 2) return [];
  const along = [0];
  const normals = []; // unit normal of each segment (left of the direction)
  for (let i = 1; i < n; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const d = Math.hypot(dx, dy);
    along.push(along[i - 1] + d);
    normals.push({ x: -dy / d, y: dx / d });
  }
  const total = along[n - 1];
  const half = (i) => (tailWidth + (headWidth - tailWidth) * (along[i] / total)) / 2;
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    // Vertex normal: the average of the two segments meeting here (the
    // previous one's alone at a hairpin turn, where the average vanishes).
    const a = normals[Math.max(0, i - 1)];
    const b = normals[Math.min(n - 2, i)];
    let nx = a.x + b.x;
    let ny = a.y + b.y;
    const len = Math.hypot(nx, ny);
    if (len < 1e-6) {
      nx = a.x;
      ny = a.y;
    } else {
      nx /= len;
      ny /= len;
    }
    const h = half(i);
    left.push({ x: pts[i].x + nx * h, y: pts[i].y + ny * h });
    right.push({ x: pts[i].x - nx * h, y: pts[i].y - ny * h });
  }
  // Round head: half a circle around the newest point, from the left side
  // through the direction of travel to the right side.
  const tip = pts[n - 1];
  const last = normals[n - 2];
  const r = half(n - 1);
  const start = Math.atan2(last.y, last.x); // the left normal's angle
  const head = [];
  const STEPS = 8;
  for (let k = 1; k < STEPS; k++) {
    const ang = start - (Math.PI * k) / STEPS;
    head.push({ x: tip.x + Math.cos(ang) * r, y: tip.y + Math.sin(ang) * r });
  }
  return [...left, ...head, ...right.reverse()];
}

function drawEraserTrail(ctx, trail, toScreen) {
  const raw = (Array.isArray(trail) ? trail : trail?.points ?? []).filter((p) => p && Number.isFinite(p.x));
  if (raw.length < 2) return;
  const screen = raw.map(toScreen);
  const poly = eraserTrailOutline(screen);
  if (poly.length < 3) return;
  ctx.save();
  ctx.setLineDash([]);
  // Fading from the oldest to the newest end: one gradient over one fill.
  const a = screen[0];
  const b = screen[screen.length - 1];
  let fill = 'rgba(0, 0, 0, 0.2)';
  if (typeof ctx.createLinearGradient === 'function' && Math.hypot(b.x - a.x, b.y - a.y) > 1) {
    fill = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    fill.addColorStop(0, 'rgba(0, 0, 0, 0.05)');
    fill.addColorStop(1, 'rgba(0, 0, 0, 0.25)');
  }
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Excalidraw-like pointer arrow + name tag, in the peer's colour. `paint`
 * maps a colour to what must be painted for it to show (identity in light
 * mode; through the dark filter's inverse in dark mode, so the cursor keeps
 * its avatar's colour and the label stays white).
 */
function drawRemoteCursor(ctx, s, name, color, width, height, paint = (c) => c) {
  const margin = 8;
  const off = s.x < 0 || s.y < 0 || s.x > width || s.y > height;
  const x = Math.min(Math.max(s.x, margin), width - margin);
  const y = Math.min(Math.max(s.y, margin), height - margin);
  const fill = paint(color);
  const white = paint('#ffffff');
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = fill;
  ctx.strokeStyle = white;
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
    ctx.fillStyle = fill;
    roundedRectPath(ctx, bx, by, bw, bh, 6);
    ctx.fill();
    ctx.strokeStyle = paint('rgba(255, 255, 255, 0.9)');
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = white;
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
 * @param {'light'|'dark'} [p.theme]  'dark': the canvas is shown through
 *   DARK_MODE_FILTER, so collaborators' colours are painted through its
 *   inverse (and a draft image too). Omitted: read from the canvas element.
 *
 * `interaction.linearEdit.editing` (point editing, entered by a double-click
 * on a connector) adds a halo along the connector and the "+" midpoint
 * markers (plus the dashed control polygon of a round one);
 * `interaction.linearEdit.selectedIndices` (optional Set/array) fills those
 * points like the active one.
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
    theme,
  } = p || {};
  // The same device-aligned pan as the static layer, so frames and handles
  // sit exactly on the strokes they outline.
  const aligned = deviceView(view, dpr);
  const { zoom, panX, panY } = aligned;
  const it = interaction || {};
  const mode = it.mode || 'idle';
  const dark = isDarkCanvas(theme, ctx);
  const peerPaint = dark ? (c) => colorForDarkCanvas(c, ctx) : (c) => c;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, ctx.canvas?.width ?? width * dpr, ctx.canvas?.height ?? height * dpr);
  if (draft) {
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);
    drawElement(ctx, draft, { zoom, onImageLoad, isEditing: draft.id === editingId, dark });
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
      if (f) strokeFrame(ctx, f, toScreen, { color: peerPaint(ps.color || '#868e96'), width: 1.5 });
    }
  }

  // --- hover -----------------------------------------------------------
  // The hover frame outlines what a click would select: a grouped element
  // brings its whole group (expandSelectionToGroups is what the click uses).
  if (hoveredId && mode === 'idle' && !sel.has(hoveredId) && hoveredId !== editingId) {
    const el = lookup(hoveredId);
    if (el && !el.locked) {
      const members = hoverGroup(elements, el, lookup);
      if (!members.some((m) => sel.has(m.id))) {
        const f = selectionFrame(members, zoom);
        if (f) strokeFrame(ctx, f, toScreen, { color: 'rgba(105, 101, 219, 0.45)' });
      }
    }
  }

  // --- bind target -----------------------------------------------------
  if (it.bindTarget) {
    const el = typeof it.bindTarget === 'string' ? lookup(it.bindTarget) : it.bindTarget;
    if (el) {
      drawBindHighlight(ctx, el, aligned, dpr);
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
    if (le.editing) drawPointEditing(ctx, linearEl, toScreen);
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
    drawRemoteCursor(ctx, toScreen(c), c.name, c.color || '#1971c2', width, height, peerPaint);
  }
}

/** One-entry memo: the hover frame is recomputed on every pointer move. */
let hoverMemo = { elements: null, id: null, members: null };

/** The elements a click on `el` selects: its group (if any), else itself. */
function hoverGroup(elements, el, lookup) {
  if (hoverMemo.elements === elements && hoverMemo.id === el.id) return hoverMemo.members;
  let members = [el];
  const grouped = !!el.groupId || elements.some((e) => e && e.groupId === el.id);
  if (grouped) {
    try {
      const ids = expandSelectionToGroups(elements, [el.id]);
      const list = ids.map(lookup).filter(Boolean);
      if (list.length) members = list;
    } catch {
      members = [el];
    }
  }
  hoverMemo = { elements, id: el.id, members };
  return members;
}
