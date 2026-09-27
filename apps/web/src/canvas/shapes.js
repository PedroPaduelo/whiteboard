/**
 * shapes.js — one pure draw function per element type.
 *
 * This module is the reason an exported PNG is pixel-identical to the screen:
 * `export.js` walks the same functions to build SVG nodes, and the canvas
 * renderer calls them directly. So the ONE rule that matters in here:
 *
 *   A draw function is a pure function of (ctx, el, view). No store, no
 *   globals, no DOM reads, and every save() has a matching restore().
 *
 * Leaked canvas state is the classic whiteboard bug: one element that forgets
 * a restore() leaves a transform behind and the entire rest of the board
 * shears. `withRotation` below is the single place rotation happens, and
 * `drawElement` brackets every element in a save/restore pair, so there are
 * exactly two places to get right.
 */

import { readableTextOn } from '@whiteboard/shared';

/** @typedef {{x:number,y:number}} Point */
/** @typedef {{x:number,y:number,w:number,h:number}} Rect */

/** Font stack used by both the canvas and the SVG export. */
export const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif";

/** Line height multiplier for multi-line text. Matches the export exactly. */
export const LINE_HEIGHT = 1.25;

/** Default stroke width when an element does not carry one. */
export const DEFAULT_STROKE_WIDTH = 2;

/* ------------------------------------------------------------------ *
 * Image cache
 * ------------------------------------------------------------------ */

// Module-level Map keyed by src. Deliberately module-level (not per-draw):
// an image element is expensive to build and the browser already caches the
// decoded bitmap, so sharing across every draw of every frame is correct.
const imageCache = new Map();

/** @returns {{img: HTMLImageElement|null, state: 'loading'|'ready'|'error'}} */
function getImage(src) {
  if (!src) return { img: null, state: 'error' };
  const hit = imageCache.get(src);
  if (hit) return hit;
  if (typeof Image === 'undefined') return { img: null, state: 'error' };
  const img = new Image();
  const entry = { img, state: 'loading' };
  imageCache.set(src, entry);
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    entry.state = 'ready';
  };
  img.onerror = () => {
    entry.state = 'error';
  };
  img.src = src;
  return entry;
}

/**
 * Warm the cache for a set of srcs. Exported so the exporter can await decode
 * before it serialises, and so a dropped image starts loading immediately
 * instead of on the next frame.
 * @param {Iterable<string>} srcs
 */
export function preloadImages(srcs) {
  for (const src of srcs) {
    if (src) getImage(src);
  }
}

/** Drop the cache. Used by tests; also correct when a data: URL is replaced. */
export function clearImageCache() {
  imageCache.clear();
}

/* ------------------------------------------------------------------ *
 * Small pure helpers (also used by export.js)
 * ------------------------------------------------------------------ */

/** Is this fill actually going to paint? */
export function hasFill(fill) {
  return typeof fill === 'string' && fill !== '' && fill !== 'none' && fill !== 'transparent';
}

/** Apply an element's stroke style (solid/dashed/dotted) at width `w`. */
export function applyDash(ctx, style, w) {
  if (style === 'dashed') ctx.setLineDash([w * 3, w * 2]);
  else if (style === 'dotted') ctx.setLineDash([w * 1, w * 2.5]);
  else ctx.setLineDash([]);
}

/** `dasharray` as an SVG attribute string, or null for solid. */
export function dashArrayFor(style, w) {
  if (style === 'dashed') return `${w * 3} ${w * 2}`;
  if (style === 'dotted') return `${w * 1} ${w * 2.5}`;
  return null;
}

/** Line cap/join. Round everything: whiteboard strokes look like ink, not CAD. */
export function applyStrokeCaps(ctx, style) {
  if (style === 'dotted') {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  } else {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }
}

/**
 * Word-wrap `text` to `maxWidth` in board units. Pure string work — no
 * measurement, so it gives IDENTICAL results in node and in the browser,
 * which is what lets the SVG export wrap text the same way the canvas did.
 * A real measurement pass is what would make the export differ from the
 * screen, so this uses an average-advance estimate per character.
 *
 * @param {string} text
 * @param {number} maxWidth board units
 * @param {number} fontSize
 * @returns {string[]}
 */
