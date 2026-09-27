/**
 * Icons.jsx — the app's entire icon set, hand-written as inline SVG.
 *
 * Why not a library: thirty 24x24 stroke glyphs are ~4KB of markup and zero
 * network weight, while a tree-shakeable icon package is either several times
 * that or a maintenance dependency. The icons are part of the product's
 * visual identity, so they live here where they can be tuned.
 *
 * House rules, applied to every icon below so the set reads as one family:
 *   - 24x24 viewBox, no width/height baked in (the `size` prop sets them)
 *   - fill: none, stroke: currentColor, strokeWidth 1.75
 *   - round caps and joins everywhere; `rx` of 2 or 3 on any corner
 *   - a glyph fits in a 20x20 box with >=2px of padding
 *
 * Every component takes `{ size = 20, className, ...rest }`.
 */

import React from 'react';

const base = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
};

/** Build an icon component from a static path spec. */
function icon(displayName, paths) {
  const Icon = ({ size = 20, className, ...rest }) => (
    <svg {...base} width={size} height={size} className={className} {...rest}>
      {paths}
    </svg>
  );
  Icon.displayName = displayName;
  return Icon;
}

/* --- modes ---------------------------------------------------------------- */

export const IconSelect = icon('IconSelect', (
  <>
    <path d="M5 3.5 18.5 12l-6.2 1.1-2.6 5.6z" />
  </>
));

export const IconHand = icon('IconHand', (
  <>
    <path d="M8.5 11V5.8a1.4 1.4 0 0 1 2.8 0V11" />
    <path d="M11.3 10.6V4.9a1.4 1.4 0 0 1 2.8 0v5.7" />
    <path d="M14.1 11V6.6a1.4 1.4 0 0 1 2.8 0V13" />
    <path d="M16.9 12.2v-2a1.4 1.4 0 0 1 2.8 0v4.2a5.6 5.6 0 0 1-5.6 5.6h-.7a5 5 0 0 1-3.8-1.8l-3.3-3.9a1.5 1.5 0 0 1 2.2-2l1.5 1.4" />
  </>
));

/* --- drawing tools -------------------------------------------------------- */

export const IconPen = icon('IconPen', (
  <>
    <path d="M4 20.2 4.9 16a2 2 0 0 1 .5-1L15.3 5a1.8 1.8 0 0 1 2.6 0l1.1 1.1a1.8 1.8 0 0 1 0 2.6L9 18.7a2 2 0 0 1-1 .5z" />
    <path d="M14.2 6.2 17.8 9.8" />
  </>
));

export const IconRect = icon('IconRect', (
  <>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
  </>
));

export const IconEllipse = icon('IconEllipse', (
  <>
    <ellipse cx="12" cy="12" rx="8.5" ry="6.8" />
  </>
));

export const IconDiamond = icon('IconDiamond', (
  <>
    <path d="M12 3.6 20.4 12 12 20.4 3.6 12z" />
  </>
));

export const IconCylinder = icon('IconCylinder', (
  <>
    <ellipse cx="12" cy="6" rx="7" ry="2.8" />
    <path d="M5 6v12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6" />
    <path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" />
  </>
));

export const IconSticky = icon('IconSticky', (
  <>
    <path d="M4.5 5.2A1.7 1.7 0 0 1 6.2 3.5h11.6a1.7 1.7 0 0 1 1.7 1.7v8.6L14 19.5H6.2a1.7 1.7 0 0 1-1.7-1.7z" />
    <path d="M19.5 13.5H15.6a1.6 1.6 0 0 0-1.6 1.6v4.4" />
    <path d="M8 8.4h6M8 11.6h4" />
  </>
));

export const IconText = icon('IconText', (
  <>
    <path d="M5 6.2V4.5h14v1.7" />
    <path d="M12 4.8v14.4" />
    <path d="M9 19.2h6" />
  </>
));

export const IconArrow = icon('IconArrow', (
  <>
    <path d="M4.5 19 19 5" />
    <path d="M12.4 4.8h6.9v6.9" />
  </>
));

export const IconLine = icon('IconLine', (
  <>
    <path d="M4.5 19.5 19.5 4.5" />
  </>
));

export const IconEraser = icon('IconEraser', (
  <>
    <path d="m9.1 16.6-4.4-4.4a2 2 0 0 1 0-2.8l6-6a2 2 0 0 1 2.8 0l6 6a2 2 0 0 1 0 2.8l-6 6a2 2 0 0 1-2.8 0l-1.6-1.6" />
    <path d="m8 9.4 6.6 6.6" />
    <path d="M10.6 19.5h8.9" />
  </>
));

/* --- history -------------------------------------------------------------- */

export const IconUndo = icon('IconUndo', (
  <>
    <path d="M4 9.5h9.6a5.4 5.4 0 0 1 0 10.8H8.2" />
    <path d="M7.8 5.3 3.6 9.5l4.2 4.2" />
  </>
));

export const IconRedo = icon('IconRedo', (
  <>
    <path d="M20 9.5h-9.6a5.4 5.4 0 0 0 0 10.8h5.4" />
    <path d="M16.2 5.3 20.4 9.5l-4.2 4.2" />
  </>
));

