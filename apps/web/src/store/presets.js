/**
 * Preset shapes: what the drag-and-drop palette drags onto the canvas.
 *
 * Each preset is `{ id, label, group, keywords, icon, build(box, style) }`.
 * `build` returns a fully-formed, valid element group with ids already
 * assigned — the caller only supplies a drop box and the current style, so
 * the dnd layer never has to know a single field of the element schema. The
 * palette's `data: {preset}` payload is this object, whole.
 *
 * The `assertPresetsValid()` check at the bottom runs `tryValidateElement`
 * over every element every preset builds, in dev only. It is the cheapest
 * possible guard against shipping a preset the server will reject with a
 * 400 — which is a miserable way to discover a typo in a fill colour.
 */

import { nanoid } from 'nanoid';
import { tryValidateElement } from '@whiteboard/shared';

/** Short, URL-safe id. Same generator the store uses for element ids. */
const id = () => nanoid(10);

/** Merge the user's current style into an element, with per-element overrides. */
const paint = (style, overrides = {}) => ({
  stroke: style.stroke,
  fill: style.fill ?? 'none',
  strokeWidth: style.strokeWidth ?? 2,
  strokeStyle: style.strokeStyle ?? 'solid',
  ...overrides,
});

const box = (x, y, w, h) => ({ x, y, w: Math.max(0, w), h: Math.max(0, h) });

/**
 * 24x24 viewBox, stroke-based, `fill="none"`, round caps and joins. These
 * are path data strings rather than components so the palette carries no
 * icon dependency and renders identically in the toolbar and in a dnd
 * preview without a React context.
 */
const ICONS = {
  title: 'M4 7V5h16v2M12 5v14M9 19h6',
  box: 'M4 6h16v12H4z',
  labelBox: 'M4 6h16v12H4zM8 10h8M8 13.5h5',
  diamond: 'M12 3l9 9-9 9-9-9z',
  database: 'M4 6c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 3-8-1.34-8-3zM4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3',
  process: 'M3 5h7v5H3zM14 5h7v5h-7zM8.5 14h7v5h-7zM10 7.5h4M6.5 10v2.5h11V10M12 12.5V14',
  sticky: 'M4 4h16v10l-6 6H4zM14 20v-6h6',
  callout: 'M4 4h16v11H9l-5 5zM8 8h8M8 11.5h5',
  person: 'M12 4.5a3.25 3.25 0 110 6.5 3.25 3.25 0 010-6.5zM4.5 20c0-3.6 3.36-6 7.5-6s7.5 2.4 7.5 6',
  note: 'M5 3.5h10l4 4V20.5H5zM15 3.5v4h4M8 12h8M8 15.5h5',
  frame: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M9 12h6',
  arrow: 'M4 12h15M14 7l5 5-5 5',
  section: 'M3 6h18M6 11h11M6 15.5h7',
  pen: 'M4 19.5l1-4.5L16 4l4 4L9 19z',
  line: 'M4 19L20 5M20 5h-4.5M20 5v4.5',
};

/**
 * A drop box normalised to something usable, so a tiny or inverted drag
 * rectangle still produces a shape with a positive, clickable size.
 */
function rect(x, y, w, h) {
  return box(x, y, Math.max(w, 24), Math.max(h, 24));
}

/**
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} label
 * @property {string} group
 * @property {string[]} keywords   search terms for the palette filter
 * @property {string} icon         SVG path data, 24x24, stroke-based
 * @property {(box: {x:number,y:number,w:number,h:number}, style: object) => object[]} build
 */