export function wrapText(text, maxWidth, fontSize) {
  const size = Math.max(1, fontSize || 16);
  if (!text) return [];
  // 0.52em average advance for a UI sans at normal weights; good enough that
  // the wrap point is within a word of what the real renderer picks.
  const charW = size * 0.52;
  const maxChars = Math.max(1, Math.floor(maxWidth / charW));

  const out = [];
  for (const para of String(text).split('\n')) {
    if (para === '') {
      out.push('');
      continue;
    }
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const cand = line + ' ' + words[i];
      if (cand.length <= maxChars) {
        line = cand;
      } else {
        out.push(line);
        line = words[i];
      }
    }
    out.push(line);
    // A single word longer than the line: hard-split it so it cannot overflow.
    for (let i = out.length - 1; i < out.length; i++) {
      if (out[i].length <= maxChars) break;
      const w = out[i];
      out[i] = w.slice(0, maxChars);
      out.splice(i + 1, 0, w.slice(maxChars));
      i++;
    }
  }
  return out;
}

/**
 * The lines a text element actually paints: explicit newlines plus wrapping.
 * Shared by the renderer, the hit-tester (which needs the same box) and the
 * exporter, so all three agree.
 */
export function textLines(el) {
  const fs = el.fontSize || 16;
  const w = Math.max(1, el.w || 0);
  return wrapText(el.text || '', w, fs);
}

/** Total height of a text element's wrapped lines. */
export function textHeight(el) {
  return textLines(el).length * (el.fontSize || 16) * LINE_HEIGHT;
}

/** X offset of the first glyph for an alignment. */
export function alignX(align, width) {
  if (align === 'center') return width / 2;
  if (align === 'right') return width;
  return 0;
}

/** ctx.textAlign value for an element alignment. */
export function textAlignFor(align) {
  return align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
}

/**
 * Quadratic midpoint smoothing of a polyline.
 *
 * The standard technique: for interior points, draw a quadratic Bézier whose
 * control point is the vertex and whose endpoints are the midpoints of the
 * adjacent segments. A raw `lineTo` chain through raw pointer samples looks
 * like a seismograph; this is most of what makes a pen tool feel good.
 * The first and last points are NOT smoothed — they are the ends of the
 * stroke and must stay exactly where the user put them.
 *
 * Emits canvas path commands through `sink` so the same function serves both
 * ctx and the SVG builder.
 *
 * @param {Point[]} pts
 * @param {{moveTo:(p:Point)=>void, lineTo:(p:Point)=>void, quadTo:(c:Point,p:Point)=>void}} sink
 */
export function emitSmoothedPath(pts, sink) {
  if (!pts || pts.length === 0) return;
  if (pts.length === 1) {
    sink.moveTo(pts[0]);
    return;
  }
  if (pts.length === 2) {
    sink.moveTo(pts[0]);
    sink.lineTo(pts[1]);
    return;
  }
  sink.moveTo(pts[0]);
  sink.lineTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const nx = (p.x + pts[i + 1].x) / 2;
    const ny = (p.y + pts[i + 1].y) / 2;
    sink.quadTo(p.x, p.y, nx, ny);
  }
  sink.lineTo(pts[pts.length - 1]);
}

/* ------------------------------------------------------------------ *
 * Rotation — the single place it happens
 * ------------------------------------------------------------------ */

/**
 * Run `fn` with the context transformed so it draws the element in its
 * UNROTATED frame: the context is translated to the box centre, rotated, and
 * translated back. Every type goes through here, so rotation is correct by
 * construction rather than by remembering to do it in ten places.
 *
 * The save/restore is inside this helper and the translate-back cancels the
 * forward translation exactly, so the caller's origin is restored bit-for-bit.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number,w:number,h:number,rotation?:number}} el
 * @param {() => void} fn
 */
