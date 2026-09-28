/**
 * presets.js — the shape library: ready-made element groups the Library panel
 * places on the board (click → viewport centre, drag → drop point).
 *
 * Every element is built with `createElement` from editor/elements.js, so a
 * preset is exactly what a hand-drawn element would be: validated by the same
 * validator the server runs, with a roughjs `seed`, roughness, fill style,
 * roundness and font family — shapes carry their text in `label` (no separate
 * text elements glued on top), connectors are bound with `startId`/`endId`.
 *
 * A preset is `{ id, group, label, keywords, build(style) }`. `build` lays the
 * elements out around the origin; `buildPreset` re-centres them on the target
 * point and settles connector ends with the shared `resolveConnectors`, so a
 * placed flow already has its arrows sitting on the box outlines. Ids and
 * seeds are fresh on every call: two drops never share an id.
 */

import { boundsOfPoints, resolveConnectors, tryValidateElement } from '@whiteboard/shared';
import { createElement, newId, hasPoints } from '../editor/elements.js';
import { commonBounds } from '../editor/handles.js';
import { DEFAULT_STYLE, FONT_SIZES, STICKY_SIZE } from '../editor/constants.js';
import { t } from '../ui/strings.js';

const L = t.library.items;
const C = t.library.content;

/** Shapes with a label: `createElement` plus the text. */
const shape = (type, x, y, w, h, style, label, extra = {}) =>
  createElement(type, { x, y, w, h }, style, label ? { label, ...extra } : extra);

const text = (x, y, value, style, extra = {}) => createElement('text', { x, y, text: value }, style, extra);

const connector = (type, points, style, extra = {}) => createElement(type, { points }, style, extra);

/**
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} group     key of t.library.groups
 * @property {string} label
 * @property {string[]} keywords  search terms (pt-BR and en)
 * @property {(style: object) => object[]} build  elements around the origin
 */

/** @type {Preset[]} */
export const PRESETS = [
  /* --- basics ------------------------------------------------------------ */
  {
    id: 'title',
    group: 'basic',
    label: L.title,
    keywords: ['titulo', 'cabeçalho', 'heading', 'title', 'texto'],
    build: (style) => [text(0, 0, C.title, { ...style, fontSize: FONT_SIZES.XL })],
  },
  {
    id: 'text',
    group: 'basic',
    label: L.text,
    keywords: ['texto', 'parágrafo', 'text', 'label'],
    build: (style) => [text(0, 0, C.text, style)],
  },

  /* --- shapes ------------------------------------------------------------- */
  {
    id: 'box',
    group: 'shapes',
    label: L.box,
    keywords: ['caixa', 'retângulo', 'etapa', 'box', 'rect', 'process'],
    build: (style) => [shape('rect', 0, 0, 160, 80, style, C.box)],
  },
  {
    id: 'decision',
    group: 'shapes',
    label: L.decision,
    keywords: ['decisão', 'losango', 'condição', 'se', 'decision', 'diamond', 'if'],
    build: (style) => [shape('diamond', 0, 0, 220, 130, style, C.decision)],
  },
  {
    id: 'terminal',
    group: 'shapes',
    label: L.terminal,
    keywords: ['início', 'fim', 'elipse', 'oval', 'start', 'end', 'ellipse'],
    build: (style) => [shape('ellipse', 0, 0, 150, 70, style, C.terminal)],
  },
  {
    id: 'database',
    group: 'shapes',
    label: L.database,
    keywords: ['banco', 'dados', 'cilindro', 'database', 'db', 'sql'],
    build: (style) => [shape('cylinder', 0, 0, 120, 110, style, C.database)],
  },
  {
    id: 'container',
    group: 'shapes',
    label: L.container,
    keywords: ['contêiner', 'grupo', 'moldura', 'área', 'frame', 'group', 'container'],
    build: (style) => {
      const groupId = newId();
      return [
        shape('rect', 0, 0, 320, 220, { ...style, fill: 'none', strokeStyle: 'dashed' }, '', { groupId }),
        text(14, 12, C.container, { ...style, fontSize: FONT_SIZES.S, align: 'left' }, { groupId }),
      ];
    },
  },

  /* --- notes --------------------------------------------------------------- */
  {
    id: 'sticky',
    group: 'notes',
    label: L.sticky,
    keywords: ['nota', 'adesiva', 'post-it', 'lembrete', 'sticky', 'note'],
    build: (style) => [createElement('sticky', { x: 0, y: 0, w: STICKY_SIZE.w, h: STICKY_SIZE.h }, style, { label: C.sticky })],
  },

  /* --- connectors ------------------------------------------------------- */
  {
    id: 'arrow',
    group: 'connectors',
    label: L.arrow,
    keywords: ['seta', 'conector', 'ligação', 'arrow', 'connector'],
    build: (style) => [connector('arrow', [{ x: 0, y: 0 }, { x: 180, y: 0 }], { ...style, endArrowhead: style.endArrowhead === 'none' ? 'arrow' : style.endArrowhead })],
  },
  {
    id: 'line',
    group: 'connectors',
    label: L.line,
    keywords: ['linha', 'reta', 'line', 'segment'],
    build: (style) => [connector('line', [{ x: 0, y: 0 }, { x: 180, y: 0 }], style)],
  },

  /* --- diagrams ------------------------------------------------------------ */
  {
    id: 'process',
    group: 'diagrams',
    label: L.process,
    keywords: ['processo', 'fluxo', 'etapas', 'pipeline', 'flow', 'steps'],
    build: (style) => {
      const w = 140;
      const h = 70;
      const gap = 70;
      const boxes = [C.step1, C.step2, C.step3].map((label, i) => shape('rect', i * (w + gap), 0, w, h, style, label));
      const arrows = [0, 1].map((i) =>
        connector(
          'arrow',
          [
            { x: i * (w + gap) + w, y: h / 2 },
            { x: (i + 1) * (w + gap), y: h / 2 },
          ],
          { ...style, endArrowhead: style.endArrowhead === 'none' ? 'arrow' : style.endArrowhead },
          { startId: boxes[i].id, endId: boxes[i + 1].id },
        ),
      );
      return [...boxes, ...arrows];
    },
  },
  {
    id: 'yes-no',
    group: 'diagrams',
    label: L.yesNo,
    keywords: ['sim', 'não', 'decisão', 'ramificação', 'yes', 'no', 'branch'],
    build: (style) => {
      const head = { ...style, endArrowhead: style.endArrowhead === 'none' ? 'arrow' : style.endArrowhead };
      const q = shape('diamond', 0, 0, 220, 130, style, C.decision);
      const yes = shape('rect', 300, 35, 130, 60, style, C.yes);
      const no = shape('rect', 45, 210, 130, 60, style, C.no);
      return [
        q,
        yes,
        no,
        connector('arrow', [{ x: 220, y: 65 }, { x: 300, y: 65 }], head, { startId: q.id, endId: yes.id }),
        connector('arrow', [{ x: 110, y: 130 }, { x: 110, y: 210 }], head, { startId: q.id, endId: no.id }),
      ];
    },
  },
  {
    id: 'person',
    group: 'diagrams',
    label: L.person,
    keywords: ['pessoa', 'ator', 'usuário', 'boneco', 'person', 'actor', 'user'],
    build: (style) => {
      const groupId = newId();
      const ink = { ...style, fill: 'none', roundness: 'sharp', startArrowhead: 'none', endArrowhead: 'none' };
      const g = { groupId };
      const caption = text(0, 124, C.person, { ...style, fontSize: FONT_SIZES.S, align: 'left' }, g);
      // Centre the caption under the figure (figure spans x 12..68).
      const cap = { ...caption, x: 40 - caption.w / 2 };
      return [
        createElement('ellipse', { x: 24, y: 0, w: 32, h: 32 }, ink, g),
        connector('line', [{ x: 40, y: 32 }, { x: 40, y: 78 }], ink, g),
        connector('line', [{ x: 14, y: 50 }, { x: 66, y: 50 }], ink, g),
        connector('line', [{ x: 16, y: 114 }, { x: 40, y: 78 }, { x: 64, y: 114 }], ink, g),
        cap,
      ];
    },
  },
];

