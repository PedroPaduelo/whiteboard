/**
 * export.js — SVG, PNG and JSON out of the editor; JSON back in.
 *
 * The exports draw with the SAME shapes as the screen: SVG turns the cached
 * roughjs Drawables of render/shape.js into <path>s with `generator.toPaths`
 * (pure JS, runs in node), and PNG replays `drawElement` onto an offscreen
 * canvas. Same seed, same wobble, same text layout — an export is what you
 * see, not a re-interpretation of it.
 *
 * Dark mode is the editor's CSS filter (invert 93% + hue-rotate 180°) applied
 * to the drawing: an SVG <feColorMatrix> with the identical matrix, or the
 * same matrix over the PNG pixels. So a dark export matches the dark screen,
 * sticky text included. Raster images are left out of it, as on screen: a
 * photo keeps its colours instead of turning into a negative. (The matrix is
 * affine per pixel, so darkening the runs of elements between two images
 * separately composes to the same picture as darkening it all at once.)
 *
 * JSON: `serializeBoard` writes version 2 ({type:'whiteboard', version: 2}),
 * `parseBoardFile` reads version 2 and the legacy version 1
 * ({version: 1, kind: 'whiteboard.elements'}) and validates every element
 * with the same validator the server uses. All or nothing: a file with one
 * bad element is rejected, naming it.
 */

import { tryValidateElement, LIMITS } from '@whiteboard/shared';
import { CANVAS_BACKGROUND, FONT_FAMILIES } from '../constants.js';
import { elementBounds } from '../handles.js';
import { layoutText, textColorOf } from '../text.js';
import { FONT_FACES, fontDataUrl, loadFonts } from '../fonts.js';
import {
  generator,
  getShape,
  isPaint,
  baselineOffset,
  FONT_METRICS,
  DARK_MATRIX,
  arrowheadBaseSize,
} from '../render/shape.js';
import { drawElement, textPaintBounds, STICKY_DEFAULT_FILL, STICKY_RADIUS } from '../render/renderElement.js';

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Same colour grammar as the shared validator; anything else is replaced. */
const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|[a-zA-Z]{3,20})$/;
/** Same image-src grammar as the shared validator. */
const SAFE_IMAGE_SRC = /^(data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+|https:\/\/[^\s]+)$/;

/**
 * Characters XML 1.0 does not allow anywhere, not even escaped: C0 controls
 * other than tab/newline/CR, U+FFFE/U+FFFF, and unpaired surrogates. One of
 * them in a text line (Word's soft line break is U+000B, PDFs carry form
 * feeds) made the whole SVG unparseable. Form feed paints as a space on the
 * canvas, so it becomes one; a lone surrogate becomes U+FFFD, like a UTF-8
 * encoder would; the rest paint nothing and are dropped.
 */
// Surrogate PAIRS are matched first (and kept) so that only lone halves hit
// the last alternative; no lookbehind, which older Safari cannot parse.
const XML_FORBIDDEN = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDFFF]/g;

/** A string made safe for XML text and attribute values. */
export function xmlText(s) {
  return String(s).replace(XML_FORBIDDEN, (c) => {
    if (c.length === 2) return c; // a valid surrogate pair
    if (c === '\f') return ' ';
    return c >= '\uD800' && c <= '\uDFFF' ? '\uFFFD' : '';
  });
}