export function withRotation(ctx, el, fn) {
  const r = el.rotation || 0;
  if (!r) {
    fn();
    return;
  }
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(r);
  ctx.translate(-cx, -cy);
  fn();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * The path builders, per type. Pure geometry -> path commands.
 * ------------------------------------------------------------------ */

/** Cylinder (database drum): a rect whose top AND bottom edges are half-ellipses. */
export function cylinderPath(ctx, box) {
  const { x, y, w, h } = box;
  // The cap eats into the vertical extent so the overall box stays tight.
  const cap = Math.min(h / 4, w / 2, 32);
  ctx.moveTo(x, y + cap);
  ctx.bezierCurveTo(x, y + cap * 0.28, x + w * 0.25, y, x + w / 2, y);
  ctx.bezierCurveTo(x + w * 0.75, y, x + w, y + cap * 0.28, x + w, y + cap);
  ctx.lineTo(x + w, y + h - cap);
  ctx.bezierCurveTo(x, y + h - cap, x, y + h - cap * 0.28, x + w / 2, y + h);
  ctx.bezierCurveTo(x + w * 0.75, y + h, x + w, y + h - cap * 0.28, x + w, y + h - cap);
  ctx.closePath();
  return cap;
}

/** Diamond: the 4 midpoints of the box edges. */
export function diamondPath(ctx, box) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  ctx.moveTo(cx, box.y);
  ctx.lineTo(box.x + box.w, cy);
  ctx.lineTo(cx, box.y + box.h);
  ctx.lineTo(box.x, cy);
  ctx.closePath();
}

/**
 * Arrowhead geometry. Scaled to the stroke width so a 1px arrow and a 12px
 * arrow do NOT get the same head — a fixed-size head is the tell of a
 * half-finished connector.
 * @returns {{tip:Point, left:Point, right:Point, size:number}}
 */
export function arrowhead(end, dirX, dirY, strokeWidth) {
  const len = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / len;
  const uy = dirY / len;
  // Long and narrow: ~4.5x the stroke width back, ~2.2x across.
  const size = Math.max(6, strokeWidth * 4.5);
  const halfWidth = size * 0.44;
  const back = { x: end.x - ux * size, y: end.y - uy * size };
  const px = -uy;
  const py = ux;
  return {
    tip: { x: end.x, y: end.y },
    left: { x: back.x + px * halfWidth, y: back.y + py * halfWidth },
    right: { x: back.x - px * halfWidth, y: back.y - py * halfWidth },
    size,
  };
}

/* ------------------------------------------------------------------ *
 * Per-type painters. Each assumes the rotation transform is already applied.
 * ------------------------------------------------------------------ */

function strokeOf(el) {
  return el.stroke || '#1f2937';
}

function widthOf(el) {
  return el.strokeWidth === undefined ? DEFAULT_STROKE_WIDTH : el.strokeWidth;
}

function drawRectLike(ctx, el) {
  const w = widthOf(el);
  if (hasFill(el.fill)) {
    ctx.fillStyle = el.fill;
    ctx.fillRect(el.x, el.y, el.w, el.h);
  }
  if (el.stroke && w > 0) {
    ctx.strokeStyle = strokeOf(el);
    ctx.lineWidth = w;
    applyDash(ctx, el.strokeStyle, w);
    applyStrokeCaps(ctx, el.strokeStyle);
    ctx.strokeRect(el.x, el.y, el.w, el.h);
  }
}

function drawEllipse(ctx, el) {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const rx = Math.max(0, el.w / 2);
  const ry = Math.max(0, el.h / 2);
  const w = widthOf(el);
  if (hasFill(el.fill)) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = el.fill;
    ctx.fill();
  }
  if (el.stroke && w > 0) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = strokeOf(el);
    ctx.lineWidth = w;
    applyDash(ctx, el.strokeStyle, w);
    applyStrokeCaps(ctx, el.strokeStyle);
    ctx.stroke();
  }
}

function drawDiamond(ctx, el) {
  const w = widthOf(el);
  ctx.beginPath();
  diamondPath(ctx, el);
  if (hasFill(el.fill)) {
    ctx.fillStyle = el.fill;
    ctx.fill();
  }
  if (el.stroke && w > 0) {
    ctx.strokeStyle = strokeOf(el);
    ctx.lineWidth = w;
    applyDash(ctx, el.strokeStyle, w);
    applyStrokeCaps(ctx, el.strokeStyle);
    ctx.stroke();
  }
}

