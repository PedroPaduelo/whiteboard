/**
 * renderer.js — paint the whole board into a 2D context.
 *
 * The only interesting parts are the ones that are easy to get wrong:
 *
 *  - DEVICE PIXEL RATIO. The backing store is `width*dpr` by `height*dpr`, and
 *    the context transform is pre-scaled by `dpr` ONCE. Everything after that
 *    is in CSS pixels, so no draw function ever multiplies by dpr and a 1px
 *    line stays 1px. `resizeCanvas` is the single place that sets this up.
 *
 *  - WHEN NOT TO REDRAW. `sceneSignature` is a cheap string key over exactly
 *    the inputs that change pixels. The canvas redraws when it changes and
 *    not otherwise, because a 5000-element board repainted 60 times a second
 *    while nobody touches it is a battery complaint, not a feature.
 *
 *  - VIEW TRANSFORM. Applied once around the whole element pass, so the draw
 *    functions work in board units and hit-test/geometry stay in one space.
 */

import { withAlpha, colorForPeer, mix } from '@whiteboard/shared';
import { drawElement } from './shapes.js';

/** Below this zoom the grid is noise, so it is not drawn at all. */
export const GRID_MIN_ZOOM = 0.3;

/** Handle size in SCREEN px, so handles stay grabbable at any zoom. */
export const HANDLE_SIZE = 8;

/** Rotation handle sits this far (screen px) above the box. */
export const ROTATE_HANDLE_OFFSET = 22;

/** Default palette, mirroring the CSS tokens in `styles/tokens.css`. */
export const THEME_COLORS = Object.freeze({
  light: {
    bg: '#f4f5f7',
    grid: '#d7dae1',
    gridStrong: '#b9bfca',
    selection: '#2f6df6',
    marqueeFill: 'rgba(47,109,246,0.10)',
    marqueeStroke: 'rgba(47,109,246,0.70)',
    hover: '#2f6df6',
    text: '#16181d',
    handleFill: '#ffffff',
  },
  dark: {
    bg: '#15171c',
    grid: '#2b2f38',
    gridStrong: '#3d434f',
    selection: '#6f9bff',
    marqueeFill: 'rgba(111,155,255,0.12)',
    marqueeStroke: 'rgba(111,155,255,0.75)',
    hover: '#6f9bff',
    text: '#e7e9ee',
    handleFill: '#15171c',
  },
});

/** @param {'light'|'dark'} theme */
export function themeColors(theme) {
  return THEME_COLORS[theme === 'dark' ? 'dark' : 'light'];
}

/* ------------------------------------------------------------------ *
 * Canvas sizing / DPR
 * ------------------------------------------------------------------ */

/**
 * Size the backing store for the current DPR and pre-scale the context.
 *
 * Returns true when the backing store actually changed, so the caller knows
 * whether a full repaint is required. A DPR change on a moved window is the
 * classic source of a blurry canvas: the store is sized in device pixels, so
 * it must be re-created whenever the ratio changes, not just on resize.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} [dpr] defaults to window.devicePixelRatio, clamped to 3
 *   because a 4x phone ratio on a large canvas costs 16x the fill rate for
 *   no visible gain.
 * @returns {boolean} true if the backing store was resized
 */
export function resizeCanvas(canvas, dpr) {
  if (!canvas) return false;
  const ratio = clampDpr(dpr == null ? (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) : dpr);
  const cssW = canvas.clientWidth || canvas.width || 1;
  const cssH = canvas.clientHeight || canvas.height || 1;
  const bw = Math.max(1, Math.round(cssW * ratio));
  const bh = Math.max(1, Math.round(cssH * ratio));
  const changed = canvas.width !== bw || canvas.height !== bh;
  if (changed) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // The pre-scale. Everything downstream is CSS pixels.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  return changed;
}

export function clampDpr(dpr) {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.min(3, Math.max(1, d));
}

/* ------------------------------------------------------------------ *
 * Grid
 * ------------------------------------------------------------------ */

/**
 * Draw the background grid in SCREEN space (after the view transform is
 * undone), which is the only way to keep the line density constant as you
 * zoom — a grid in board space doubles in screen density per zoom step and
 * turns to mush by 300%.
 *
 * `style` is 'dots' or 'lines'; the store's gridSize of 0 means "no grid".
 */
