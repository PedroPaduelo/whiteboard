/**
 * elements.js — creating elements, and the small predicates everyone needs.
 *
 * Every new element in the app is built here. That is the guarantee that a
 * locally created element is byte-for-byte what the server will store: each
 * one is run through the SAME `tryValidateElement` the API uses, and the
 * normalised result (not the raw input) is what goes into the store.
 */

import { nanoid } from 'nanoid';
import { tryValidateElement, boundsOfPoints } from '@whiteboard/shared';
import { DEFAULT_STYLE, STICKY_SIZE, FONT_SIZES } from './constants.js';
import { fitTextElement } from './text.js';

/** Element ids: short, url-safe, far under LIMITS.MAX_ID (40). Never derive
 *  an id by appending to another id — that grows past the limit. */
export const newId = () => nanoid(12);

/** A roughjs seed: a positive 31-bit integer, stored on the element so every
 *  peer, every reload and every export draws the identical wobble. */
export const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

export const isLinear = (el) => !!el && (el.type === 'arrow' || el.type === 'line');
export const isFreedraw = (el) => !!el && el.type === 'pen';
/** Types whose box is derived from `points`: move/resize them by rewriting points. */
export const hasPoints = (el) => isLinear(el) || isFreedraw(el);
export const isText = (el) => !!el && el.type === 'text';
/** Types an arrow end may bind to. */
export const isBindable = (el) =>
  !!el && ['rect', 'ellipse', 'diamond', 'cylinder', 'sticky', 'text', 'image'].includes(el.type);
/** Types that can hold a label typed into them (double-click to edit). */
export const isContainer = (el) => !!el && ['rect', 'ellipse', 'diamond', 'cylinder', 'sticky'].includes(el.type);
/**
 * Rotation is not offered for a 2-point connector. A connector with more
 * points can be rotated: the turn is baked into its points (no `rotation`
 * field), because shared resolveConnectors ignores rotation.
 */
export const isRotatable = (el) =>
  !!el && (!isLinear(el) || (Array.isArray(el.points) && el.points.length > 2));

/** Style keys that only affect a label or text: font and alignment. */
const TEXT_STYLE_KEYS = ['fontFamily', 'fontSize', 'align'];

/**
 * The style keys an element type actually uses. The properties panel shows
 * exactly these for the selection, and `applyStyle` patches only these, so a
 * font change never writes `fontFamily` onto a pen stroke.
 *
 * Shapes that can hold a label (rect, diamond, ellipse, cylinder) carry the
 * label's font, size and alignment (`align`, default centre when absent).
 */