/* --- view ----------------------------------------------------------------- */

export const IconGrid = icon('IconGrid', (
  <>
    <path d="M3.8 9.4h16.4M3.8 14.6h16.4" />
    <path d="M9.4 3.8v16.4M14.6 3.8v16.4" />
  </>
));

export const IconSnap = icon('IconSnap', (
  <>
    <path d="M4 6.5v4.2a2 2 0 0 0 2 2h4.2" />
    <path d="M20 6.5v4.2a2 2 0 0 1-2 2h-4.2" />
    <path d="M4 17.5v-4.2a2 2 0 0 1 2-2h4.2" />
    <path d="M20 17.5v-4.2a2 2 0 0 0-2-2h-4.2" />
    <path d="M8 12h8M12 8v8" />
  </>
));

export const IconZoomIn = icon('IconZoomIn', (
  <>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="m15.4 15.4 4.1 4.1" />
    <path d="M8.3 10.8h5M10.8 8.3v5" />
  </>
));

export const IconZoomOut = icon('IconZoomOut', (
  <>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="m15.4 15.4 4.1 4.1" />
    <path d="M8.3 10.8h5" />
  </>
));

export const IconZoomFit = icon('IconZoomFit', (
  <>
    <path d="M3.8 8.8V4.6a.8.8 0 0 1 .8-.8h4.2" />
    <path d="M20.2 8.8V4.6a.8.8 0 0 0-.8-.8h-4.2" />
    <path d="M3.8 15.2v4.2a.8.8 0 0 0 .8.8h4.2" />
    <path d="M20.2 15.2v4.2a.8.8 0 0 1-.8.8h-4.2" />
  </>
));

/* --- chrome --------------------------------------------------------------- */

export const IconHelp = icon('IconHelp', (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.4a2.5 2.5 0 0 1 4.85.83c0 1.67-2.45 2.5-2.45 2.5" />
    <path d="M12 16.6h.01" />
  </>
));

export const IconDownload = icon('IconDownload', (
  <>
    <path d="M12 3.8v10.4" />
    <path d="m8 10.6 4 4 4-4" />
    <path d="M4.6 16.4v2.2a1.6 1.6 0 0 0 1.6 1.6h11.6a1.6 1.6 0 0 0 1.6-1.6v-2.2" />
  </>
));

export const IconPlus = icon('IconPlus', (
  <>
    <path d="M12 5.2v13.6M5.2 12h13.6" />
  </>
));

export const IconTrash = icon('IconTrash', (
  <>
    <path d="M4.8 6.6h14.4" />
    <path d="M9.4 6.6V5.2a1.4 1.4 0 0 1 1.4-1.4h2.4a1.4 1.4 0 0 1 1.4 1.4v1.4" />
    <path d="M6.6 6.6 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.8-12.4" />
    <path d="M10.4 10.2v6.2M13.6 10.2v6.2" />
  </>
));

export const IconCopy = icon('IconCopy', (
  <>
    <rect x="8.6" y="8.6" width="11.2" height="11.2" rx="2" />
    <path d="M15.4 5.6a2 2 0 0 0-2-2H5.6a2 2 0 0 0-2 2v7.8a2 2 0 0 0 2 2" />
  </>
));

export const IconLock = icon('IconLock', (
  <>
    <rect x="4.8" y="10.4" width="14.4" height="9.8" rx="2" />
    <path d="M8.2 10.4V7.8a3.8 3.8 0 0 1 7.6 0v2.6" />
  </>
));

export const IconEye = icon('IconEye', (
  <>
    <path d="M2.6 12S6 5.9 12 5.9 21.4 12 21.4 12 18 18.1 12 18.1 2.6 12 2.6 12" />
    <circle cx="12" cy="12" r="2.9" />
  </>
));

export const IconEyeOff = icon('IconEyeOff', (
  <>
    <path d="M9.6 6.3A8.7 8.7 0 0 1 12 5.9c6 0 9.4 6.1 9.4 6.1a17 17 0 0 1-2.8 3.5" />
    <path d="M6.4 8.1A17.4 17.4 0 0 0 2.6 12S6 18.1 12 18.1a9 9 0 0 0 3.6-.75" />
    <path d="M10 10a2.8 2.8 0 0 0 4 4" />
    <path d="M4 4l16 16" />
  </>
));

export const IconChevron = icon('IconChevron', (
  <>
    <path d="m9 5.5 6.5 6.5L9 18.5" />
  </>
));

export const IconChevronDown = icon('IconChevronDown', (
  <>
    <path d="m5.5 9 6.5 6.5L18.5 9" />
  </>
));

export const IconClose = icon('IconClose', (
  <>
    <path d="m6.2 6.2 11.6 11.6M17.8 6.2 6.2 17.8" />
  </>
));

export const IconCheck = icon('IconCheck', (
  <>
    <path d="m5 12.6 4.8 4.8L19 6.8" />
  </>
));

export const IconShare = icon('IconShare', (
  <>
    <circle cx="17.6" cy="5.9" r="2.6" />
    <circle cx="6.4" cy="12" r="2.6" />
    <circle cx="17.6" cy="18.1" r="2.6" />
    <path d="m8.7 10.7 6.6-3.4M8.7 13.3l6.6 3.4" />
  </>
));