function drawCylinder(ctx, el) {
  const w = widthOf(el);
  ctx.beginPath();
  cylinderPath(ctx, el);
  if (hasFill(el.fill)) {
    ctx.fillStyle = el.fill;
    ctx.fill();
  }
  if (el.stroke && w > 0) {
    ctx.strokeStyle = strokeOf(el);
    ctx.lineWidth = w;
    applyDash(ctx, el.strokeStyle, w);
    applyStrokeCaps(ctx, el.strokeStyle);
    ctx.stroke();
  }
}

function drawSticky(ctx, el) {
  const fill = hasFill(el.fill) ? el.fill : '#fde68a';
  const r = Math.min(6, el.w / 8, el.h / 8);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(el.x, el.y, el.w, el.h, r);
  } else {
    ctx.rect(el.x, el.y, el.w, el.h);
  }
  ctx.fillStyle = fill;
  ctx.fill();
  const w = widthOf(el);
  if (el.stroke && w > 0) {
    ctx.strokeStyle = strokeOf(el);
    ctx.lineWidth = w;
    applyDash(ctx, el.strokeStyle, w);
    applyStrokeCaps(ctx, el.strokeStyle);
    ctx.stroke();
  }
  // Label centred, coloured for CONTRAST against the fill. White on a yellow
  // note is unreadable, and readableTextOn is the whole fix.
  const label = el.label || '';
  if (label && el.h > 6) {
    const fs = Math.max(9, Math.min(18, (el.h / Math.max(2, label.split('\n').length)) * 0.8));
    ctx.fillStyle = readableTextOn(fill);
    ctx.font = `500 ${fs}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = label.split('\n');
    const lh = fs * LINE_HEIGHT;
    const startY = el.y + el.h / 2 - ((lines.length - 1) * lh) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], el.x + el.w / 2, startY + i * lh);
    }
  }
}

/**
 * The colour a text element paints in.
 *
 * Text has no outline, so its colour lives in `fill` — that is the convention
 * the presets use (`fill: style.stroke, stroke: 'none'`) and it is what keeps
 * a text element's "paint" slot meaning the same thing as every other type's.
 * `stroke` is the fallback for elements created before that convention, and
 * for anyone who hand-writes a text element.
 */
export function textColorOf(el) {
  if (hasFill(el.fill)) return el.fill;
  if (typeof el.stroke === 'string' && el.stroke !== '' && el.stroke !== 'none') return el.stroke;
  return '#1f2937';
}

function drawText(ctx, el) {
  const fs = el.fontSize || 16;
  const lines = textLines(el);
  if (!lines.length) return;
  ctx.fillStyle = textColorOf(el);
  ctx.font = `400 ${fs}px ${FONT_STACK}`;
  ctx.textAlign = textAlignFor(el.align);
  ctx.textBaseline = 'top';
  const lh = fs * LINE_HEIGHT;
  const x = el.x + alignX(el.align, el.w);
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x, el.y + i * lh);
  }
}

function drawPen(ctx, el) {
  const w = widthOf(el);
  const pts = el.points || [];
  if (!pts.length) return;
  ctx.beginPath();
  emitSmoothedPath(pts, {
    moveTo: (a, b) => (b === undefined ? ctx.moveTo(a.x, a.y) : ctx.moveTo(a, b)),
    lineTo: (a, b) => (b === undefined ? ctx.lineTo(a.x, a.y) : ctx.lineTo(a, b)),
    quadTo: (a, b, c, d) => ctx.quadraticCurveTo(a, b, c, d),
  });
  ctx.strokeStyle = strokeOf(el);
  ctx.lineWidth = w;
  applyDash(ctx, el.strokeStyle, w);
  applyStrokeCaps(ctx, el.strokeStyle);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawLine(ctx, el) {
  const w = widthOf(el);
  const pts = el.points || [];
  if (pts.length < 2) return;
  const a = pts[0];
  const b = pts[1];
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = strokeOf(el);
  ctx.lineWidth = w;
  applyDash(ctx, el.strokeStyle, w);
  applyStrokeCaps(ctx, el.strokeStyle);
  ctx.stroke();
}

function drawArrow(ctx, el) {
  const w = widthOf(el);
  const pts = el.points || [];
  if (pts.length < 2) return;
  const a = pts[0];
  const b = pts[1];
  const head = arrowhead(b, b.x - a.x, b.y - a.y, w);
  // The shaft stops short of the tip by half the head, so the head covers
  // the joint instead of a line poking through it.
  const backLen = head.size * 0.5;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const shaftEnd = { x: b.x - ux * backLen, y: b.y - uy * backLen };

  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(shaftEnd.x, shaftEnd.y);
  ctx.strokeStyle = strokeOf(el);
  ctx.lineWidth = w;
  applyDash(ctx, el.strokeStyle, w);
  applyStrokeCaps(ctx, el.strokeStyle);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(head.tip.x, head.tip.y);
  ctx.lineTo(head.left.x, head.left.y);
  ctx.lineTo(head.right.x, head.right.y);
  ctx.closePath();
  ctx.fillStyle = strokeOf(el);
  ctx.strokeStyle = strokeOf(el);
  ctx.lineWidth = w * 0.6;
  ctx.fill();
  ctx.stroke();
}

function drawImage(ctx, el) {
  const w = widthOf(el);
  if (el.stroke && w > 0) {
    ctx.strokeStyle = strokeOf(el);
    ctx.lineWidth = w;
    applyDash(ctx, el.strokeStyle, w);
    applyStrokeCaps(ctx, el.strokeStyle);
    ctx.strokeRect(el.x, el.y, el.w, el.h);
  }
  if (!el.src) return;
  const entry = getImage(el.src);
  if (entry.state === 'ready' && entry.img) {
    try {
      ctx.drawImage(entry.img, el.x, el.y, el.w, el.h);
      return;
    } catch {
      // A tainted or aborted image throws on drawImage. Fall through to the
      // placeholder rather than taking the whole frame down.
    }
  }
  // Placeholder: a neutral box with a diagonal cross. Drawn for BOTH 'loading'
  // and 'error' — an element must never be invisible just because a fetch
  // failed.
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  ctx.save();
  ctx.globalAlpha = entry.state === 'loading' ? 0.5 : 0.85;
  ctx.fillStyle = entry.state === 'loading' ? '#e5e7eb' : '#f3f4f6';
  ctx.fillRect(el.x, el.y, el.w, el.h);
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(el.x, el.y);
  ctx.lineTo(el.x + el.w, el.y + el.h);
  ctx.moveTo(el.x + el.w, el.y);
  ctx.lineTo(el.x, el.y + el.h);
  ctx.stroke();
  ctx.strokeRect(el.x, el.y, el.w, el.h);
  ctx.restore();
  void cx;
  void cy;
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

const PAINTERS = {
  rect: drawRectLike,
  ellipse: drawEllipse,
  diamond: drawDiamond,
  cylinder: drawCylinder,
  sticky: drawSticky,
  text: drawText,
  pen: drawPen,
  line: drawLine,
  arrow: drawArrow,
  image: drawImage,
};

/**
 * Draw one element. Pure: `(ctx, el, view)` and nothing else. `view` is
 * accepted for signature compatibility with callers that pass the whole
 * scene, but this function works in board units — the caller is responsible
 * for having applied the view transform.
 *
 * Every element is bracketed in ONE save/restore here, so no painter can leak
 * state into the next element even if it forgets its own.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} el
 * @param {{zoom?:number, panX?:number, panY?:number}} [view]
 * @param {{skipText?:boolean}} [opts] `skipText` renders shape-only, used by
 *   the export for elements whose text is emitted as a separate SVG node.
 */
export function drawElement(ctx, el, view, opts = {}) {
  if (!el || !el.type) return;
  const painter = PAINTERS[el.type];
  if (!painter) return;

  ctx.save();
  const prevAlpha = ctx.globalAlpha;
  if (el.opacity !== undefined && el.opacity < 1) {
    ctx.globalAlpha = prevAlpha * Math.max(0, Math.min(1, el.opacity));
  }
  withRotation(ctx, el, () => painter(ctx, el));
  ctx.globalAlpha = prevAlpha;
  ctx.restore();
}

/** The `view` argument is optional in practice; keep the signature honest. */
export function drawElementAt(ctx, el, view) {
  return drawElement(ctx, el, view);
}

export { PAINTERS as ELEMENT_PAINTERS };