export function styleKeysFor(type) {
  switch (type) {
    case 'rect':
    case 'diamond':
      return ['stroke', 'fill', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'roundness', 'opacity', ...TEXT_STYLE_KEYS];
    case 'ellipse':
    case 'cylinder':
      // No `roundness`: an ellipse has no corners, and a cylinder is always drawn with curved caps.
      return ['stroke', 'fill', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', ...TEXT_STYLE_KEYS];
    case 'sticky':
      return ['fill', 'opacity', ...TEXT_STYLE_KEYS];
    case 'text':
      return ['stroke', 'opacity', ...TEXT_STYLE_KEYS];
    case 'arrow':
    case 'line':
      return ['stroke', 'strokeWidth', 'strokeStyle', 'roughness', 'roundness', 'opacity', 'startArrowhead', 'endArrowhead'];
    case 'pen':
      return ['stroke', 'strokeWidth', 'opacity'];
    case 'image':
      return ['opacity'];
    default:
      return [];
  }
}

/**
 * Which style keys the panel should show while a drawing TOOL is active:
 * the ones the element that tool creates takes from the default style, so
 * every control shown there changes what gets drawn (Excalidraw shows the
 * same sections).
 *
 * - `line`: no arrowheads — a new line never has any (`createElement`).
 *   A selected line still offers them, through `styleKeysFor('line')`.
 * - rect/diamond/ellipse/cylinder: no font, size or alignment — a new shape
 *   has no label yet, and its label is centred whatever `style.align` says.
 *   The font and size a label will get follow the default style (set with
 *   the text tool, or from any selected text); a labelled shape shows all
 *   three once selected.
 */
export function styleKeysForTool(tool) {
  if (tool === 'image' || tool === 'select' || tool === 'hand' || tool === 'eraser') return [];
  const keys = styleKeysFor(tool);
  if (tool === 'line') return keys.filter((k) => k !== 'startArrowhead' && k !== 'endArrowhead');
  if (isContainer({ type: tool }) && tool !== 'sticky') return keys.filter((k) => !TEXT_STYLE_KEYS.includes(k));
  return keys;
}

/**
 * The style keys worth showing for ONE selected element. Like
 * `styleKeysFor(el.type)`, except that a shape without a label (and not being
 * labelled right now) leaves out font, size and alignment: they would change
 * nothing visible, and Excalidraw only shows them for containers with text.
 * `applyStyle` still filters by `styleKeysFor`, so a mixed selection that
 * shows "Fonte" because of a text also sets the font the shapes' future
 * labels will use.
 *
 * @param {object} el
 * @param {{editing?: boolean}} [opts] `editing`: its label editor is open
 */
export function styleKeysForElement(el, { editing = false } = {}) {
  const keys = styleKeysFor(el?.type);
  if (!isContainer(el) || el.type === 'sticky' || editing) return keys;
  if (typeof el.label === 'string' && el.label !== '') return keys;
  return keys.filter((k) => !TEXT_STYLE_KEYS.includes(k));
}

/**
 * Build a new element and normalise it through the shared validator.
 *
 * @param {string} type    one of ELEMENT_TYPES
 * @param {object} geom    rect types: {x,y,w,h}; pen/arrow/line: {points};
 *                         text: {x,y,text}; image: {x,y,w,h,src,naturalWidth,naturalHeight}
 * @param {object} [style] usually `store.style`; missing keys use DEFAULT_STYLE
 * @param {object} [extra] fields merged last (label, startId, endId, groupId, id, seed…)
 * @returns {object} a validated element
 * @throws {Error} if the result would be rejected by the server — a bug in the
 *   caller, surfaced here instead of as a silent sync failure.
 */
export function createElement(type, geom, style = DEFAULT_STYLE, extra = {}) {
  const s = { ...DEFAULT_STYLE, ...style };
  const now = Date.now();
  const base = {
    id: newId(),
    type,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    seed: randomSeed(),
    opacity: s.opacity,
    createdAt: now,
    updatedAt: now,
  };

  let el;
  switch (type) {
    case 'rect':
    case 'ellipse':
    case 'diamond':
    case 'cylinder':
      el = {
        ...base,
        ...box(geom),
        stroke: s.stroke,
        fill: s.fill,
        fillStyle: s.fillStyle,
        strokeWidth: s.strokeWidth,
        strokeStyle: s.strokeStyle,
        roughness: s.roughness,
        roundness: type === 'rect' || type === 'diamond' ? s.roundness : 'sharp',
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
      };
      break;
    case 'sticky':
      el = {
        ...base,
        ...box(geom, STICKY_SIZE),
        label: '',
        fill: s.stickyFill,
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        // The alignment the panel shows while the sticky tool is active.
        align: s.align,
      };
      break;
    case 'text': {
      const t = {
        ...base,
        x: geom.x,
        y: geom.y,
        text: geom.text ?? '',
        stroke: s.stroke,
        fill: 'none',
        fontFamily: s.fontFamily,
        fontSize: s.fontSize ?? FONT_SIZES.M,
        align: s.align,
      };
      el = { ...t, ...fitTextElement({ ...t, w: 0, h: 0 }) };
      break;
    }
    case 'arrow':
    case 'line': {
      const points = geom.points.map((p) => ({ x: p.x, y: p.y }));
      el = {
        ...base,
        ...boundsOfPoints(points),
        points,
        stroke: s.stroke,
        fill: 'none',
        strokeWidth: s.strokeWidth,
        strokeStyle: s.strokeStyle,
        roughness: s.roughness,
        roundness: s.roundness,
        // Lines start without heads (Excalidraw); the line tool's panel does
        // not offer them (`styleKeysForTool`), a selected line does.
        startArrowhead: type === 'arrow' ? s.startArrowhead : 'none',
        endArrowhead: type === 'arrow' ? s.endArrowhead : 'none',
      };
      break;
    }
    case 'pen': {
      const points = geom.points.map((p) => ({ x: p.x, y: p.y }));
      el = {
        ...base,
        ...boundsOfPoints(points),
        points,
        stroke: s.stroke,
        fill: 'none',
        strokeWidth: s.strokeWidth,
      };
      break;
    }
    case 'image':
      el = {
        ...base,
        ...box(geom),
        src: geom.src,
        naturalWidth: geom.naturalWidth,
        naturalHeight: geom.naturalHeight,
      };
      break;
    default:
      throw new Error(`createElement: unknown type ${type}`);
  }

  const res = tryValidateElement({ ...el, ...extra });
  if (!res.valid) throw new Error(`createElement(${type}): ${res.error}`);
  return res.element;
}

function box(geom, fallback) {
  const w = geom.w ?? fallback?.w ?? 0;
  const h = geom.h ?? fallback?.h ?? 0;
  return { x: geom.x, y: geom.y, w: Math.max(0, w), h: Math.max(0, h) };
}

/**
 * Deep-enough clone of elements with FRESH ids, for duplicate and paste.
 * Bindings and groups that point inside the cloned set are remapped to the
 * new ids; ones pointing outside it are dropped (a pasted arrow must not stay
 * glued to the original box). Polylines get their points offset too.
 *
 * @param {object[]} elements
 * @param {{dx?:number, dy?:number}} [offset]
 * @returns {object[]} new elements, validated
 */
export function cloneElements(elements, { dx = 0, dy = 0 } = {}) {
  const idMap = new Map(elements.map((el) => [el.id, newId()]));
  const groupMap = new Map();
  const now = Date.now();
  const out = [];
  for (const el of elements) {
    const copy = { ...el, id: idMap.get(el.id), seed: randomSeed(), createdAt: now, updatedAt: now };
    if (hasPoints(el)) {
      copy.points = el.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      Object.assign(copy, boundsOfPoints(copy.points));
    } else {
      copy.x = el.x + dx;
      copy.y = el.y + dy;
    }
    if (isLinear(el)) {
      if (el.startId) copy.startId = idMap.get(el.startId) ?? undefined;
      if (el.endId) copy.endId = idMap.get(el.endId) ?? undefined;
      if (!copy.startId) delete copy.startId;
      if (!copy.endId) delete copy.endId;
    }
    if (el.groupId) {
      if (!groupMap.has(el.groupId)) groupMap.set(el.groupId, idMap.get(el.groupId) ?? newId());
      copy.groupId = groupMap.get(el.groupId);
    }
    delete copy.locked;
    const res = tryValidateElement(copy);
    if (res.valid) out.push(res.element);
  }
  return out;
}
