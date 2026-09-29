/**
 * constants.js — every number and palette the editor shares.
 *
 * The palettes mirror Excalidraw's defaults on purpose: the look the user asked
 * for is "like Excalidraw", and most of that look is these exact colours, the
 * three stroke widths and the Virgil hand-drawn font. Keep UI, renderer and
 * export reading from here so a colour never exists in only one of them.
 *
 * Every value here must also pass `validateElement` in @whiteboard/shared —
 * a style the server strips is a style that vanishes on reload. That is why
 * the enums below are re-exported from the shared model instead of being
 * declared again: a second copy drifts (the web copy of FILL_STYLES once
 * lacked 'zigzag', so a zigzag element showed no fill option selected).
 */

export { FILL_STYLES, STROKE_STYLES, ROUNDNESS, ARROWHEADS, TEXT_ALIGNS } from '@whiteboard/shared';

/** Stroke swatches shown first in the properties panel (Excalidraw's quick row). */
export const STROKE_COLORS = Object.freeze(['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00']);

/** Background swatches. `'none'` is the transparent swatch. */
export const BACKGROUND_COLORS = Object.freeze(['none', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99']);

/** The full picker grid (shades), used by the "more colours" popover. */
export const COLOR_GRID = Object.freeze([
  '#1e1e1e', '#343a40', '#495057', '#868e96', '#ced4da', '#ffffff',
  '#e03131', '#c2255c', '#9c36b5', '#6741d9', '#3b5bdb', '#1971c2',
  '#0c8599', '#099268', '#2f9e44', '#66a80f', '#f08c00', '#e8590c',
  '#ffc9c9', '#fcc2d7', '#eebefa', '#d0bfff', '#bac8ff', '#a5d8ff',
  '#99e9f2', '#96f2d7', '#b2f2bb', '#d8f5a2', '#ffec99', '#ffd8a8',
]);

/** Sticky-note fills (the extra element type we keep beyond Excalidraw). */
export const STICKY_COLORS = Object.freeze(['#ffec99', '#b2f2bb', '#a5d8ff', '#ffc9c9', '#eebefa']);

export const STROKE_WIDTHS = Object.freeze({ thin: 1, bold: 2, extraBold: 4 });

/** Sloppiness: 0 architect, 1 artist, 2 cartoonist — roughjs `roughness`. */
export const ROUGHNESS = Object.freeze({ architect: 0, artist: 1, cartoonist: 2 });

/** Font families, keyed by the value stored on the element. */
export const FONT_FAMILIES = Object.freeze({
  hand: '"Virgil", "Segoe Print", "Comic Sans MS", cursive',
  normal: 'Helvetica, "Segoe UI", Arial, sans-serif',
  code: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
});

export const FONT_SIZES = Object.freeze({ S: 16, M: 20, L: 28, XL: 36 });

export const LINE_HEIGHT = 1.25;

/**
 * The style every new element starts from. `store.style` is initialised from
 * this and the properties panel edits it; `createElement` reads it.
 */
export const DEFAULT_STYLE = Object.freeze({
  stroke: '#1e1e1e',
  fill: 'none',
  fillStyle: 'hachure',
  strokeWidth: STROKE_WIDTHS.bold,
  strokeStyle: 'solid',
  roughness: ROUGHNESS.artist,
  roundness: 'round',
  opacity: 1,
  fontFamily: 'hand',
  fontSize: FONT_SIZES.M,
  align: 'left',
  startArrowhead: 'none',
  endArrowhead: 'arrow',
  stickyFill: '#ffec99',
});

/** Padding between a container's edge and its label, board units (Excalidraw's BOUND_TEXT_PADDING). */
export const LABEL_PADDING = 5;

/** Sticky notes: inner padding and default size. */
export const STICKY_PADDING = 14;
export const STICKY_SIZE = Object.freeze({ w: 200, h: 200 });

/* --- interaction ---------------------------------------------------------- */

/** A pointer that moves less than this (screen px) is a click, not a drag. */
export const DRAG_THRESHOLD = 3;

/** Hit-test slop in SCREEN px; divide by zoom before comparing in board units. */
export const HIT_TOLERANCE = 6;

/** Selection handles, SCREEN px. */
export const HANDLE_SIZE = 8;
export const ROTATE_HANDLE_OFFSET = 20;
export const SELECTION_PADDING = 6;

/** Linear-element point handles, SCREEN px radius. */
export const POINT_HANDLE_RADIUS = 5;

/** How far (screen px) an arrow end snaps onto a shape to bind to it. */
export const BIND_DISTANCE = 16;

/** Shapes smaller than this after a drag get the default size instead. */
export const MIN_SHAPE_SIZE = 4;
export const DEFAULT_SHAPE_SIZE = Object.freeze({ w: 120, h: 80 });

/** Freehand: minimum spacing between recorded points, SCREEN px. */
export const FREEDRAW_MIN_SPACING = 1.5;

/** Arrow-key nudge, board units; Shift+arrow uses NUDGE_SHIFT. */
export const NUDGE = 1;
export const NUDGE_SHIFT = 10;

/** Paste / duplicate offset, board units. */
export const DUPLICATE_OFFSET = 10;

/* --- view ----------------------------------------------------------------- */

export const ZOOM_STEP = 1.1;
export const ZOOM_BUTTON_FACTOR = 1.25;
export const WHEEL_ZOOM_SENSITIVITY = 0.0015;

/** Grid, when shown, is dots every GRID_SIZE board units (Excalidraw uses 20). */
export const GRID_SIZE = 20;

/** Canvas background per theme. Dark mode is the light scene run through an
 *  invert+hue-rotate filter, exactly like Excalidraw, so element colours are
 *  stored once and still read well on both backgrounds. */
export const CANVAS_BACKGROUND = '#ffffff';
export const DARK_MODE_FILTER = 'invert(93%) hue-rotate(180deg)';

/** Selection accent (Excalidraw's violet). */
export const SELECTION_COLOR = '#6965db';

/* --- images --------------------------------------------------------------- */

/** Longest side an inserted image is downscaled to before becoming a data URL. */
export const IMAGE_MAX_SIDE = 1600;
/** Must stay under LIMITS.MAX_IMAGE_CHARS in @whiteboard/shared (2,000,000). */
export const IMAGE_MAX_CHARS = 1_900_000;