/** Preset by id. */
export const PRESET_BY_ID = Object.freeze(Object.fromEntries(PRESETS.map((p) => [p.id, p])));

/** Group keys in first-appearance order, for sectioning the library. */
export const PRESET_GROUPS = PRESETS.reduce((acc, p) => {
  if (!acc.includes(p.group)) acc.push(p.group);
  return acc;
}, []);

/** Accent-insensitive, case-insensitive search over label, group name and keywords. */
export function searchPresets(query) {
  const fold = (s) =>
    String(s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  const q = fold(query).trim();
  if (!q) return PRESETS;
  return PRESETS.filter((p) => [p.label, t.library.groups[p.group], ...p.keywords].some((f) => fold(f).includes(q)));
}

/** Translate elements by (dx, dy): boxes move x/y, polylines move points. */
function translate(elements, dx, dy) {
  return elements.map((el) => {
    if (hasPoints(el)) {
      const points = el.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      return { ...el, points, ...boundsOfPoints(points) };
    }
    return { ...el, x: el.x + dx, y: el.y + dy };
  });
}

/**
 * Build a preset centred on a board point, in the given style.
 *
 * @param {Preset} preset
 * @param {{x:number, y:number}} [point]  board units; the centre of the result
 * @param {object} [style]                usually `store.style`
 * @returns {object[]} fresh, validated elements (not yet in the store)
 */
export function buildPreset(preset, point, style) {
  if (!preset || typeof preset.build !== 'function') return [];
  const at = point ?? { x: 0, y: 0 };
  const built = (preset.build({ ...DEFAULT_STYLE, ...(style ?? {}) }) ?? []).filter(Boolean);
  if (!built.length) return [];
  const b = commonBounds(built);
  const moved = translate(built, Math.round(at.x - (b.x + b.w / 2)), Math.round(at.y - (b.y + b.h / 2)));
  // Settle bound connector ends on the shape outlines (idempotent).
  return resolveConnectors(moved);
}

/**
 * Every element every preset builds must satisfy the server's validator.
 * @returns {{ok: boolean, failures: {preset: string, error: string}[]}}
 */
export function assertPresetsValid(style = DEFAULT_STYLE) {
  const failures = [];
  for (const preset of PRESETS) {
    let elements;
    try {
      elements = buildPreset(preset, { x: 0, y: 0 }, style);
    } catch (err) {
      failures.push({ preset: preset.id, error: `build() threw: ${err.message}` });
      continue;
    }
    if (!elements.length) failures.push({ preset: preset.id, error: 'built nothing' });
    for (const el of elements) {
      const res = tryValidateElement(el);
      if (!res.valid) failures.push({ preset: preset.id, error: `${el.type ?? '?'}: ${res.error}` });
    }
  }
  return { ok: failures.length === 0, failures };
}
