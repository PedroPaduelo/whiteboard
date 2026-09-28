/**
 * Icons.jsx — the interface's icon set: clean 24×24 stroke icons in the
 * spirit of Excalidraw's (round caps and joins, `currentColor`, no fills
 * unless the glyph IS a fill), so they inherit the button colour in both
 * themes and the active-tool violet.
 *
 * Each icon is a component `<IconName size={20} />`. `ICONS` maps the names
 * used by editor/tools.js TOOLBAR (`icon: 'Square'`) to components, and
 * `<Icon name="Square" />` renders by name.
 */

import React from 'react';

function make(name, children, { strokeWidth = 1.75 } = {}) {
  function Icon({ size = 20, strokeWidth: sw = strokeWidth, className, style, title }) {
    return (
      <svg
        className={className}
        style={style}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={title ? undefined : 'true'}
        role={title ? 'img' : undefined}
        focusable="false"
      >
        {title ? <title>{title}</title> : null}
        {children}
      </svg>
    );
  }
  Icon.displayName = `Icon${name}`;
  return Icon;
}

const P = (d) => <path d={d} />;

/* --- tools ------------------------------------------------------------------ */

export const IconHand = make('Hand', (
  <>
    {P('M8 13V5.5a1.5 1.5 0 0 1 3 0V12')}
    {P('M11 5.5v-2a1.5 1.5 0 0 1 3 0V12')}
    {P('M14 5.5a1.5 1.5 0 0 1 3 0V12')}
    {P('M17 7.5a1.5 1.5 0 0 1 3 0V16a6 6 0 0 1-6 6h-2 .21a6 6 0 0 1-5.01-2.7l-.2-.3c-.31-.48-1.4-2.39-3.29-5.73a1.5 1.5 0 0 1 .54-2.02 1.87 1.87 0 0 1 2.28.28L8 13')}
  </>
));

export const IconPointer = make('Pointer', (
  <>
    {P('M7.9 17.56a1.2 1.2 0 0 0 2.23.31l2.09-3.09 4.9 4.9a1.07 1.07 0 0 0 1.51 0l1.05-1.04a1.07 1.07 0 0 0 0-1.51l-4.9-4.91 3.1-2.09a1.2 1.2 0 0 0-.3-2.23L4 4z')}
  </>
));

export const IconSquare = make('Square', <rect x="4" y="4" width="16" height="16" rx="2.5" />);

export const IconDiamond = make('Diamond', (
  P('M10.5 20.4l-6.9-6.9c-.78-.78-.78-2.22 0-3l6.9-6.9c.78-.78 2.22-.78 3 0l6.9 6.9c.78.78.78 2.22 0 3l-6.9 6.9c-.78.78-2.22.78-3 0z')
));

export const IconCircle = make('Circle', <circle cx="12" cy="12" r="8.5" />);

export const IconArrowRight = make('ArrowRight', (
  <>
    {P('M5 12h14')}
    {P('M13 6l6 6-6 6')}
  </>
));

export const IconLine = make('Line', P('M5 12h14'));

export const IconPencil = make('Pencil', (
  <>
    {P('M4 20h4L18.5 9.5a2.83 2.83 0 0 0-4-4L4 16v4')}
    {P('M13.5 6.5l4 4')}
  </>
));

export const IconText = make('Text', (
  <>
    {P('M6 5h12')}
    {P('M12 5v14')}
    {P('M10 19h4')}
  </>
));

export const IconImage = make('Image', (
  <>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    {P('M15 8.5h.01')}
    {P('M3.5 16l5-5c.93-.9 2.07-.9 3 0l5 5')}
    {P('M14 14l1-1c.93-.9 2.07-.9 3 0l2.5 2.5')}
  </>
));

export const IconEraser = make('Eraser', (
  <>
    {P('M19 20H8.5l-4.21-4.3a1 1 0 0 1 0-1.41l10-10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41L11.5 20')}
    {P('M18 13.3L11.7 7')}
  </>
));

export const IconSticky = make('Sticky', (
  <>
    {P('M13 20l7-7')}
    {P('M13 20v-6a1 1 0 0 1 1-1h6V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7')}
  </>
));

