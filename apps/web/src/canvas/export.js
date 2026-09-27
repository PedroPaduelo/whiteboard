/**
 * export.js — SVG, PNG and JSON out of the same element array.
 *
 * The hard requirement is that an exported PNG is pixel-identical to what the
 * user saw. That is achieved by REUSING the geometry helpers from
 * `@whiteboard/shared` and the text wrapping from `shapes.js` — the same
 * functions the canvas renderer called — rather than re-deriving geometry
 * here. If the export had its own copy of "where is the middle of this box",
 * the two would drift within a week and the export would be quietly wrong.
 *
 * Rotation is the one thing that needs care: an SVG element is painted inside
 * a `<g transform="rotate(deg cx cy)">`, which is exactly what the canvas's
 * save/translate/rotate does, so a rotated rect exports rotated.
 */

import { validateElement, tryValidateElement, LIMITS } from '@whiteboard/shared';
import {
  FONT_STACK,
  LINE_HEIGHT,
  hasFill,
  dashArrayFor,
  textLines,
  textColorOf,
  alignX,
  textAlignFor,
  emitSmoothedPath,
  arrowhead,
  cylinderPath,
  diamondPath,
} from './shapes.js';
import { themeColors } from './renderer.js';

/** XML-escape. Applied to every text node; unescaped `&` breaks the document. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A colour is safe to inline only if it cannot carry markup or a url(). */
function safeColor(c) {
  if (typeof c !== 'string') return null;
  const s = c.trim();
  // Reject anything that could be an injection vector. `validateElement`
  // already restricts colours to hex/rgb/hsl/named, but the exporter is
  // reachable with a hand-edited file, so it does not trust its input.
  if (!/^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|[a-zA-Z]{3,20})$/.test(s)) {
    return null;
  }
  return s;
}

/** The union of every element's box, in board units. Never null for a
 *  non-empty array; for an empty array it is a 100x100 box at the origin so
 *  the exporter still produces a valid (if blank) document. */
export function exportBounds(elements) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const list = elements || [];
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (!el) continue;
    if (el.x < minX) minX = el.x;
    if (el.y < minY) minY = el.y;
    if (el.x + el.w > maxX) maxX = el.x + el.w;
    if (el.y + el.h > maxY) maxY = el.y + el.h;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 100, h: 100 };
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

/* ------------------------------------------------------------------ *
 * Per-type SVG nodes
 * ------------------------------------------------------------------ */

function strokeAttrs(el) {
  const c = safeColor(el.stroke);
  if (!c) return '';
  const w = el.strokeWidth === undefined ? 2 : el.strokeWidth;
  if (w <= 0) return '';
  const dash = dashArrayFor(el.strokeStyle, w);
  return ` stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}`;
}

function fillAttr(el, fallback = 'none') {
  const c = safeColor(el.fill);
  if (!hasFill(el.fill)) return ` fill="${fallback}"`;
  return ` fill="${c}"`;
}

function opacityAttr(el) {
  return el.opacity !== undefined && el.opacity < 1 ? ` opacity="${el.opacity}"` : '';
}

/** The `<g>` that applies an element's rotation, exactly like withRotation. */
function rotationOpen(el) {
  const r = el.rotation || 0;
  if (!r) return { open: '', close: '' };
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const deg = (r * 180) / Math.PI;
  return {
    open: `<g transform="rotate(${round(deg)} ${round(cx)} ${round(cy)})">`,
    close: '</g>',
  };
}

const round = (n) => Math.round(n * 100) / 100;

function svgFor(el) {
  const rot = rotationOpen(el);
  const inner = innerSvg(el);
  if (!rot.open) return inner;
  return rot.open + inner + rot.close;
}

