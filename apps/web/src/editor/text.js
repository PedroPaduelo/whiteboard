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

/*
 * Line breaking for labels.
 *
 * The label editor is a <textarea> with `white-space: pre-wrap` and
 * `overflow-wrap / word-break: break-word` (TextEditor.jsx), and it sizes
 * itself from `wrapText`'s line count. So `wrapText` has to break lines where
 * the browser does, or the text jumps when editing starts or ends, and the
 * textarea clips the lines it did not expect. It follows the CSS rules that
 * matter for typed text (checked against Chromium):
 *
 *   - a soft-wrap opportunity after every run of breakable spaces, and after a
 *     hyphen or dash (`-`, U+2010, `–`, `—`) or `?` unless the next character
 *     cannot start a line (another hyphen, closing punctuation…) — so
 *     `segunda-feira` breaks as `segunda-` / `feira`, like the textarea;
 *   - a no-break space (U+00A0, U+202F, U+2007) never breaks;
 *   - spaces at a soft wrap HANG: they never push text onto a new line and are
 *     not part of the line (so they do not shift centred/right-aligned text);
 *   - an unbreakable run wider than the box is broken between graphemes, but
 *     only after it has been moved to a line of its own (break-word breaks a
 *     word only when the line has no other opportunity);
 *   - explicit `\n` always breaks, and the spaces before one stay on the line.
 */

/** Spaces that end a word: U+0020, tab, the typographic spaces, ideographic space, ZWSP. */
const BREAK_SPACE = /[ \t\u1680\u2000-\u2006\u2008-\u200a\u200b\u205f\u3000]/;
const TRAILING_SPACES = /[ \t\u1680\u2000-\u2006\u2008-\u200a\u200b\u205f\u3000]+$/;
/** A line may break AFTER these (UAX #14 classes HY, BA and B2, plus `?`, as Chromium does). */
const BREAK_AFTER = new Set(['-', '\u2010', '\u2013', '\u2014', '?']);
/** …but never before these: no line starts with them. */
const NO_BREAK_BEFORE = new Set(['-', '\u2010', '\u2013', '\u2014', '?', '!', '.', ',', ':', ';', ')', ']', '}', '%', '"', "'", '\u00bb', '\u201d', '\u2019']);

let graphemeSegmenter;
/** User-perceived characters, so a word is never split inside "ã" or an emoji. */
function graphemes(s) {
  if (graphemeSegmenter === undefined) {
    try {
      graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
    } catch {
      graphemeSegmenter = null;
    }
  }
  if (!graphemeSegmenter) return Array.from(s);
  return Array.from(graphemeSegmenter.segment(s), (g) => g.segment);
}

/** Drop the spaces a line ends with (the ones that would hang). */
export function trimTrailingSpaces(s) {
  return s.replace(TRAILING_SPACES, '');
}

/**
 * Cut a paragraph (no `\n`) at its soft-wrap opportunities. Each piece keeps
 * the spaces that follow it, so the pieces concatenate back to `para`.
 */
function breakSegments(para) {
  const chars = Array.from(para);
  const out = [];
  let cur = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    cur += ch;
    if (next === undefined) break;
    const nextIsSpace = BREAK_SPACE.test(next);
    if (BREAK_SPACE.test(ch) ? !nextIsSpace : BREAK_AFTER.has(ch) && !nextIsSpace && !NO_BREAK_BEFORE.has(next)) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Wrap text to `maxWidth` px the way the label textarea does (see above).
 * Explicit newlines are kept; a word wider than the box is broken between
 * characters so it never overflows.
 *
 * Lines ended by a soft wrap come back without their hanging spaces; the last
 * line of each paragraph keeps the spaces typed before the `\n` (they still
 * count for alignment when they fit — `layoutText` handles that).
 *
 * @returns {string[]}
 */
export function wrapText(text, maxWidth, fontFamily = 'hand', fontSize = FONT_SIZES.M) {
  const out = [];
  const width = Math.max(1, maxWidth);
  const fits = (s) => measureLine(s, fontFamily, fontSize) <= width;
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const seg of breakSegments(para)) {
      if (line !== '') {
        // Hanging spaces do not count toward the fit.
        if (fits(trimTrailingSpaces(line + seg))) {
          line += seg;
          continue;
        }
        out.push(trimTrailingSpaces(line));
        line = '';
      }
      // `seg` starts a line. Its trailing spaces hang; only the rest must fit.
      const body = trimTrailingSpaces(seg);
      if (body === '' || fits(body)) {
        line = seg;
        continue;
      }
      // Wider than the box on a line of its own: break between graphemes.
      let chunk = '';
      for (const g of graphemes(body)) {
        if (chunk !== '' && !fits(chunk + g)) {
          out.push(chunk);
          chunk = g;
        } else chunk += g;
      }
      line = chunk + seg.slice(body.length);
    }
    out.push(line);
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
 * - rect/ellipse/diamond/cylinder label: wrapped, centred vertically, aligned
 *   per `align` (default centre).
 *
 * Labels are wrapped with `wrapText`, so the painted lines are the textarea's
 * lines; a line's `text` never ends in spaces (its `x` already accounts for
 * the ones the browser counts when aligning).
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
    lines: lines.map((t, i) => {
      const y = top + i * lh;
      const shown = trimTrailingSpaces(t);
      if (shown === t || align === 'left') return { text: shown, x: anchorX, y };
      // Spaces typed before a line break are part of the line in the
      // textarea (pre-wrap "conditionally hangs" them): they count for
      // centring/right-alignment up to the box width. Paint the glyphs only,
      // shifted to where the browser puts them.
      const inked = measureLine(shown, fontFamily, fontSize);
      const full = Math.max(inked, Math.min(box.w, measureLine(t, fontFamily, fontSize)));
      const shift = align === 'center' ? (full - inked) / 2 : full - inked;
      return { text: shown, x: anchorX - shift, y };
    }),
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