function esc(s) {
  return xmlText(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function color(c, fallback = '#1e1e1e') {
  return typeof c === 'string' && SAFE_COLOR.test(c) ? c : fallback;
}

/** Round to 2 decimals for compact, stable output. */
function n2(v) {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Shorten every number in a path string to 2 decimals. */
function compactPath(d) {
  return d.replace(/-?\d+\.\d{3,}(e-?\d+)?/g, (m) => n2(Number(m)));
}

const POLY = new Set(['pen', 'arrow', 'line']);

/**
 * How far an element paints beyond its geometric bounds (stroke, wobble,
 * arrowheads, shadow), board units. Keeps exports from clipping edges.
 */
function exportMargin(el) {
  const sw = typeof el.strokeWidth === 'number' ? el.strokeWidth : 2;
  const rough = typeof el.roughness === 'number' ? el.roughness : 1;
  switch (el.type) {
    case 'arrow':
    case 'line': {
      const heads = [el.startArrowhead, el.endArrowhead ?? (el.type === 'arrow' ? 'arrow' : 'none')];
      const hasHead = heads.some((h) => h && h !== 'none');
      return Math.max(sw / 2 + 2 + rough, hasHead ? arrowheadBaseSize(sw) * 0.5 + sw : 0);
    }
    case 'pen':
      return Math.max(4, sw * 4.25) / 2 + 1;
    case 'sticky':
      return 18;
    case 'text':
      return 2;
    case 'image':
      return 0;
    default:
      return sw / 2 + 2 + rough * 2;
  }
}

/**
 * Bounds of what an export must show, board units (without padding), or
 * null for an empty list: each element's geometric bounds plus its paint
 * margin, united with the text it paints — a label or a note's text that
 * runs past its box is part of the picture too.
 */
export function exportBounds(elements) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements || []) {
    if (!el) continue;
    const b = elementBounds(el);
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.w) || !Number.isFinite(b.h)) continue;
    const m = exportMargin(el);
    minX = Math.min(minX, b.x - m);
    minY = Math.min(minY, b.y - m);
    maxX = Math.max(maxX, b.x + b.w + m);
    maxY = Math.max(maxY, b.y + b.h + m);
    const t = textPaintBounds(el);
    if (t) {
      minX = Math.min(minX, t.x);
      minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + t.w);
      maxY = Math.max(maxY, t.y + t.h);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function frameOf(elements, padding) {
  const b = exportBounds(elements) ?? { x: 0, y: 0, w: 0, h: 0 };
  const pad = Math.max(0, Number.isFinite(padding) ? padding : 10);
  return { x: b.x - pad, y: b.y - pad, w: Math.max(1, b.w + pad * 2), h: Math.max(1, b.h + pad * 2) };
}

/* ------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------ */

const ANCHOR = { left: 'start', center: 'middle', right: 'end' };

function textSvg(layout, fill, used) {
  if (!layout) return '';
  const m = FONT_METRICS[layout.fontFamily] ?? FONT_METRICS.hand;
  const fs = layout.fontSize;
  const offset = baselineOffset(layout.lineHeight, { ascent: m.ascent * fs, descent: m.descent * fs });
  const family = FONT_FAMILIES[layout.fontFamily] ?? FONT_FAMILIES.hand;
  used.add(layout.fontFamily);
  let out = '';
  for (const line of layout.lines) {
    if (!line.text) continue;
    out +=
      `<text x="${n2(line.x)}" y="${n2(line.y + offset)}" font-family="${esc(family)}" font-size="${n2(fs)}" ` +
      `fill="${esc(fill)}" text-anchor="${ANCHOR[layout.textAlign] ?? 'start'}" xml:space="preserve" ` +
      `style="white-space: pre">${esc(line.text)}</text>`;
  }
  return out;
}

/** <path>s for one roughjs Drawable, via generator.toPaths. */
function drawableSvg(drawable) {
  const paths = generator.toPaths(drawable);
  const o = drawable.options;
  const shape = drawable.shape;
  let out = '';
  // toPaths emits one entry per op set, in order, for the three set types.
  const sets = drawable.sets.filter((s) => s.type === 'path' || s.type === 'fillPath' || s.type === 'fillSketch');
  paths.forEach((p, i) => {
    const kind = sets[i]?.type;
    const d = compactPath(p.d);
    if (!d) return;
    if (kind === 'fillPath') {
      const rule = shape === 'curve' || shape === 'polygon' || shape === 'path' ? ' fill-rule="evenodd"' : '';
      out += `<path d="${d}" fill="${esc(color(p.fill))}" stroke="none"${rule}/>`;
    } else if (kind === 'fillSketch') {
      const dash = o.fillLineDash ? ` stroke-dasharray="${o.fillLineDash.map(n2).join(' ')}"` : '';
      out += `<path d="${d}" fill="none" stroke="${esc(color(p.stroke))}" stroke-width="${n2(p.strokeWidth)}"${dash} stroke-linecap="round" stroke-linejoin="round"/>`;
    } else {
      if (p.stroke === 'none') return;
      const dash = o.strokeLineDash ? ` stroke-dasharray="${o.strokeLineDash.map(n2).join(' ')}"` : '';
      out += `<path d="${d}" fill="none" stroke="${esc(color(p.stroke))}" stroke-width="${n2(p.strokeWidth)}"${dash} stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  });
  return out;
}

function roundedRectD(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return (
    `M ${n2(x + rr)} ${n2(y)} L ${n2(x + w - rr)} ${n2(y)} Q ${n2(x + w)} ${n2(y)} ${n2(x + w)} ${n2(y + rr)} ` +
    `L ${n2(x + w)} ${n2(y + h - rr)} Q ${n2(x + w)} ${n2(y + h)} ${n2(x + w - rr)} ${n2(y + h)} ` +
    `L ${n2(x + rr)} ${n2(y + h)} Q ${n2(x)} ${n2(y + h)} ${n2(x)} ${n2(y + h - rr)} ` +
    `L ${n2(x)} ${n2(y + rr)} Q ${n2(x)} ${n2(y)} ${n2(x + rr)} ${n2(y)} Z`
  );
}

/** Inner SVG of one element (no wrapping group). */
function elementBodySvg(el, ctx) {
  switch (el.type) {
    case 'rect':
    case 'ellipse':
    case 'diamond':
    case 'cylinder':
    case 'arrow':
    case 'line': {
      const desc = getShape(el);
      let out = '';
      if (desc.kind === 'rough' && desc.drawables.length) {
        out += `<g transform="translate(${n2(desc.origin.x)} ${n2(desc.origin.y)})">`;
        for (const d of desc.drawables) out += drawableSvg(d);
        out += '</g>';
      }
      if (el.type !== 'arrow' && el.type !== 'line') out += textSvg(layoutText(el), color(textColorOf(el)), ctx.used);
      return out;
    }
    case 'pen': {
      const desc = getShape(el);
      if (!desc.path || !desc.fill) return '';
      return `<path transform="translate(${n2(desc.origin.x)} ${n2(desc.origin.y)})" d="${desc.path}" fill="${esc(color(desc.fill))}" stroke="none"/>`;
    }
    case 'sticky': {
      ctx.shadow = true;
      const fill = color(isPaint(el.fill) ? el.fill : STICKY_DEFAULT_FILL, STICKY_DEFAULT_FILL);
      const d = roundedRectD(el.x, el.y, el.w, el.h, STICKY_RADIUS);
      return (
        `<path d="${d}" fill="${esc(fill)}" filter="url(#wb-shadow)"/>` +
        `<path d="${d}" fill="none" stroke="rgba(0,0,0,0.06)" stroke-width="1"/>` +
        textSvg(layoutText(el), color(textColorOf(el)), ctx.used)
      );
    }
    case 'text':
      return textSvg(layoutText(el), color(textColorOf(el)), ctx.used);
    case 'image': {
      if (!(el.w > 0 && el.h > 0)) return '';
      if (typeof el.src !== 'string' || !SAFE_IMAGE_SRC.test(el.src)) {
        return `<rect x="${n2(el.x)}" y="${n2(el.y)}" width="${n2(el.w)}" height="${n2(el.h)}" fill="#f1f3f5" stroke="#dee2e6"/>`;
      }
      const href = esc(el.src);
      return `<image x="${n2(el.x)}" y="${n2(el.y)}" width="${n2(el.w)}" height="${n2(el.h)}" preserveAspectRatio="none" href="${href}" xlink:href="${href}"/>`;
    }
    default:
      return '';
  }
}

/** One <g> per element, carrying its id, rotation and opacity. */
function elementSvg(el, ctx) {
  const attrs = [`data-id="${esc(el.id ?? '')}"`, `data-type="${esc(el.type ?? '')}"`];
  if (!POLY.has(el.type) && el.rotation) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    attrs.push(`transform="rotate(${n2((el.rotation * 180) / Math.PI)} ${n2(cx)} ${n2(cy)})"`);
  }
  const opacity = typeof el.opacity === 'number' ? Math.min(1, Math.max(0, el.opacity)) : 1;
  if (opacity < 1) attrs.push(`opacity="${n2(opacity)}"`);
  return `<g ${attrs.join(' ')}>${opacity > 0 ? elementBodySvg(el, ctx) : ''}</g>`;
}

function darkFilterSvg(f) {
  const { m, offset } = DARK_MATRIX;
  const row = (r) => `${r.map((v) => v.toFixed(4)).join(' ')} 0 ${offset}`;
  const values = `${row(m[0])} ${row(m[1])} ${row(m[2])} 0 0 0 1 0`;
  // The filter region is the whole export frame: the default (the content's
  // geometric bbox + 10%) could clip strokes and shadows at the edges.
  return (
    `<filter id="wb-dark" filterUnits="userSpaceOnUse" x="${n2(f.x)}" y="${n2(f.y)}" width="${n2(f.w)}" height="${n2(f.h)}" color-interpolation-filters="sRGB">` +
    `<feColorMatrix type="matrix" values="${values}"/></filter>`
  );
}

const SHADOW_FILTER =
  `<filter id="wb-shadow" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB">` +
  `<feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000000" flood-opacity="0.16"/></filter>`;

function fontFaceCss(usedKeys, override) {
  let css = '';
  let missing = false;
  for (const face of FONT_FACES) {
    if (!usedKeys.has(face.key)) continue;
    const url = override?.[face.family] ?? fontDataUrl(face.family);
    if (!url) {
      missing = true; // node / not loaded yet: the family name falls back
      continue;
    }
    css += `@font-face{font-family:"${face.family}";src:url(${url}) format("woff2");font-display:swap;}`;
  }
  // In a browser where nobody called loadFonts yet, start it so the next
  // export can embed the fonts (exportToSvg itself is synchronous).
  if (missing && typeof document !== 'undefined') loadFonts();
  return css;
}

/**
 * Standalone SVG of `elements`.
 *
 * @param {object[]} elements  z-ordered
 * @param {{background?:boolean, dark?:boolean, padding?:number, scale?:number,
 *          fonts?:Record<string,string>}} [opts]
 *   `fonts`: optional family -> data URL overrides (otherwise the faces loaded
 *   by fonts.js are embedded; in node none are, and the family name is used).
 * @returns {string}
 */
export function exportToSvg(elements, opts = {}) {
  const { background = true, dark = false, padding = 10, scale = 1, fonts } = opts;
  const list = (elements || []).filter((el) => el && typeof el === 'object');
  const f = frameOf(list, padding);
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const ctx = { used: new Set(), shadow: false };
  const body = list.map((el) => elementSvg(el, ctx));
  const css = fontFaceCss(ctx.used, fonts);
  let defs = '';
  if (css) defs += `<style>${css}</style>`;
  if (ctx.shadow) defs += SHADOW_FILTER;
  if (dark) defs += darkFilterSvg(f);
  const bg = background
    ? `<rect data-role="background" x="${n2(f.x)}" y="${n2(f.y)}" width="${n2(f.w)}" height="${n2(f.h)}" fill="${CANVAS_BACKGROUND}"/>`
    : '';
  let content = `${bg}${body.join('')}`;
  if (dark) {
    // Every run of drawing between images goes through the dark filter; the
    // images themselves do not (see the header).
    content = '';
    let run = bg;
    const flush = () => {
      if (run) content += `<g filter="url(#wb-dark)">${run}</g>`;
      run = '';
    };
    list.forEach((el, i) => {
      if (el.type === 'image') {
        flush();
        content += body[i];
      } else run += body[i];
    });
    flush();
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" ` +
    `viewBox="${n2(f.x)} ${n2(f.y)} ${n2(f.w)} ${n2(f.h)}" width="${n2(f.w * s)}" height="${n2(f.h * s)}">` +
    `<!-- svg-source:whiteboard -->` +
    (defs ? `<defs>${defs}</defs>` : '') +
    content +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

/** Browser canvas limits; larger exports are scaled down (and retried at a
 *  smaller scale if the browser still refuses, e.g. iOS Safari's ~16 Mpx). */
const MAX_SIDE = 16384;
const MAX_AREA = 64 * 1024 * 1024;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Error('exportToPngBlob needs a browser (no canvas available)');
}

function canvasToBlob(canvas) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

/**
 * Decode every image the export needs. Remote images are loaded with CORS so
 * they do not taint the canvas; one that fails maps to null (drawn as the
 * placeholder) instead of falling back to the on-screen, possibly tainting,
 * copy.
 */
async function preloadImages(elements) {
  const cache = new Map();
  const srcs = new Set(elements.filter((el) => el.type === 'image' && typeof el.src === 'string').map((el) => el.src));
  await Promise.all(
    [...srcs].map(async (src) => {
      if (typeof Image === 'undefined' || !SAFE_IMAGE_SRC.test(src)) {
        cache.set(src, null);
        return;
      }
      const img = new Image();
      if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
      try {
        img.src = src;
        await img.decode();
        cache.set(src, img);
      } catch {
        cache.set(src, null);
      }
    }),
  );
  return cache;
}

/** Apply the dark-mode matrix to RGBA pixel data in place. */
export function applyDarkToPixels(data) {
  const { m, offset } = DARK_MATRIX;
  const o = offset * 255;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    data[i] = m[0][0] * r + m[0][1] * g + m[0][2] * b + o;
    data[i + 1] = m[1][0] * r + m[1][1] * g + m[1][2] * b + o;
    data[i + 2] = m[2][0] * r + m[2][1] * g + m[2][2] * b + o;
  }
  return data;
}

const pngScaleOf = (scale) => (Number.isFinite(scale) && scale > 0 ? scale : 2);

/** The requested scale, reduced until the frame fits the canvas limits. */
function clampPngScale(f, requested) {
  return Math.min(requested, MAX_SIDE / f.w, MAX_SIDE / f.h, Math.sqrt(MAX_AREA / (f.w * f.h)));
}

/**
 * The pixel size a PNG export of `elements` will have, with the same frame
 * and the same limits exportToPngBlob applies: a board too big for a canvas
 * at the requested scale is exported smaller, and `reduced` says so (the
 * dialog must show the real size, not the requested one).
 * @param {object[]} elements
 * @param {{padding?:number, scale?:number}} [opts]
 * @returns {{width:number, height:number, scale:number, requestedScale:number, reduced:boolean}}
 */
export function pngExportSize(elements, { padding = 10, scale = 2 } = {}) {
  const list = (elements || []).filter((el) => el && typeof el === 'object');
  const f = frameOf(list, padding);
  const requestedScale = pngScaleOf(scale);
  const s = clampPngScale(f, requestedScale);
  return {
    width: Math.max(1, Math.ceil(f.w * s)),
    height: Math.max(1, Math.ceil(f.h * s)),
    scale: s,
    requestedScale,
    reduced: s < requestedScale,
  };
}

/**
 * PNG of `elements`, drawn with the on-screen renderer on an offscreen canvas.
 * A board too big for a browser canvas at `scale` is drawn at the largest
 * scale that fits (pngExportSize predicts it), and at half that again if the
 * browser still refuses; `onScale` hears the size actually produced.
 * @param {object[]} elements
 * @param {{background?:boolean, dark?:boolean, padding?:number, scale?:number,
 *          onScale?:(info:{width:number, height:number, scale:number,
 *                          requestedScale:number, reduced:boolean}) => void}} [opts]
 * @returns {Promise<Blob>}
 */
export async function exportToPngBlob(elements, opts = {}) {
  const { background = true, dark = false, padding = 10, scale = 2, onScale } = opts;
  const list = (elements || []).filter((el) => el && typeof el === 'object');
  await loadFonts();
  const f = frameOf(list, padding);
  const imageCache = await preloadImages(list);
  const requestedScale = pngScaleOf(scale);
  let s = clampPngScale(f, requestedScale);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++, s /= 2) {
    try {
      const blob = await renderPng(list, f, s, { background, dark, imageCache });
      if (blob) {
        if (typeof onScale === 'function') {
          const info = {
            width: Math.max(1, Math.ceil(f.w * s)),
            height: Math.max(1, Math.ceil(f.h * s)),
            scale: s,
            requestedScale,
            reduced: s < requestedScale,
          };
          try {
            onScale(info);
          } catch (err) {
            console.error('[export] onScale callback failed', err);
          }
        }
        return blob;
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('PNG export failed');
}

async function renderPng(list, f, s, { background, dark, imageCache }) {
  const W = Math.max(1, Math.ceil(f.w * s));
  const H = Math.max(1, Math.ceil(f.h * s));
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const board = (c) => c.setTransform(s, 0, 0, s, -f.x * s, -f.y * s);
  const darken = (c) => {
    c.setTransform(1, 0, 0, 1, 0, 0);
    const img = c.getImageData(0, 0, W, H);
    applyDarkToPixels(img.data);
    c.putImageData(img, 0, 0);
  };

  if (!dark || !list.some((el) => el.type === 'image')) {
    if (background) {
      ctx.fillStyle = CANVAS_BACKGROUND;
      ctx.fillRect(0, 0, W, H);
    }
    board(ctx);
    for (const el of list) drawElement(ctx, el, { zoom: s, imageCache });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (dark) darken(ctx);
    return canvasToBlob(canvas);
  }

  // Dark with images: each run of drawing between two images is painted on
  // a scratch layer, darkened there and composited; images go straight onto
  // the picture, so they keep their colours.
  const layer = makeCanvas(W, H);
  const lctx = layer.getContext('2d');
  if (!lctx) return null;
  let pendingBackground = background;
  let run = [];
  const flush = () => {
    if (!run.length && !pendingBackground) return;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, W, H);
    if (pendingBackground) {
      lctx.fillStyle = CANVAS_BACKGROUND;
      lctx.fillRect(0, 0, W, H);
      pendingBackground = false;
    }
    board(lctx);
    for (const el of run) drawElement(lctx, el, { zoom: s, imageCache });
    darken(lctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
    run = [];
  };
  for (const el of list) {
    if (el.type !== 'image') {
      run.push(el);
      continue;
    }
    flush();
    board(ctx);
    drawElement(ctx, el, { zoom: s, imageCache });
  }
  flush();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvasToBlob(canvas);
}

/* ------------------------------------------------------------------ *
 * JSON
 * ------------------------------------------------------------------ */

/** Current file format version written by serializeBoard. */
export const BOARD_FILE_VERSION = 2;
/** `type` of a version-2 file. */
export const BOARD_FILE_TYPE = 'whiteboard';

function sourceOrigin() {
  try {
    if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') return location.origin;
  } catch {
    /* no location */
  }
  return 'whiteboard';
}

function cleanElement(el) {
  const out = {};
  for (const [k, v] of Object.entries(el)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * The board as a JSON file (version 2).
 * @param {object[]} elements
 * @param {{board?: {id?:string, title?:string, theme?:string}}} [opts]
 * @returns {string}
 */
export function serializeBoard(elements, { board } = {}) {
  const meta = board && typeof board === 'object' ? {} : null;
  if (meta) {
    for (const k of ['id', 'title', 'theme']) if (board[k] !== undefined) meta[k] = board[k];
  }
  return JSON.stringify(
    {
      type: BOARD_FILE_TYPE,
      version: BOARD_FILE_VERSION,
      source: sourceOrigin(),
      board: meta,
      elements: (elements || []).filter(Boolean).map(cleanElement),
    },
    null,
    2,
  );
}

const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

/**
 * A validator failure in words for the person opening the file. The shared
 * validator speaks English to developers ("element.x: expected a finite
 * number"); the toast must be Portuguese, so only the field it names is kept
 * (the original goes along as `detail`, for the console).
 */
function describeInvalid(res, raw) {
  const field = String(res.path || '').replace(/^element\.?/, '');
  if (field === 'type') {
    const type = raw && typeof raw === 'object' ? raw.type : undefined;
    return typeof type === 'string' && type ? `tipo de elemento desconhecido (“${type.slice(0, 40)}”).` : 'falta o tipo do elemento.';
  }
  if (field === 'id') return 'id ausente ou inválido.';
  if (!field) return raw && typeof raw === 'object' && !Array.isArray(raw) ? 'falta o id.' : 'não é um elemento.';
  return `valor inválido em “${field}”.`;
}

/**
 * Read a board file. Accepts version 2 ({type:'whiteboard', version:2}),
 * the legacy version 1 ({version:1, kind:'whiteboard.elements'}) and a bare
 * element array. Every element is validated with the shared validator; ids
 * are kept as they are (a duplicate id rejects the file).
 *
 * @param {string|object} text
 * @returns {{ok:true, elements:object[], board:object|null, version:number} |
 *           {ok:false, error:string, code:string, index?:number, detail?:string}}
 *   `error` is Portuguese, for the person; `detail`, when present, is the
 *   parser's or validator's own (English) message, for developers.
 */
export function parseBoardFile(text) {
  let data = text;
  if (typeof text === 'string') {
    try {
      data = JSON.parse(text);
    } catch (e) {
      // The engine's own message is English (and engine-specific): kept for
      // the console only.
      return fail('json', 'Arquivo inválido: não é um JSON.', { detail: e?.message });
    }
  }
  if (!data || typeof data !== 'object') return fail('format', 'Arquivo inválido: não é um quadro.');

  let list;
  let board = null;
  let version;
  if (Array.isArray(data)) {
    list = data;
    version = 1;
  } else {
    const isV2 = data.type === BOARD_FILE_TYPE && data.version === 2;
    const isV1 = data.version === 1 && (data.kind === 'whiteboard.elements' || data.kind === undefined) && data.type === undefined;
    if (!isV1 && !isV2) {
      if (data.type === BOARD_FILE_TYPE || (data.kind === 'whiteboard.elements' && data.version !== undefined)) {
        return fail('version', `Versão de arquivo não suportada (${String(data.version)}).`);
      }
      return fail('format', 'Arquivo inválido: não é um quadro deste aplicativo.');
    }
    version = data.version;
    list = data.elements;
    board = data.board && typeof data.board === 'object' && !Array.isArray(data.board) ? data.board : null;
  }
  if (!Array.isArray(list)) return fail('format', 'Arquivo inválido: lista de elementos ausente.');
  if (list.length > LIMITS.MAX_ELS) {
    return fail('too-many', `Arquivo com elementos demais (máximo ${LIMITS.MAX_ELS}).`);
  }
  const elements = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const res = tryValidateElement(list[i]);
    if (!res.valid) {
      return fail('element', `Elemento ${i} inválido: ${describeInvalid(res, list[i])}`, { index: i, detail: res.error });
    }
    if (seen.has(res.element.id)) {
      return fail('element', `Elemento ${i} inválido: id repetido (${res.element.id}).`, { index: i });
    }
    seen.add(res.element.id);
    elements.push(res.element);
  }
  return { ok: true, elements, board, version };
}

/* ------------------------------------------------------------------ *
 * Browser plumbing
 * ------------------------------------------------------------------ */

const MIME_BY_EXT = { json: 'application/json', svg: 'image/svg+xml', png: 'image/png', txt: 'text/plain' };

/**
 * Save a Blob or string as a file download.
 * @param {Blob|string} blobOrString
 * @param {string} filename
 * @param {string} [mime]  for strings; inferred from the extension otherwise
 */
export function downloadBlob(blobOrString, filename, mime) {
  const ext = String(filename || '').split('.').pop()?.toLowerCase();
  const type = mime || MIME_BY_EXT[ext] || 'application/octet-stream';
  const blob =
    typeof Blob !== 'undefined' && blobOrString instanceof Blob
      ? blobOrString
      : new Blob([blobOrString], { type: type.startsWith('text/') || type.includes('json') || type.includes('svg') ? `${type};charset=utf-8` : type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** True when this browser can put an image on the clipboard. */
export function canCopyImageToClipboard() {
  return typeof navigator !== 'undefined' && !!navigator.clipboard?.write && typeof ClipboardItem !== 'undefined';
}

/**
 * Put a PNG on the system clipboard. Accepts a Blob or a Promise<Blob>
 * (Safari needs the promise form to keep the user gesture while rendering).
 * @param {Blob|Promise<Blob>} blob
 * @throws {Error} when the browser cannot write images to the clipboard
 */
export async function copyBlobToClipboard(blob) {
  if (!canCopyImageToClipboard()) throw new Error('Clipboard image copy is not supported in this browser');
  const type = (blob && typeof blob.then !== 'function' && blob.type) || 'image/png';
  await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
}
