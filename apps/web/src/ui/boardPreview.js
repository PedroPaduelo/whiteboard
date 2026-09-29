/**
 * boardPreview.js — the board list's thumbnails, as plain functions (node
 * tests import them; ui/BoardList.jsx renders them).
 *
 * A thumbnail is the board's REAL content, drawn small with the SVG export
 * (editor/export/export.js), so it has the same hand-drawn look as the board.
 * It used to be 2–4 random outlines hashed from the board id: every row —
 * an empty board included — looked like it had content, and no row showed
 * what its board actually held. An empty board (the list's `elementCount` is
 * 0) now says so without fetching anything; a board too big to draw here
 * shows its element count instead.
 */

import { exportToSvg } from '../editor/export/export.js';
import { FONT_FACES } from '../editor/fonts.js';

/** Boards with more elements than this are not drawn in the list (it stays fast). */
export const PREVIEW_MAX_ELEMENTS = 1500;

/** Padding (board units) around the drawn content. */
const PREVIEW_PADDING = 12;

/**
 * No embedded fonts: a thumbnail's text is a few pixels tall, and embedding
 * the handwriting font would put ~100 KB into every row's image.
 */
const NO_FONTS = Object.freeze(Object.fromEntries(FONT_FACES.map((f) => [f.family, ''])));

/**
 * What a row's thumbnail shows, from the list row alone:
 * 'empty' (no elements), 'large' (too many to draw here) or 'content'
 * (fetch the snapshot and draw it). A server that does not report
 * `elementCount` gets 'content'.
 */
export function previewKind(board) {
  const n = board?.elementCount;
  if (n === 0) return 'empty';
  if (typeof n === 'number' && Number.isFinite(n) && n > PREVIEW_MAX_ELEMENTS) return 'large';
  return 'content';
}

/**
 * The thumbnail image for a board's elements: an SVG data URL for an <img>
 * (an image, so nothing in it runs or restyles the page), or null when there
 * is nothing to draw. Transparent background: the row's frame paints the
 * canvas colour; `dark` applies the export's dark-mode filter, as the canvas
 * does on screen.
 */
export function previewSrc(elements, { dark = false } = {}) {
  const list = Array.isArray(elements) ? elements.filter((el) => el && typeof el === 'object') : [];
  if (!list.length || list.length > PREVIEW_MAX_ELEMENTS) return null;
  const svg = exportToSvg(list, { background: false, dark, padding: PREVIEW_PADDING, scale: 1, fonts: NO_FONTS });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The query key of a board's thumbnail: a new revision is a new picture. */
export function previewQueryKey(board) {
  return ['board-preview', board?.id ?? '', board?.rev ?? null, board?.elementCount ?? null];
}