export const IconCylinder = make('Cylinder', (
  <>
    <ellipse cx="12" cy="6" rx="7.5" ry="2.75" />
    {P('M4.5 6v12c0 1.52 3.36 2.75 7.5 2.75s7.5-1.23 7.5-2.75V6')}
  </>
));

export const IconShapes = make('Shapes', (
  <>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <circle cx="17" cy="7" r="3.5" />
    {P('M7 13.5l3.5 6.5h-7z')}
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </>
));

/* --- chrome ------------------------------------------------------------------- */

export const IconLock = make('Lock', (
  <>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    {P('M11 16a1 1 0 1 0 2 0 1 1 0 0 0-2 0')}
    {P('M8 11V7a4 4 0 1 1 8 0v4')}
  </>
));

export const IconUnlock = make('Unlock', (
  <>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    {P('M11 16a1 1 0 1 0 2 0 1 1 0 0 0-2 0')}
    {P('M8 11V6a4 4 0 0 1 8 0')}
  </>
));

export const IconMenu = make('Menu', (
  <>
    {P('M4 6h16')}
    {P('M4 12h16')}
    {P('M4 18h16')}
  </>
));

export const IconLibrary = make('Library', (
  <>
    <rect x="4" y="4" width="4.5" height="16" rx="1" />
    <rect x="8.5" y="4" width="4.5" height="16" rx="1" />
    {P('M4 8h4.5')}
    {P('M8.5 16H13')}
    {P('M13.8 4.56l2.18-.53c.56-.14 1.13.19 1.28.73l3.7 13.42a1.02 1.02 0 0 1-.64 1.22l-.13.04-2.18.53c-.56.14-1.13-.19-1.28-.73L13.03 5.82a1.02 1.02 0 0 1 .64-1.22z')}
  </>
));

export const IconShare = make('Share', (
  <>
    <circle cx="6" cy="12" r="2.75" />
    <circle cx="18" cy="6" r="2.75" />
    <circle cx="18" cy="18" r="2.75" />
    {P('M8.5 10.75l7-3.5')}
    {P('M8.5 13.25l7 3.5')}
  </>
));

export const IconHelp = make('Help', (
  <>
    <circle cx="12" cy="12" r="9" />
    {P('M12 17v.01')}
    {P('M12 13.5a2 2 0 0 0 .91-3.78 1.98 1.98 0 0 0-2.41.48')}
  </>
));

export const IconZoomIn = make('ZoomIn', (
  <>
    {P('M12 5v14')}
    {P('M5 12h14')}
  </>
));

export const IconZoomOut = make('ZoomOut', P('M5 12h14'));

export const IconUndo = make('Undo', (
  <>
    {P('M9 14l-4-4 4-4')}
    {P('M5 10h11a4 4 0 1 1 0 8h-1')}
  </>
));

export const IconRedo = make('Redo', (
  <>
    {P('M15 14l4-4-4-4')}
    {P('M19 10H8a4 4 0 1 0 0 8h1')}
  </>
));

export const IconTrash = make('Trash', (
  <>
    {P('M4 7h16')}
    {P('M10 11v6')}
    {P('M14 11v6')}
    {P('M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12')}
    {P('M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3')}
  </>
));

export const IconDuplicate = make('Duplicate', (
  <>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    {P('M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2')}
  </>
));

export const IconGroup = make('Group', (
  <>
    {P('M3 7V5a2 2 0 0 1 2-2h2')}
    {P('M17 3h2a2 2 0 0 1 2 2v2')}
    {P('M21 17v2a2 2 0 0 1-2 2h-2')}
    {P('M7 21H5a2 2 0 0 1-2-2v-2')}
    <rect x="7" y="7" width="6" height="6" rx="1" />
    <rect x="11" y="11" width="6" height="6" rx="1" />
  </>
));

export const IconUngroup = make('Ungroup', (
  <>
    <rect x="4" y="4" width="7" height="7" rx="1" />
    <rect x="13" y="13" width="7" height="7" rx="1" />
    {P('M14 4h5a1 1 0 0 1 1 1v5')}
    {P('M4 14v5a1 1 0 0 0 1 1h5')}
  </>
));