export const IconSun = icon('IconSun', (
  <>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.8v2.1M12 19.1v2.1M4.4 4.4l1.5 1.5M18.1 18.1l1.5 1.5M2.8 12h2.1M19.1 12h2.1M4.4 19.6l1.5-1.5M18.1 5.9l1.5-1.5" />
  </>
));

export const IconMoon = icon('IconMoon', (
  <>
    <path d="M20.1 14.4A8.4 8.4 0 0 1 9.6 3.9a8.5 8.5 0 1 0 10.5 10.5" />
  </>
));

export const IconCloud = icon('IconCloud', (
  <>
    <path d="M7.2 18.4a3.9 3.9 0 0 1-.4-7.78 5.2 5.2 0 0 1 10-1.5 3.7 3.7 0 0 1-.6 9.28z" />
  </>
));

export const IconWifiOff = icon('IconWifiOff', (
  <>
    <path d="M2.6 3.4 21.4 20.8" />
    <path d="M5 11.2a11 11 0 0 1 3.6-2.1" />
    <path d="M1.4 7.9A16 16 0 0 1 8 4.6" />
    <path d="M22.6 7.9a16 16 0 0 0-9.9-4.1" />
    <path d="M8.6 14.8a6 6 0 0 1 2.3-1.2" />
    <path d="M15.4 14.8a6 6 0 0 0-1.4-.9" />
    <path d="M12 18.6h.01" />
  </>
));

export const IconUsers = icon('IconUsers', (
  <>
    <circle cx="9.2" cy="8.2" r="3.4" />
    <path d="M2.9 19.4a6.3 6.3 0 0 1 12.6 0" />
    <path d="M16 5.2a3.4 3.4 0 0 1 0 6.6" />
    <path d="M17.6 13.8a6.3 6.3 0 0 1 3.5 5.6" />
  </>
));

export const IconLayers = icon('IconLayers', (
  <>
    <path d="m12 3.4 8.4 4.4-8.4 4.4-8.4-4.4z" />
    <path d="m3.6 12.2 8.4 4.4 8.4-4.4" />
    <path d="m3.6 16.4 8.4 4.4 8.4-4.4" />
  </>
));

export const IconList = icon('IconList', (
  <>
    <path d="M8.6 6.4h11.8M8.6 12h11.8M8.6 17.6h11.8" />
    <path d="M4.2 6.4h.01M4.2 12h.01M4.2 17.6h.01" />
  </>
));

export const IconPlusSquare = icon('IconPlusSquare', (
  <>
    <rect x="3.6" y="3.6" width="16.8" height="16.8" rx="2.4" />
    <path d="M12 8.4v7.2M8.4 12h7.2" />
  </>
));

export const IconUpload = icon('IconUpload', (
  <>
    <path d="M12 15.2V4.8" />
    <path d="m8 8.4 4-4 4 4" />
    <path d="M4.6 16.4v2.2a1.6 1.6 0 0 0 1.6 1.6h11.6a1.6 1.6 0 0 0 1.6-1.6v-2.2" />
  </>
));

export const IconAlert = icon('IconAlert', (
  <>
    <path d="M10.6 4.2 2.9 17.4a1.5 1.5 0 0 0 1.3 2.2h15.6a1.5 1.5 0 0 0 1.3-2.2L13.4 4.2a1.5 1.5 0 0 0-2.8 0" />
    <path d="M12 9.4v4M12 16.6h.01" />
  </>
));

export const IconInfo = icon('IconInfo', (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8.2h.01" />
  </>
));

/* --- registries ------------------------------------------------------------ */

/** Tool id → icon component, in the order TOOLS declares them. */
export const TOOL_ICONS = {
  select: IconSelect,
  hand: IconHand,
  pen: IconPen,
  rect: IconRect,
  ellipse: IconEllipse,
  diamond: IconDiamond,
  cylinder: IconCylinder,
  sticky: IconSticky,
  text: IconText,
  arrow: IconArrow,
  line: IconLine,
  eraser: IconEraser,
};

/** Everything, keyed by name, for `Icons[name]` lookups. */
export const Icons = {
  IconSelect,
  IconHand,
  IconPen,
  IconRect,
  IconEllipse,
  IconDiamond,
  IconCylinder,
  IconSticky,
  IconText,
  IconArrow,
  IconLine,
  IconEraser,
  IconUndo,
  IconRedo,
  IconGrid,
  IconSnap,
  IconZoomIn,
  IconZoomOut,
  IconZoomFit,
  IconHelp,
  IconDownload,
  IconUpload,
  IconPlus,
  IconTrash,
  IconCopy,
  IconLock,
  IconEye,
  IconEyeOff,
  IconChevron,
  IconChevronDown,
  IconClose,
  IconCheck,
  IconShare,
  IconSun,
  IconMoon,
  IconCloud,
  IconWifiOff,
  IconUsers,
  IconLayers,
  IconList,
  IconPlusSquare,
  IconAlert,
  IconInfo,
};

export default Icons;