function drawGrid(ctx, view, width, height, colors, size, style) {
  if (!size || size <= 0) return;
  const zoom = view.zoom || 1;
  if (zoom < GRID_MIN_ZOOM) return;

  // Screen spacing of one grid cell. When cells get closer than ~10px the
  // pattern is pure noise, so step up to a coarser multiple instead.
  const step = size * zoom;
  if (step < 10) return;
  const stride = step < 18 ? Math.ceil(18 / step) : 1;
  const px = step * stride;

  // Origin of the lattice, in screen space.
  const ox = ((view.panX % px) + px) % px;
  const oy = ((view.panY % px) + px) % px;

  // Fade the grid out toward the edges: a full-strength grid right up to the
  // viewport border competes with the content, and the eye goes to the grid
  // instead of the drawing.
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.grid;

  const col = style === 'lines';
  const startX = Math.floor(ox);
  const startY = Math.floor(oy);

  if (col) {
    ctx.beginPath();
    for (let x = startX; x <= width; x += px) {
      const px0 = Math.round(x) + 0.5;
      ctx.moveTo(px0, 0);
      ctx.lineTo(px0, height);
    }
    for (let y = startY; y <= height; y += px) {
      const py0 = Math.round(y) + 0.5;
      ctx.moveTo(0, py0);
      ctx.lineTo(width, py0);
    }
    ctx.stroke();
  } else {
    // Dots: one path, many tiny arcs. Cheaper and crisper than fillRect of
    // 1px squares, which alias badly at fractional DPR.
    const r = zoom > 1.5 ? 1.2 : 0.9;
    ctx.beginPath();
    for (let x = startX; x <= width; x += px) {
      const gx = Math.round(x) + 0.5;
      for (let y = startY; y <= height; y += px) {
        ctx.moveTo(gx + r, Math.round(y) + 0.5);
        ctx.arc(gx, Math.round(y) + 0.5, r, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
  ctx.restore();
  void colors.gridStrong;
}

/* ------------------------------------------------------------------ *
 * Selection, hover, marquee
 * ------------------------------------------------------------------ */

/**
 * The eight resize handles for a box, in SCREEN coordinates.
 * Exported because the pen's hit-region logic needs the exact
 * same set — if the two ever disagree, you grab a handle and drag nothing.
 *
 * @returns {Array<{name:string, x:number, y:number}>} corners and edge mids
 */
export function handlePositions(box, view) {
  const z = view.zoom || 1;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const l = box.x * z + (view.panX || 0);
  const t = box.y * z + (view.panY || 0);
  const r = (box.x + box.w) * z + (view.panX || 0);
  const b = (box.y + box.h) * z + (view.panY || 0);
  return [
    { name: 'nw', x: l, y: t },
    { name: 'n', x: (l + r) / 2, y: t },
    { name: 'ne', x: r, y: t },
    { name: 'e', x: r, y: (t + b) / 2 },
    { name: 'se', x: r, y: b },
    { name: 's', x: (l + r) / 2, y: b },
    { name: 'sw', x: l, y: b },
    { name: 'w', x: l, y: (t + b) / 2 },
  ];
}

const HANDLE_ORDER = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** The rotate handle, in screen coords, above the box. */
export function rotateHandlePosition(box, view) {
  const z = view.zoom || 1;
  const cx = (box.x + box.w / 2) * z + (view.panX || 0);
  const top = box.y * z + (view.panY || 0);
  return { name: 'rotate', x: cx, y: top - ROTATE_HANDLE_OFFSET };
}

function drawSelectionBox(ctx, box, view, colors, opts = {}) {
  const z = view.zoom || 1;
  const x = box.x * z + (view.panX || 0);
  const y = box.y * z + (view.panY || 0);
  const w = box.w * z;
  const h = box.h * z;
  const color = opts.color || colors.selection;

  ctx.save();
  // A dashed outline reads as "this is a frame", not as content, and stays
  // visible over a fill of the same hue.
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));

  if (opts.handles !== false) {
    const hs = HANDLE_SIZE;
    const half = hs / 2;
    const pos = handlePositions(box, view);
    // Handles are drawn even for a zero-extent element (a horizontal line has
    // h === 0), which is why the fallback box is padded rather than skipped.
    ctx.fillStyle = opts.handleFill || colors.handleFill;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i];
      const hy = p.y;
      const hx = p.x;
      ctx.beginPath();
      ctx.rect(Math.round(hx - half) + 0.5, Math.round(hy - half) + 0.5, hs, hs);
      ctx.fill();
      ctx.stroke();
    }
    // Rotate handle: a stem up from the top edge plus a circle.
    const rp = rotateHandlePosition(box, view);
    ctx.beginPath();
    ctx.moveTo(Math.round(cx(box, view)) + 0.5, Math.round(y) + 0.5);
    ctx.lineTo(Math.round(rp.x) + 0.5, Math.round(rp.y) + 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(Math.round(rp.x) + 0.5, Math.round(rp.y) + 0.5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function cx(box, view) {
  return (box.x + box.w / 2) * (view.zoom || 1) + (view.panX || 0);
}

function drawHoverOutline(ctx, box, view, colors) {
  const z = view.zoom || 1;
  ctx.save();
  ctx.strokeStyle = withAlpha(colors.hover, 0.75);
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(
    Math.round(box.x * z + (view.panX || 0)) + 0.5,
    Math.round(box.y * z + (view.panY || 0)) + 0.5,
    Math.round(box.w * z),
    Math.round(box.h * z),
  );
  ctx.restore();
}

function drawMarquee(ctx, rect, view, colors) {
  const z = view.zoom || 1;
  const x = rect.x * z + (view.panX || 0);
  const y = rect.y * z + (view.panY || 0);
  const w = rect.w * z;
  const h = rect.h * z;
  ctx.save();
  ctx.fillStyle = colors.marqueeFill;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = colors.marqueeStroke;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  ctx.restore();
}

/**
 * The eraser sweep highlight: a translucent red band along the path the
 * eraser has actually travelled, so you can see what you are about to delete
 * before you let go.
 */
function drawEraserTrail(ctx, points, view, colors) {
  if (!points || points.length < 2) return;
  const z = view.zoom || 1;
  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 22;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x * z + (view.panX || 0), points[0].y * z + (view.panY || 0));
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x * z + (view.panX || 0), points[i].y * z + (view.panY || 0));
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(239,68,68,0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.stroke();
  ctx.restore();
  void colors;
}

/* ------------------------------------------------------------------ *
 * Remote cursors
 * ------------------------------------------------------------------ */

/**
 * A peer's pointer: a filled triangle in their colour with a light halo behind
 * it, plus a name label. The halo is what makes it readable over an arbitrary
 * fill — a peer colour on a same-hue sticky note would otherwise vanish.
 */
function drawRemoteCursor(ctx, cur, view, colors) {
  const z = view.zoom || 1;
  const x = cur.x * z + (view.panX || 0);
  const y = cur.y * z + (view.panY || 0);

  const color = cur.color || colorForPeer(cur.id || cur.peerId || 'peer');
  const name = cur.name || '';

  ctx.save();
  // Halo: the same silhouette in near-white, drawn first and slightly larger.
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 13, y + 17);
  ctx.lineTo(x + 6.5, y + 18.5);
  ctx.lineTo(x + 3.5, y + 24);
  ctx.closePath();
  ctx.fillStyle = withAlpha(colors.bg, 0.9);
  ctx.fill();
  ctx.strokeStyle = withAlpha(colors.bg, 0.9);
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 13, y + 17);
  ctx.lineTo(x + 6.5, y + 18.5);
  ctx.lineTo(x + 3.5, y + 24);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.stroke();

  if (name) {
    ctx.font = `600 12px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    const w = ctx.measureText(name).width + 14;
    const bx = x + 16;
    const by = y + 20;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(bx, by, w, 20, 6);
    } else {
      ctx.rect(bx, by, w, 20);
    }
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, bx + 7, by + 10.5);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * The scene
 * ------------------------------------------------------------------ */

/**
 * Paint one frame. Everything is optional except `ctx`; the defaults keep the
 * call sites short.
 *
 * Draw order (the contract): background -> grid -> elements in z-order ->
 * remote cursors -> selection -> marquee -> hover.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} state
 * @param {Array<object>} state.elements
 * @param {{zoom:number,panX:number,panY:number}} state.view
 * @param {'light'|'dark'} [state.theme]
 * @param {Set<string>|string[]} [state.selection]
 * @param {string|null} [state.hoveredId]
 * @param {{x,y,w,h}|null} [state.marquee]
 * @param {Array|Map} [state.remoteCursors]
 * @param {number} [state.gridSize]
 * @param {'dots'|'lines'} [state.gridStyle]
 * @param {{x,y,w,h}|null} [state.selectionBounds] precomputed union box
 * @param {Array} [state.eraserTrail] board-space path for the eraser preview
 * @param {boolean} [state.altDown] suppress hover outline while alt-cycling
 */
export function drawScene(ctx, state) {
  if (!ctx) return;
  const {
    elements = [],
    view = { zoom: 1, panX: 0, panY: 0 },
    theme = 'light',
    selection = null,
    hoveredId = null,
    marquee = null,
    remoteCursors = null,
    gridSize = 0,
    gridStyle = 'dots',
    selectionBounds = null,
    eraserTrail = null,
    showSelection = true,
    // `background: null` means "paint nothing behind the content" — the pen
    // underlay sits UNDER React Flow, so filling the canvas here would cover
    // the grid, the minimap and the nodes. `ink` overrides the pen colour.
    background,
    ink,
  } = state || {};

  const colors = themeColors(theme);
  const width = state && state.width ? state.width : canvasCssWidth(ctx);
  const height = state && state.height ? state.height : canvasCssHeight(ctx);
  const zoom = view.zoom || 1;
  const panX = view.panX || 0;
  const panY = view.panY || 0;

  // The context arrives with the DPR pre-scale from `resizeCanvas`. Every
  // save/restore below composes on top of that, so all of this is CSS pixels.
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  const bg = background === null ? null : (background || colors.bg);
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();

  // The grid is drawn in SCREEN space (identity view) so its on-screen density
  // stays constant as you zoom; a board-space grid turns to mush by 300%.
  // On the pen underlay there is no grid — React Flow draws it.
  if (bg) {
    drawGrid(ctx, view, width, height, colors, gridSize, gridStyle);
  }

  // --- Elements. The view transform is applied ONCE around the whole pass so
  // --- every draw function works in board units. screen = board * zoom + pan.
  ctx.save();
  ctx.scale(zoom, zoom);
  ctx.translate(panX, panY);
  for (let i = 0; i < elements.length; i++) {
    let el = elements[i];
    if (!el) continue;
    // The underlay paints only strokes, and may recolour them to match the
    // theme when the element itself carries no colour.
    if (ink && el.type === 'pen' && !el.stroke) el = { ...el, stroke: ink };
    drawElement(ctx, el, view);
  }
  ctx.restore();

  if (eraserTrail) drawEraserTrail(ctx, eraserTrail, view, colors);

  // --- Remote cursors, in screen space (they are chrome, not board content).
  if (remoteCursors) {
    const list = remoteCursors instanceof Map ? Array.from(remoteCursors.values()) : remoteCursors;
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];
      if (cur && cur.x !== undefined) drawRemoteCursor(ctx, cur, view, colors);
    }
  }

  // --- Selection.
  if (showSelection && selection && selection.size > 0 && selectionBounds) {
    drawSelectionBox(ctx, selectionBounds, view, colors, { handles: selection.size === 1 || state?.showHandles });
  }

  if (marquee) drawMarquee(ctx, marquee, view, colors);

  // --- Hover outline goes last so it is never buried under the marquee.
  if (hoveredId && !selection?.has?.(hoveredId) && selectionBounds !== null) {
    const hb = state?.hoverBounds;
    if (hb) drawHoverOutline(ctx, hb, view, colors);
  }
}

function canvasCssWidth(ctx) {
  const c = ctx && ctx.canvas;
  if (!c) return 0;
  const dpr = c.width / (c.clientWidth || c.width || 1);
  return c.clientWidth || c.width / (dpr || 1);
}

function canvasCssHeight(ctx) {
  const c = ctx && ctx.canvas;
  if (!c) return 0;
  const dpr = c.height / (c.clientHeight || c.height || 1);
  return c.clientHeight || c.height / (dpr || 1);
}

/* ------------------------------------------------------------------ *
 * Redraw gating
 * ------------------------------------------------------------------ */

/**
 * A cheap key over exactly the inputs that change pixels. If this string is
 * unchanged, the frame on the canvas is still correct and the rAF can skip.
 *
 * Deliberately built from numbers and booleans, not from JSON.stringify of
 * the element array: a 5000-element board would stringify on every pointer
 * move. The element count plus a caller-supplied `revision` (the store's `rev`
 * plus a local mutation counter) covers "the content changed".
 */
export function sceneSignature(state) {
  if (!state) return 'none';
  const { elements, view, theme, selection, hoveredId, marquee, remoteCursors, gridSize, snapEnabled, dpr, width, height, revision, editingId } = state;
  const selCount = selection ? (selection.size ?? selection.length ?? 0) : 0;
  let selSum = 0;
  if (selection) {
    for (const id of selection) {
      let h = 0;
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
      selSum = (selSum + h) | 0;
    }
  }
  const cursors = remoteCursors
    ? (remoteCursors instanceof Map ? remoteCursors.size : remoteCursors.length) +
      ':' +
      (Array.from(remoteCursors instanceof Map ? remoteCursors.values() : remoteCursors)
        .map((c) => `${c && c.x},${c && c.y},${c && c.color || ''}`)
        .join(';'))
    : '0';
  const mq = marquee ? `${marquee.x},${marquee.y},${marquee.w},${marquee.h}` : '-';
  return [
    elements ? elements.length : 0,
    revision == null ? '' : revision,
    view.zoom, view.panX, view.panY,
    theme, selCount, selSum, hoveredId || '-',
    mq, cursors, gridSize, snapEnabled ? 1 : 0,
    dpr, width, height, editingId || '-',
  ].join('|');
}

/**
 * A peer colour for anything without one (the store's `peers` may be ahead of
 * `remoteCursors`).
 */
export function peerColor(id, provided) {
  return provided || colorForPeer(String(id || 'peer'));
}

/** Mixed hover tint, used when a hovered element is a peer-owned selection. */
export function hoverTint(color) {
  return mix(color, '#ffffff', 0.35);
}

export { HANDLE_ORDER };