export const IconBringForward = make('BringForward', (
  <>
    {P('M12 19V5')}
    {P('M7 10l5-5 5 5')}
  </>
));

export const IconSendBackward = make('SendBackward', (
  <>
    {P('M12 5v14')}
    {P('M7 14l5 5 5-5')}
  </>
));

export const IconBringToFront = make('BringToFront', (
  <>
    {P('M5 4h14')}
    {P('M12 20V9')}
    {P('M7.5 13.5L12 9l4.5 4.5')}
  </>
));

export const IconSendToBack = make('SendToBack', (
  <>
    {P('M5 20h14')}
    {P('M12 4v11')}
    {P('M7.5 10.5L12 15l4.5-4.5')}
  </>
));

/* --- style glyphs ------------------------------------------------------------- */

export const IconStrokeSolid = make('StrokeSolid', P('M4 12h16'), { strokeWidth: 2 });
export const IconStrokeDashed = make('StrokeDashed', (
  <>
    {P('M4 12h3')}
    {P('M10.5 12h3')}
    {P('M17 12h3')}
  </>
), { strokeWidth: 2 });
export const IconStrokeDotted = make('StrokeDotted', (
  <>
    {P('M4 12h.01')}
    {P('M8 12h.01')}
    {P('M12 12h.01')}
    {P('M16 12h.01')}
    {P('M20 12h.01')}
  </>
), { strokeWidth: 2.5 });

export const IconWidthThin = make('WidthThin', P('M4 12h16'), { strokeWidth: 1.25 });
export const IconWidthBold = make('WidthBold', P('M4 12h16'), { strokeWidth: 2.5 });
export const IconWidthExtraBold = make('WidthExtraBold', P('M4 12h16'), { strokeWidth: 4 });

