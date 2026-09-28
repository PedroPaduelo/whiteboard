/**
 * text.js — the one place text is measured and laid out.
 *
 * The renderer, the in-place editor, hit-testing and the SVG export all ask
 * this module where each line goes. If two of them measured text their own
 * way, the textarea would reflow differently from the painted text and the
 * exported SVG would not match the screen — exactly the bugs the old editor had.
 *
 * Measurement uses a real canvas when one exists. In node (unit tests) there is
 * no canvas, so it falls back to a fixed per-character advance. That estimate is
 * deterministic, which is what tests need; it is never used in a browser.
 */

import { FONT_FAMILIES, FONT_SIZES, LINE_HEIGHT, LABEL_PADDING, STICKY_PADDING } from './constants.js';

/** CSS font shorthand for a family key ('hand'|'normal'|'code') and a size. */
export function fontString(fontFamily, fontSize) {
  const family = FONT_FAMILIES[fontFamily] ?? FONT_FAMILIES.hand;
  return `${fontSize}px ${family}`;
}

let measureCtx = null;
function getMeasureContext() {
  if (measureCtx) return measureCtx;
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
    } else if (typeof document !== 'undefined') {
      measureCtx = document.createElement('canvas').getContext('2d');
    }
  } catch {
    measureCtx = null;
  }
  return measureCtx;
}

/** Average advance per character, as a fraction of the font size, for node. */
const FALLBACK_ADVANCE = { hand: 0.55, normal: 0.52, code: 0.6 };

/** Width in px of one line of text at a font. */
export function measureLine(line, fontFamily = 'hand', fontSize = FONT_SIZES.M) {
  const ctx = getMeasureContext();
  if (ctx) {
    ctx.font = fontString(fontFamily, fontSize);
    return ctx.measureText(line).width;
  }
  return line.length * fontSize * (FALLBACK_ADVANCE[fontFamily] ?? 0.55);
}

export function lineHeightPx(fontSize) {
  return fontSize * LINE_HEIGHT;
}

/**
 * Measure unwrapped text: every `\n` starts a line, nothing else does.
 * This is how free text elements size themselves (Excalidraw text auto-grows).
 * An empty string still has one line of height, so an empty box is clickable.
 *
 * @returns {{width:number, height:number, lines:string[]}}
 */
export function measureText(text, fontFamily = 'hand', fontSize = FONT_SIZES.M) {
  const lines = String(text ?? '').split('\n');
  let width = 0;
  for (const l of lines) width = Math.max(width, measureLine(l, fontFamily, fontSize));
  return { width: Math.ceil(width), height: Math.ceil(lines.length * lineHeightPx(fontSize)), lines };
}

/**
 * Greedy word wrap to `maxWidth` px. Explicit newlines are kept; a single word
 * wider than the box is broken by characters so it never overflows.
 * @returns {string[]}
 */