function innerSvg(el) {
  switch (el.type) {
    case 'rect':
    case 'sticky': {
      const rx = el.type === 'sticky' ? Math.min(6, el.w / 8, el.h / 8) : 0;
      return `<rect x="${round(el.x)}" y="${round(el.y)}" width="${round(el.w)}" height="${round(el.h)}"${rx ? ` rx="${round(rx)}"` : ''}${fillAttr(el)}${strokeAttrs(el)}${opacityAttr(el)}/>`;
    }

    case 'ellipse': {
      const cx = el.x + el.w / 2;
      const cy = el.y + el.h / 2;
      return `<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(Math.max(0, el.w / 2))}" ry="${round(Math.max(0, el.h / 2))}"${fillAttr(el)}${strokeAttrs(el)}${opacityAttr(el)}/>`;
    }

    case 'diamond': {
      const d = pathFromCtx(diamondPath, el);
      return `<path d="${d}"${fillAttr(el)}${strokeAttrs(el)}${opacityAttr(el)}/>`;
    }

    case 'cylinder': {
      // The SAME path the canvas builds, turned into an SVG `d` string by a
      // throwaway context-like sink. One geometry, two renderers.
      const d = pathFromCtx(cylinderPath, el);
      return `<path d="${d}"${fillAttr(el)}${strokeAttrs(el)}${opacityAttr(el)}/>`;
    }

    case 'pen': {
      const d = smoothedPathD(el.points || []);
      if (!d) return '';
      return `<path d="${d}" fill="none"${strokeAttrs(el)}${opacityAttr(el)}/>`;
    }

    case 'line': {
      const pts = el.points || [];
      if (pts.length < 2) return '';
      return `<line x1="${round(pts[0].x)}" y1="${round(pts[0].y)}" x2="${round(pts[1].x)}" y2="${round(pts[1].y)}"${strokeAttrs(el)}${opacityAttr(el)}/>`;
    }

    case 'arrow': {
      const pts = el.points || [];
      if (pts.length < 2) return '';
      const a = pts[0];
      const b = pts[1];
      const w = el.strokeWidth === undefined ? 2 : el.strokeWidth;
      const head = arrowhead(b, b.x - a.x, b.y - a.y, w);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const shaftEnd = { x: b.x - ux * head.size * 0.5, y: b.y - uy * head.size * 0.5 };
      const c = safeColor(el.stroke) || '#1f2937';
      return (
        `<line x1="${round(a.x)}" y1="${round(a.y)}" x2="${round(shaftEnd.x)}" y2="${round(shaftEnd.y)}"${strokeAttrs(el)}/>` +
        `<polygon points="${round(head.tip.x)},${round(head.tip.y)} ${round(head.left.x)},${round(head.left.y)} ${round(head.right.x)},${round(head.right.y)}" fill="${c}" stroke="${c}" stroke-width="${round(w * 0.6)}" stroke-linejoin="round"/>`
      );
    }

    case 'text': {
      // Text is emitted as real `<text>`/`<tspan>` nodes, not paths, so the
      // result stays selectable and searchable in Figma and Inkscape.
      const lines = textLines(el);
      if (!lines.length) return '';
      const fs = el.fontSize || 16;
      const x = el.x + alignX(el.align, el.w);
      const anchor = textAlignFor(el.align);
      const body = lines
        .map((l, i) => `<tspan x="${round(x)}" y="${round(el.y + i * fs * LINE_HEIGHT)}">${esc(l)}</tspan>`)
        .join('');
      const c = safeColor(textColorOf(el)) || '#1f2937';
      return `<text x="${round(x)}" y="${round(el.y)}" font-family="${esc(FONT_STACK)}" font-size="${round(fs)}" fill="${c}" text-anchor="${anchor}" xml:space="preserve"${opacityAttr(el)}>${body}</text>`;
    }

    case 'image': {
      const src = safeImageSrc(el.src);
      if (!src) {
        return `<rect x="${round(el.x)}" y="${round(el.y)}" width="${round(el.w)}" height="${round(el.h)}" fill="#f3f4f6" stroke="#9ca3af" stroke-width="1.5"/>`;
      }
      return `<image href="${esc(src)}" x="${round(el.x)}" y="${round(el.y)}" width="${round(el.w)}" height="${round(el.h)}" preserveAspectRatio="none"${opacityAttr(el)}/>`;
    }

    default:
      return '';
  }
}