/** @type {Preset[]} */
export const PRESETS = [
  // ---------------------------------------------------------------- basics
  {
    id: 'title',
    label: 'Title',
    group: 'Basics',
    keywords: ['heading', 'h1', 'text', 'label'],
    icon: ICONS.title,
    build: (b, style) => [
      { id: id(), type: 'text', ...rect(b.x, b.y, b.w * 1.6, 44), text: 'Title', fontSize: 32, stroke: 'none', fill: style.stroke, align: 'left' },
    ],
  },
  {
    id: 'box',
    label: 'Box',
    group: 'Basics',
    keywords: ['rect', 'rectangle', 'square', 'shape'],
    icon: ICONS.box,
    build: (b, style) => [{ id: id(), type: 'rect', ...rect(b.x, b.y, b.w, b.h), ...paint(style) }],
  },
  {
    id: 'label-box',
    label: 'Labelled box',
    group: 'Basics',
    keywords: ['process', 'step', 'task', 'node', 'activity'],
    icon: ICONS.labelBox,
    build: (b, style) => [
      { id: id(), type: 'rect', ...rect(b.x, b.y, b.w, b.h), ...paint(style, { fill: '#ffffff' }) },
    ],
  },
  {
    id: 'section',
    label: 'Section header',
    group: 'Basics',
    keywords: ['heading', 'divider', 'title', 'band'],
    icon: ICONS.section,
    build: (b, style) => [
      { id: id(), type: 'text', ...box(b.x, b.y, Math.max(b.w, 160), 30), text: 'Section', fontSize: 20, stroke: 'none', fill: style.stroke, align: 'left' },
    ],
  },

  // ---------------------------------------------------------------- shapes
  {
    id: 'diamond',
    label: 'Decision',
    group: 'Shapes',
    keywords: ['decision', 'branch', 'condition', 'choice', 'flowchart'],
    icon: ICONS.diamond,
    build: (b, style) => [{ id: id(), type: 'diamond', ...rect(b.x, b.y, b.w, b.h), ...paint(style, { fill: '#ffffff' }) }],
  },
  {
    id: 'database',
    label: 'Database',
    group: 'Shapes',
    keywords: ['db', 'data', 'store', 'cylinder', 'sql'],
    icon: ICONS.database,
    build: (b, style) => [{ id: id(), type: 'cylinder', ...rect(b.x, b.y, b.w, b.h), ...paint(style, { fill: '#ffffff' }) }],
  },
  {
    id: 'frame',
    label: 'Container',
    group: 'Shapes',
    keywords: ['frame', 'group', 'boundary', 'region', 'lane', 'swimlane'],
    icon: ICONS.frame,
    build: (b, style) => [
      { id: id(), type: 'rect', ...rect(b.x, b.y, b.w, b.h), ...paint(style, { fill: 'none', strokeStyle: 'dashed' }) },
    ],
  },

  // ------------------------------------------------------------ annotations
  {
    id: 'sticky',
    label: 'Sticky note',
    group: 'Notes',
    keywords: ['note', 'post-it', 'todo', 'reminder', 'yellow'],
    icon: ICONS.sticky,
    build: (b, style) => [
      {
        id: id(),
        type: 'sticky',
        ...rect(b.x, b.y, b.w, b.h),
        label: 'Note',
        fill: style.stickyFill ?? '#fde68a',
        stroke: style.stroke,
        strokeWidth: 1,
      },
    ],
  },
  {
    id: 'callout',
    label: 'Callout',
    group: 'Notes',
    keywords: ['speech', 'bubble', 'comment', 'message', 'chat'],
    icon: ICONS.callout,
    build: (b, style) => [
      { id: id(), type: 'sticky', ...rect(b.x, b.y, b.w, b.h), label: 'Callout', fill: '#dbeafe', stroke: style.stroke, strokeWidth: 1 },
    ],
  },
  {
    id: 'note',
    label: 'Text note',
    group: 'Notes',
    keywords: ['text', 'paragraph', 'body', 'caption'],
    icon: ICONS.note,
    build: (b, style) => [
      { id: id(), type: 'text', ...box(b.x, b.y, Math.max(b.w, 180), 60), text: 'Text', fontSize: 16, stroke: 'none', fill: style.stroke, align: 'left' },
    ],
  },

  // -------------------------------------------------------------- flow-ish
  {
    id: 'person',
    label: 'Person',
    group: 'People',
    keywords: ['actor', 'user', 'role', 'participant', 'sticky figure'],
    icon: ICONS.person,
    build: (b, style) => [
      { id: id(), type: 'sticky', ...box(b.x + b.w * 0.12, b.y, b.w * 0.76, b.h * 0.34), label: 'Person', fill: '#bbf7d0', stroke: style.stroke, strokeWidth: 1 },
      { id: id(), type: 'sticky', ...box(b.x + b.w * 0.12, b.y + b.h * 0.42, b.w * 0.76, b.h * 0.58), label: 'Role', fill: '#bbf7d0', stroke: style.stroke, strokeWidth: 1 },
    ],
  },
  {
    id: 'arrow',
    label: 'Arrow',
    group: 'Connectors',
    keywords: ['arrow', 'connector', 'link', 'flow', 'direction', 'edge'],
    icon: ICONS.arrow,
    build: (b, style) => {
      const r = rect(b.x, b.y, b.w, b.h);
      return [
        {
          id: id(),
          type: 'arrow',
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          points: [
            { x: r.x, y: r.y + r.h / 2 },
            { x: r.x + r.w, y: r.y + r.h / 2 },
          ],
          ...paint(style, { fill: 'none' }),
        },
      ];
    },
  },
  {
    id: 'line',
    label: 'Line',
    group: 'Connectors',
    keywords: ['line', 'segment', 'edge', 'connector'],
    icon: ICONS.line,
    build: (b, style) => {
      const r = rect(b.x, b.y, b.w, b.h);
      return [
        {
          id: id(),
          type: 'line',
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          points: [
            { x: r.x, y: r.y + r.h },
            { x: r.x + r.w, y: r.y },
          ],
          ...paint(style, { fill: 'none' }),
        },
      ];
    },
  },
  {
    id: 'process',
    label: 'Process',
    group: 'Connectors',
    keywords: ['flow', 'steps', 'pipeline', 'workflow', 'diagram', 'sequence'],
    icon: ICONS.process,
    // Three boxes in a row, joined by two arrows. The arrows anchor to the
    // boxes by id, so dragging a box drags its connectors with it.
    build: (b, style) => {
      const r = rect(b.x, b.y, Math.max(b.w, 320), 90);
      const w = (r.w - 80) / 3;
      const y = r.y;
      const ids = [id(), id(), id()];
      const els = [
        { id: ids[0], type: 'rect', ...box(r.x, y, w, 60), ...paint(style, { fill: '#ffffff' }) },
        { id: ids[1], type: 'rect', ...box(r.x + w + 40, y, w, 60), ...paint(style, { fill: '#ffffff' }) },
        { id: ids[2], type: 'rect', ...box(r.x + (w + 40) * 2, y, w, 60), ...paint(style, { fill: '#ffffff' }) },
        {
          id: id(),
          type: 'arrow',
          x: r.x + w,
          y: y + 30,
          w: 40,
          h: 0,
          points: [
            { x: r.x + w, y: y + 30 },
            { x: r.x + w + 40, y: y + 30 },
          ],
          startId: ids[0],
          endId: ids[1],
          ...paint(style, { fill: 'none' }),
        },
        {
          id: id(),
          type: 'arrow',
          x: r.x + w + 40 + w,
          y: y + 30,
          w: 40,
          h: 0,
          points: [
            { x: r.x + w + 40 + w, y: y + 30 },
            { x: r.x + (w + 40) * 2, y: y + 30 },
          ],
          startId: ids[1],
          endId: ids[2],
          ...paint(style, { fill: 'none' }),
        },
      ];
      return els;
    },
  },
];