export function wrapText(text, maxWidth, fontFamily = 'hand', fontSize = FONT_SIZES.M) {
  const out = [];
  const width = Math.max(1, maxWidth);
  for (const para of String(text ?? '').split('\n')) {
    if (para === '') {
      out.push('');
      continue;
    }
    const words = para.split(/(\s+)/).filter((w) => w.length > 0);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (measureLine(candidate, fontFamily, fontSize) <= width || line === '') {
        if (line === '' && measureLine(word, fontFamily, fontSize) > width) {
          // Break an over-long word by characters.
          let chunk = '';
          for (const ch of word) {
            if (measureLine(chunk + ch, fontFamily, fontSize) > width && chunk) {
              out.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else {
          line = candidate;
        }
      } else {
        out.push(line.trimEnd());
        line = /^\s+$/.test(word) ? '' : word;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * Which element types carry a label drawn inside them, and under which key.
 * `text` is not here: a text element IS its text.
 */
export function labelKeyOf(el) {
  if (!el) return null;
  if (el.type === 'sticky') return 'label';
  if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'diamond' || el.type === 'cylinder') return 'label';
  return null;
}

/** The editable string of an element: `text` for text, `label` for containers. */
export function textOf(el) {
  if (!el) return '';
  if (el.type === 'text') return el.text ?? '';
  const key = labelKeyOf(el);
  return key ? el[key] ?? '' : '';
}

/**
 * The inner box a label is laid out in, board units, UNROTATED.
 * Ellipses and diamonds get a smaller box because their corners are not ink.
 */
export function labelBox(el) {
  if (el.type === 'sticky') {
    return { x: el.x + STICKY_PADDING, y: el.y + STICKY_PADDING, w: Math.max(1, el.w - STICKY_PADDING * 2), h: Math.max(1, el.h - STICKY_PADDING * 2) };
  }
  const inset = LABEL_PADDING;
  let w = el.w;
  let h = el.h;
  if (el.type === 'ellipse') {
    // Largest axis-aligned rect inside an ellipse is w/√2 × h/√2.
    w = el.w / Math.SQRT2;
    h = el.h / Math.SQRT2;
  } else if (el.type === 'diamond') {
    w = el.w / 2;
    h = el.h / 2;
  }
  const x = el.x + (el.w - w) / 2 + inset;
  const y = el.y + (el.h - h) / 2 + inset;
  return { x, y, w: Math.max(1, w - inset * 2), h: Math.max(1, h - inset * 2) };
}

/**
 * Full layout of the text an element shows: the lines and where each one is
 * drawn, in board units, UNROTATED (the caller applies rotation about the
 * element centre, same as for the shape itself).
 *
 * - text: lines split on `\n`, anchored at the element's top-left, aligned
 *   within the element's width.
 * - sticky: wrapped to the note, top-aligned, aligned per `align` (default left).
 * - rect/ellipse/diamond/cylinder label: wrapped, centred both ways.
 *
 * @returns {null | {lines: {text:string, x:number, y:number}[], font:string,
 *   fontSize:number, fontFamily:string, lineHeight:number,
 *   textAlign:'left'|'center'|'right', box:{x,y,w,h}}}
 *   `x` of each line is the anchor for `ctx.textAlign = textAlign`; `y` is the
 *   line's TOP (use `textBaseline = 'top'`).
 */
export function layoutText(el) {
  if (!el) return null;
  const fontFamily = el.fontFamily ?? 'hand';
  const isText = el.type === 'text';
  const fontSize = el.fontSize ?? FONT_SIZES.M;
  const raw = textOf(el);
  if (!isText && !raw) return null;
  const lh = lineHeightPx(fontSize);

  if (isText) {
    const lines = String(raw).split('\n');
    const align = el.align ?? 'left';
    const anchorX = align === 'center' ? el.x + el.w / 2 : align === 'right' ? el.x + el.w : el.x;
    return {
      lines: lines.map((t, i) => ({ text: t, x: anchorX, y: el.y + i * lh })),
      font: fontString(fontFamily, fontSize),
      fontSize,
      fontFamily,
      lineHeight: lh,
      textAlign: align,
      box: { x: el.x, y: el.y, w: el.w, h: el.h },
    };
  }

  const box = labelBox(el);
  const lines = wrapText(raw, box.w, fontFamily, fontSize);
  const align = el.type === 'sticky' ? el.align ?? 'left' : el.align ?? 'center';
  const anchorX = align === 'center' ? box.x + box.w / 2 : align === 'right' ? box.x + box.w : box.x;
  const total = lines.length * lh;
  const top = el.type === 'sticky' ? box.y : el.y + (el.h - total) / 2;
  return {
    lines: lines.map((t, i) => ({ text: t, x: anchorX, y: top + i * lh })),
    font: fontString(fontFamily, fontSize),
    fontSize,
    fontFamily,
    lineHeight: lh,
    textAlign: align,
    box,
  };
}

/**
 * The box a free text element must have for its current text. Call after
 * every text edit (and font change) and patch w/h — the server never measures.
 * Keeps x/y, except `center`/`right` aligned text grows around its anchor.
 */
export function fitTextElement(el) {
  const fontFamily = el.fontFamily ?? 'hand';
  const fontSize = el.fontSize ?? FONT_SIZES.M;
  const m = measureText(el.text ?? '', fontFamily, fontSize);
  const w = Math.max(m.width, Math.ceil(fontSize * 0.5));
  const h = m.height;
  let x = el.x;
  const align = el.align ?? 'left';
  if (align === 'center') x = el.x + el.w / 2 - w / 2;
  else if (align === 'right') x = el.x + el.w - w;
  return { x, y: el.y, w, h };
}

/** The text colour of an element: text uses `stroke` (Excalidraw), falling back
 *  to `fill` for legacy boards that stored text colour there. */
export function textColorOf(el) {
  if (el.type === 'text') {
    if (el.stroke && el.stroke !== 'none' && el.stroke !== 'transparent') return el.stroke;
    if (el.fill && el.fill !== 'none' && el.fill !== 'transparent') return el.fill;
    return '#1e1e1e';
  }
  if (el.type === 'sticky') return '#1e1e1e';
  // Labels inside shapes use the shape's stroke colour, like Excalidraw.
  if (el.stroke && el.stroke !== 'none' && el.stroke !== 'transparent') return el.stroke;
  return '#1e1e1e';
}