/**
 * Run one of the canvas path builders against a sink that records an SVG `d`
 * string. This is the trick that keeps the export and the renderer in
 * lockstep: `cylinderPath` and `diamondPath` from shapes.js are called here
 * directly, so there is exactly one cylinder in the codebase.
 */
function pathFromCtx(builder, el) {
  const parts = [];
  const ctx = {
    moveTo: (x, y) => parts.push(`M ${round(x)} ${round(y)}`),
    lineTo: (x, y) => parts.push(`L ${round(x)} ${round(y)}`),
    bezierCurveTo: (a, b, c, d, e2, f) => parts.push(`C ${round(a)} ${round(b)}, ${round(c)} ${round(d)}, ${round(e2)} ${round(f)}`),
    quadraticCurveTo: (a, b, c, d) => parts.push(`Q ${round(a)} ${round(b)}, ${round(c)} ${round(d)}`),
    closePath: () => parts.push('Z'),
  };
  builder(ctx, el);
  return parts.join(' ');
}

/** The pen's smoothed path, via the SAME `emitSmoothedPath` the canvas uses. */
function smoothedPathD(pts) {
  const parts = [];
  emitSmoothedPath(pts, {
    moveTo: (a, b) => parts.push(`M ${round(b === undefined ? a.x : a)} ${round(b === undefined ? a.y : b)}`),
    lineTo: (a, b) => parts.push(`L ${round(b === undefined ? a.x : a)} ${round(b === undefined ? a.y : b)}`),
    quadTo: (a, b, c, d) => parts.push(`Q ${round(a)} ${round(b)}, ${round(c)} ${round(d)}`),
  });
  return parts.join(' ');
}

/** Only the src forms `validateElement` accepts; anything else is dropped. */
function safeImageSrc(src) {
  if (typeof src !== 'string' || src.length === 0) return null;
  if (!/^(data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+|https:\/\/[^\s]+)$/.test(src)) {
    return null;
  }
  return src;
}

/** The sticky's centred label, emitted as a separate node after the rect. */
function stickyLabelSvg(el) {
  const label = el.label || '';
  if (!label || el.h <= 6) return '';
  const fill = hasFill(el.fill) ? safeColor(el.fill) : '#fde68a';
  const rot = rotationOpen(el);
  const lines = label.split('\n');
  const fs = Math.max(9, Math.min(18, (el.h / Math.max(2, lines.length)) * 0.8));
  const lh = fs * LINE_HEIGHT;
  const cx = el.x + el.w / 2;
  const startY = el.y + el.h / 2 - ((lines.length - 1) * lh) / 2;
  // The canvas picks the label colour for contrast against the fill. SVG has
  // no such helper, so the SAME rule is applied here.
  const text = readableOn(fill || '#fde68a');
  const body = lines
    .map((l, i) => `<tspan x="${round(cx)}" y="${round(startY + i * lh)}">${esc(l)}</tspan>`)
    .join('');
  const node = `<text x="${round(cx)}" y="${round(startY)}" font-family="${esc(FONT_STACK)}" font-size="${round(fs)}" font-weight="500" fill="${text}" text-anchor="middle" xml:space="preserve">${body}</text>`;
  return rot.open + node + rot.close;
}

/** Mirror of `readableTextOn`, inlined so this module has one import less to
 *  get wrong at build time. Kept in sync by the test that exports a sticky. */