/** Preset by id, for keyboard shortcuts and the board switcher's "insert". */
export const PRESET_BY_ID = Object.freeze(
  PRESETS.reduce((acc, p) => {
    acc[p.id] = p;
    return acc;
  }, {}),
);

/** Distinct groups, in first-appearance order, for sectioning the palette. */
export const PRESET_GROUPS = PRESETS.reduce((acc, p) => {
  if (!acc.includes(p.group)) acc.push(p.group);
  return acc;
}, []);

/** Case-insensitive search over label, group and keywords. */
export function searchPresets(query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return PRESETS;
  return PRESETS.filter((p) =>
    [p.label, p.group, ...p.keywords].some((field) => String(field).toLowerCase().includes(q)),
  );
}

/**
 * Build a preset at a board point. `size` is the drag rectangle; the preset
 * decides how to use it. Returns a fresh element group every call, so two
 * drops of the same preset never share ids.
 */
export function buildPreset(preset, point, style, size) {
  if (!preset || typeof preset.build !== 'function') return [];
  const p = point ?? { x: 0, y: 0 };
  const s = size ?? { w: 160, h: 100 };
  const out = preset.build(box(p.x, p.y, s.w, s.h), style ?? {});
  return Array.isArray(out) ? out.filter(Boolean) : [];
}

/**
 * Dev-only assertion: every element every preset builds must satisfy the
 * server's validator. Catches a bad colour literal or a missing required
 * field at module load, instead of as a 400 on the user's first drop.
 *
 * @returns {{ok: boolean, failures: {preset: string, error: string}[]}}
 */
export function assertPresetsValid() {
  const failures = [];
  for (const preset of PRESETS) {
    let elements;
    try {
      elements = preset.build(box(0, 0, 160, 100), { ...DEFAULT_STYLE });
    } catch (err) {
      failures.push({ preset: preset.id, error: `build() threw: ${err.message}` });
      continue;
    }
    for (const el of elements) {
      const res = tryValidateElement(el);
      if (!res.valid) failures.push({ preset: preset.id, error: `${el.type ?? '?'}: ${res.error}` });
    }
  }
  return { ok: failures.length === 0, failures };
}

const DEFAULT_STYLE = {
  stroke: '#1f2937',
  fill: 'none',
  strokeWidth: 2,
  strokeStyle: 'solid',
  stickyFill: '#fde68a',
};

// Run once at module load, loudly, but only in dev. A broken preset is a
// bug that should never reach a user, and never should fail a production
// bundle over a console warning.
if (typeof import.meta !== 'undefined' && import.meta.env?.DEV && typeof console !== 'undefined') {
  const { ok, failures } = assertPresetsValid();
  if (!ok) {
    console.warn('[presets] invalid preset elements:', failures);
  }
}