export const IconFillHachure = make('FillHachure', (
  <>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    {P('M4 12l8-8')}
    {P('M4 20L20 4')}
    {P('M12 20l8-8')}
  </>
));
export const IconFillCrossHatch = make('FillCrossHatch', (
  <>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    {P('M4 12l8-8')}
    {P('M4 20L20 4')}
    {P('M12 20l8-8')}
    {P('M12 4l8 8')}
    {P('M4 4l16 16')}
    {P('M4 12l8 8')}
  </>
));
export const IconFillSolid = make('FillSolid', <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" />);
export const IconFillZigzag = make('FillZigzag', (
  <>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    {P('M6 9l3 3 3-3 3 3 3-3')}
    {P('M6 14l3 3 3-3 3 3 3-3')}
  </>
));

export const IconSloppyArchitect = make('SloppyArchitect', P('M3 17c4-9 14-9 18 0'));
export const IconSloppyArtist = make('SloppyArtist', (
  <>
    {P('M3 17.5c3.5-9.5 14-9.5 18-.5')}
    {P('M3.5 16c4-8.5 13.5-9 17 1.5')}
  </>
));
export const IconSloppyCartoonist = make('SloppyCartoonist', (
  <>
    {P('M3 18c1-2.5 2.2-5 4-6.4 1.3-1 2.3.6 3.4-.9 1.2-1.7 2.6-2.9 4.2-1.8 1.4 1 1.3 2.8 2.8 3.4 1.5.6 2.6 2.7 3.6 5.2')}
    {P('M4 16.2c1.5-2.8 2.4-4.6 4.4-5.9 1.7-1.1 2.6.8 4-1.2 1.2-1.6 3.4-1.6 4.4.2.8 1.6 2 2.4 3.2 3.5')}
  </>
));

export const IconEdgeSharp = make('EdgeSharp', P('M5 19V5h14'));
export const IconEdgeRound = make('EdgeRound', P('M5 19v-8a6 6 0 0 1 6-6h8'));

/** Arrowheads, drawn pointing right (flip for the start end). */
export const IconArrowheadNone = make('ArrowheadNone', P('M4 12h16'));
export const IconArrowheadArrow = make('ArrowheadArrow', (
  <>
    {P('M4 12h16')}
    {P('M14 6l6 6-6 6')}
  </>
));
export const IconArrowheadTriangle = make('ArrowheadTriangle', (
  <>
    {P('M4 12h10')}
    <path d="M13 6.5l7 5.5-7 5.5z" fill="currentColor" />
  </>
));
export const IconArrowheadBar = make('ArrowheadBar', (
  <>
    {P('M4 12h16')}
    {P('M20 6v12')}
  </>
));
export const IconArrowheadDot = make('ArrowheadDot', (
  <>
    {P('M4 12h11')}
    <circle cx="17" cy="12" r="3" fill="currentColor" />
  </>
));

export const IconAlignLeft = make('AlignLeft', (
  <>
    {P('M4 6h16')}
    {P('M4 12h10')}
    {P('M4 18h14')}
  </>
));
export const IconAlignCenter = make('AlignCenter', (
  <>
    {P('M4 6h16')}
    {P('M7 12h10')}
    {P('M5 18h14')}
  </>
));
export const IconAlignRight = make('AlignRight', (
  <>
    {P('M4 6h16')}
    {P('M10 12h10')}
    {P('M6 18h14')}
  </>
));

export const IconFontHand = make('FontHand', (
  <>
    {P('M4 17c1.5-3 2.5-10 4.5-10 1.8 0 .2 10 2.2 10 1.7 0 2-6 3.8-6 1.5 0 .7 5 2.5 5 1.2 0 1.8-1.8 3-2.5')}
    {P('M4 20.5h16')}
  </>
));
export const IconFontNormal = make('FontNormal', (
  <>
    {P('M6 20L12 4l6 16')}
    {P('M8.25 14h7.5')}
  </>
));
export const IconFontCode = make('FontCode', (
  <>
    {P('M7 8l-4 4 4 4')}
    {P('M17 8l4 4-4 4')}
    {P('M14 4l-4 16')}
  </>
));

/* --- general ------------------------------------------------------------------ */

export const IconSun = make('Sun', (
  <>
    <circle cx="12" cy="12" r="4" />
    {P('M3 12h1M12 3v1M20 12h1M12 20v1M5.6 5.6l.7.7M18.4 5.6l-.7.7M17.7 17.7l.7.7M6.3 17.7l-.7.7')}
  </>
));
export const IconMoon = make('Moon', P('M12 3h.39a7.5 7.5 0 0 0 7.92 12.45A9 9 0 1 1 12 3z'));

export const IconDownload = make('Download', (
  <>
    {P('M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2')}
    {P('M7 11l5 5 5-5')}
    {P('M12 4v12')}
  </>
));
export const IconUpload = make('Upload', (
  <>
    {P('M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2')}
    {P('M7 9l5-5 5 5')}
    {P('M12 4v12')}
  </>
));
export const IconFolder = make('Folder', P('M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2'));
export const IconSave = make('Save', (
  <>
    {P('M6 4h10l4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2')}
    <circle cx="12" cy="14" r="2" />
    {P('M14 4v4H8V4')}
  </>
));
export const IconExportImage = make('ExportImage', (
  <>
    {P('M15 8h.01')}
    {P('M12.5 21H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v6.5')}
    {P('M3 16l5-5c.93-.9 2.07-.9 3 0l3.5 3.5')}
    {P('M19 16v6')}
    {P('M22 19l-3 3-3-3')}
  </>
));
export const IconLink = make('Link', (
  <>
    {P('M9 15l6-6')}
    {P('M11 6l.46-.54a5 5 0 0 1 7.07 7.08l-.53.46')}
    {P('M13 18l-.4.53a5.07 5.07 0 0 1-7.12 0 4.97 4.97 0 0 1 0-7.07l.52-.46')}
  </>
));
export const IconGrid = make('Grid', (
  <>
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    {P('M4 9.33h16M4 14.67h16M9.33 4v16M14.67 4v16')}
  </>
));
export const IconUsers = make('Users', (
  <>
    <circle cx="9" cy="7" r="4" />
    {P('M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2')}
    {P('M16 3.13a4 4 0 0 1 0 7.75')}
    {P('M21 21v-2a4 4 0 0 0-3-3.85')}
  </>
));
export const IconUser = make('User', (
  <>
    <circle cx="12" cy="8" r="4" />
    {P('M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2')}
  </>
));
export const IconBoards = make('Boards', (
  <>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.25" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.25" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.25" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.25" />
  </>
));
export const IconClose = make('Close', (
  <>
    {P('M18 6L6 18')}
    {P('M6 6l12 12')}
  </>
));
export const IconChevronDown = make('ChevronDown', P('M6 9l6 6 6-6'));
export const IconChevronUp = make('ChevronUp', P('M6 15l6-6 6 6'));
export const IconChevronRight = make('ChevronRight', P('M9 6l6 6-6 6'));
export const IconCheck = make('Check', P('M5 12l5 5L20 7'));
export const IconAlert = make('Alert', (
  <>
    <circle cx="12" cy="12" r="9" />
    {P('M12 8v4')}
    {P('M12 16h.01')}
  </>
));
export const IconInfo = make('Info', (
  <>
    <circle cx="12" cy="12" r="9" />
    {P('M12 8h.01')}
    {P('M11 12h1v4h1')}
  </>
));
export const IconPlus = make('Plus', (
  <>
    {P('M12 5v14')}
    {P('M5 12h14')}
  </>
));
export const IconClipboard = make('Clipboard', (
  <>
    {P('M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2')}
    <rect x="9" y="3" width="6" height="4" rx="1.5" />
  </>
));
export const IconCut = make('Cut', (
  <>
    <circle cx="6" cy="7" r="3" />
    <circle cx="6" cy="17" r="3" />
    {P('M8.6 8.6L19 19')}
    {P('M8.6 15.4L19 5')}
  </>
));
export const IconSelectAll = make('SelectAll', (
  <>
    {P('M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2')}
    {P('M10 4h4M4 10v4M20 10v4M10 20h4')}
  </>
));
export const IconFit = make('Fit', (
  <>
    {P('M4 8V6a2 2 0 0 1 2-2h2')}
    {P('M4 16v2a2 2 0 0 0 2 2h2')}
    {P('M16 4h2a2 2 0 0 1 2 2v2')}
    {P('M16 20h2a2 2 0 0 0 2-2v-2')}
    <rect x="8.5" y="8.5" width="7" height="7" rx="1" />
  </>
));
export const IconEdit = make('Edit', (
  <>
    {P('M7 7H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-1')}
    {P('M20.39 6.59a2.1 2.1 0 0 0-2.98-2.98L9 12v3h3z')}
    {P('M16 5l3 3')}
  </>
));
export const IconPalette = make('Palette', (
  <>
    {P('M12 21a9 9 0 0 1 0-18c4.97 0 9 3.58 9 8a5 5 0 0 1-5 5h-2.5a1.5 1.5 0 0 0-1 2.62A1.5 1.5 0 0 1 12 21')}
    {P('M8 10.5h.01M12 7.5h.01M16 10.5h.01')}
  </>
));
export const IconSearch = make('Search', (
  <>
    <circle cx="10" cy="10" r="6.5" />
    {P('M20 20l-5.2-5.2')}
  </>
));

/** Components by the names editor/tools.js uses (`icon: 'Square'`). */
export const ICONS = Object.freeze({
  Hand: IconHand,
  Pointer: IconPointer,
  Square: IconSquare,
  Diamond: IconDiamond,
  Circle: IconCircle,
  ArrowRight: IconArrowRight,
  Line: IconLine,
  Pencil: IconPencil,
  Text: IconText,
  Image: IconImage,
  Eraser: IconEraser,
  Sticky: IconSticky,
  Cylinder: IconCylinder,
  Shapes: IconShapes,
  Lock: IconLock,
  Unlock: IconUnlock,
  Library: IconLibrary,
});

/** Render an icon by name; unknown names render nothing rather than crash. */
export function Icon({ name, ...rest }) {
  const C = ICONS[name];
  return C ? <C {...rest} /> : null;
}

export default ICONS;