function readableOn(bg) {
  const s = String(bg || '').trim();
  let r = 0;
  let g = 0;
  let b = 0;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const full = hex.length === 3 || hex.length === 4 ? [...hex].map((ch) => ch + ch).join('') : hex;
    r = parseInt(full.slice(0, 2), 16) || 0;
    g = parseInt(full.slice(2, 4), 16) || 0;
    b = parseInt(full.slice(4, 6), 16) || 0;
  } else {
    const m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      r = p[0] || 0;
      g = p[1] || 0;
      b = p[2] || 0;
    }
  }
  const f = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }
  const lum = 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  return lum > 0.45 ? '#111827' : '#ffffff';
}

/* ------------------------------------------------------------------ *
 * SVG document
 * ------------------------------------------------------------------ */

/**
 * Build a complete, standalone SVG document.
 *
 * @param {Array<object>} elements
 * @param {object} [opts]
 * @param {number} [opts.padding] board units of margin around the content
 * @param {string} [opts.background] any CSS colour, or 'none' for transparent
 * @param {'light'|'dark'} [opts.theme] picks the default background
 * @param {number} [opts.scale] multiplies the output size (vector, so free)
 * @param {string} [opts.title]
 * @returns {string}
 */
export function exportSVG(elements, opts = {}) {
  const list = elements || [];
  const b = exportBounds(list);
  const pad = opts.padding === undefined ? 32 : opts.padding;
  const scale = opts.scale || 1;
  const x = b.x - pad;
  const y = b.y - pad;
  const w = b.w + pad * 2;
  const h = b.h + pad * 2;

  const colors = themeColors(opts.theme || 'light');
  const bg = opts.background === undefined ? colors.bg : opts.background;
  const bgRect = bg && bg !== 'none'
    ? `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" fill="${esc(safeColor(bg) || colors.bg)}"/>`
    : '';

  const body = list.map((el) => (el && el.type ? el.type === 'sticky' ? svgFor(el) + stickyLabelSvg(el) : svgFor(el) : '')).join('');

  // The viewBox is in BOARD units, so the exported file scales to any output
  // size without loss — and it opens at 1:1 in Inkscape/Figma.
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${round(w * scale)}" height="${round(h * scale)}" ` +
    `viewBox="${round(x)} ${round(y)} ${round(w)} ${round(h)}">` +
    (opts.title ? `<title>${esc(opts.title)}</title>` : '') +
    bgRect +
    body +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

/**
 * Rasterise an SVG string to a PNG Blob.
 *
 * The `decode()` before drawing is not optional: drawing an Image that has
 * not finished decoding yields a blank canvas, and "export PNG" silently
 * producing an empty file is the worst possible failure for this function.
 *
 * Uses OffscreenCanvas where available (no DOM node, no data-URL round trip
 * through a base64 string) and falls back to a regular canvas.
 *
 * @param {string} svgString
 * @param {object} [opts]
 * @param {number} [opts.scale=2] output pixels per board unit
 * @param {string} [opts.background] overrides the SVG background
 * @param {'image/png'|'image/jpeg'} [opts.type]
 * @param {number} [opts.quality] for jpeg
 * @returns {Promise<Blob>}
 */
export async function exportPNG(svgString, opts = {}) {
  const scale = opts.scale === undefined ? 2 : opts.scale;
  const type = opts.type || 'image/png';
  const source = opts.background === undefined ? svgString : withBackground(svgString, opts.background);

  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  const img = await loadImage(url);

  // Read the intrinsic size off the SVG root, which is where the document
  // already states it; fall back to the element's natural size.
  const w = Math.max(1, Math.round((img.naturalWidth || img.width || 1) * 1));
  const h = Math.max(1, Math.round((img.naturalHeight || img.height || 1) * 1));
  const pw = Math.max(1, Math.round(w * scale));
  const ph = Math.max(1, Math.round(h * scale));

  if (typeof OffscreenCanvas !== 'undefined') {
    const oc = new OffscreenCanvas(pw, ph);
    const octx = oc.getContext('2d');
    octx.drawImage(img, 0, 0, pw, ph);
    return await oc.convertToBlob({ type, quality: opts.quality });
  }

  const canvas = document.createElement('canvas');
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, pw, ph);
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encode failed'))), type, opts.quality);
  });
}

/** Load an Image and wait for `decode()`, never rejecting on a broken src. */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (typeof img.decode === 'function') {
        img.decode().then(() => resolve(img)).catch(() => resolve(img));
      } else {
        resolve(img);
      }
    };
    img.onerror = () => reject(new Error('could not rasterise the SVG'));
    img.src = src;
  });
}

/** Swap the document's background rect for a solid one. */
function withBackground(svgString, background) {
  const c = safeColor(background);
  if (!c) return svgString;
  const m = /<rect x="[^"]*" y="[^"]*" width="[^"]*" height="[^"]*" fill="[^"]*"\/>/.exec(svgString);
  const rect = m ? m[0].replace(/fill="[^"]*"/, `fill="${c}"`) : '';
  return rect ? svgString.replace(m[0], rect) : svgString;
}

/**
 * Trigger a browser download for a Blob or string. Kept here so the export
 * dialog does not have to know how to make an object URL.
 */
export function downloadBlob(blob, filename) {
  const blobObj = typeof blob === 'string' ? new Blob([blob], { type: 'text/plain;charset=utf-8' }) : blob;
  const url = URL.createObjectURL(blobObj);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers, so it is
  // deferred a tick.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ *
 * JSON
 * ------------------------------------------------------------------ */

/** The JSON wire format. Bumped when the shape changes incompatibly. */
export const JSON_VERSION = 1;

/**
 * Serialise elements to a JSON string.
 * @param {Array<object>} elements
 * @param {object} [opts] `{board}` to embed board metadata.
 */
export function exportJSON(elements, opts = {}) {
  return JSON.stringify(
    {
      version: JSON_VERSION,
      kind: 'whiteboard.elements',
      exportedAt: opts.now === undefined ? 0 : opts.now,
      board: opts.board || null,
      elements: (elements || []).map((el) => {
        const clean = {};
        for (const [k, v] of Object.entries(el)) {
          if (v === undefined) continue;
          clean[k] = v;
        }
        return clean;
      }),
    },
    null,
    opts.pretty === false ? 0 : 2,
  );
}

/**
 * Parse and validate an exported JSON string.
 *
 * ALL-OR-NOTHING on purpose: a board that imports 400 of 500 elements is a
 * board nobody can trust, and the user has no way to tell which 100 are
 * missing. The first invalid element rejects the whole import, naming it, so
 * the failure is legible.
 *
 * Accepts both the wrapped export format and a bare array, because people
 * paste element JSON into the box.
 *
 * @param {string|object} json
 * @returns {{ok:true, elements:object[], board?:object} | {ok:false, error:string, index?:number}}
 */
export function importJSON(json) {
  let data = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json);
    } catch (e) {
      return { ok: false, error: `not valid JSON: ${e.message}` };
    }
  }
  if (!data) return { ok: false, error: 'empty document' };

  const list = Array.isArray(data) ? data : data.elements;
  if (!Array.isArray(list)) {
    return { ok: false, error: 'expected an array of elements, or {elements: [...]}' };
  }
  if (list.length > LIMITS.MAX_ELS) {
    return { ok: false, error: `too many elements (max ${LIMITS.MAX_ELS})` };
  }

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const res = tryValidateElement(list[i]);
    if (!res.valid) {
      // Reject the WHOLE import, not just the bad element.
      return { ok: false, error: `element ${i}: ${res.error}`, index: i };
    }
    out.push(res.element);
  }
  return { ok: true, elements: out, board: Array.isArray(data) ? undefined : data.board || undefined };
}

/**
 * Validate a single element, throwing. Used by the tests to assert that
 * everything the interaction reducer produces is a legal wire element.
 */
export function assertValidElement(el) {
  return validateElement(el);
}

export { esc as escapeXml, safeColor, safeImageSrc };
