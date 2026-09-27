/**
 * Validation for elements and ops. The API refuses to store anything that
 * fails this, so the web client can trust the shape of what it reads back.
 *
 * Design rules:
 *  - Reject, do not coerce. A malformed element is a client bug; silently
 *   repairing it hides that bug and produces a board that renders wrong in a
 *   way nobody can trace.
 *  - Bound everything. `MAX_ELS` and `MAX_POINTS` are what keep one bad
 *   client (or one malicious one) from filling the database with a 4-million
 *   point pen stroke.
 *  - Unknown fields are stripped, not rejected, so a newer client can add
 *   fields without breaking an older server.
 */

import { ELEMENT_TYPES, STROKE_STYLES, DRAWING_TOOLS } from './types.js';
import { boundsOfPoints } from './geometry.js';

/** Hard caps, mirrored by the web client so it refuses locally first. */
export const LIMITS = Object.freeze({
  MAX_ELS: 5000,
  MAX_POINTS: 20000,
  MAX_TEXT: 4000,
  MAX_LABEL: 500,
  MAX_IMAGE_CHARS: 2000000, // ~1.5MB of base64
  MAX_OPS_PER_BATCH: 200,
  MAX_ID: 40,
});

const HEX_OR_CSS = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|[a-zA-Z]{3,20})$/;

class Invalid extends Error {
  constructor(msg, path) {
    super(`${path}: ${msg}`);
    this.name = 'InvalidElement';
    this.path = path;
  }
}

const fail = (msg, path) => {
  throw new Invalid(msg, path);
};

function reqNum(v, path) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail('expected a finite number', path);
  return v;
}

function optNum(v, path) {
  if (v === undefined || v === null) return undefined;
  return reqNum(v, path);
}

function optColor(v, path) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !HEX_OR_CSS.test(v)) fail('expected a CSS colour', path);
  return v;
}

function optId(v, path) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length === 0 || v.length > LIMITS.MAX_ID) {
    fail(`expected an id of 1..${LIMITS.MAX_ID} chars`, path);
  }
  return v;
}

function optStr(v, path, max) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max) fail(`expected a string <= ${max} chars`, path);
  return v;
}

function point(v, path) {
  if (!v || typeof v !== 'object') fail('expected a point', path);
  return { x: reqNum(v.x, `${path}.x`), y: reqNum(v.y, `${path}.y`) };
}

function pointList(v, path) {
  if (!Array.isArray(v)) fail('expected an array of points', path);
  if (v.length > LIMITS.MAX_POINTS) fail(`too many points (max ${LIMITS.MAX_POINTS})`, path);
  if (v.length === 0) fail('expected at least one point', path);
  return v.map((p, i) => point(p, `${path}[${i}]`));
}

/**
 * Validate and normalise one element. Returns a NEW plain object containing
 * only known fields, with the box recomputed from the geometry that defines it
 * (points for pen/connectors, explicit x/y/w/h for everything else).
 *
 * @param {unknown} raw
 * @param {string} [path]
 * @returns {Object} a clean element
 * @throws {Invalid} on any violation
 */
export function validateElement(raw, path = 'element') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('expected an object', path);
  }
  const id = optId(raw.id, `${path}.id`);
  if (!id) fail('id is required', path);

  const type = raw.type;
  if (!ELEMENT_TYPES.includes(type)) {
    fail(`type must be one of ${ELEMENT_TYPES.join(', ')}`, `${path}.type`);
  }

  const base = {
    id,
    type,
    x: reqNum(raw.x, `${path}.x`),
    y: reqNum(raw.y, `${path}.y`),
    w: Math.max(0, reqNum(raw.w, `${path}.w`)),
    h: Math.max(0, reqNum(raw.h, `${path}.h`)),
  };

  const rotation = optNum(raw.rotation, `${path}.rotation`);
  if (rotation !== undefined) base.rotation = rotation;

  const stroke = optColor(raw.stroke, `${path}.stroke`);
  if (stroke !== undefined) base.stroke = stroke;

  const fill = optColor(raw.fill, `${path}.fill`);
  if (fill !== undefined) base.fill = fill;

  const strokeWidth = optNum(raw.strokeWidth, `${path}.strokeWidth`);
  if (strokeWidth !== undefined) {
    if (strokeWidth < 0 || strokeWidth > 200) fail('strokeWidth must be 0..200', `${path}.strokeWidth`);
    base.strokeWidth = strokeWidth;
  }

  const strokeStyle = raw.strokeStyle;
  if (strokeStyle !== undefined) {
    if (!STROKE_STYLES.includes(strokeStyle)) {
      fail(`strokeStyle must be one of ${STROKE_STYLES.join(', ')}`, `${path}.strokeStyle`);
    }
    base.strokeStyle = strokeStyle;
  }

  const opacity = optNum(raw.opacity, `${path}.opacity`);
  if (opacity !== undefined) {
    if (opacity < 0 || opacity > 1) fail('opacity must be 0..1', `${path}.opacity`);
    base.opacity = opacity;
  }

  // `locked` is per-element UI state the layer panel owns: it hides an element
  // from editing without hiding it from the board. It is a first-class field
  // because a lock that only lives in one client's memory is not a lock — the
  // next peer to load the board would see the element editable.
  const locked = raw.locked;
  if (locked !== undefined && locked !== null) {
    if (typeof locked !== 'boolean') fail('locked must be a boolean', `${path}.locked`);
    base.locked = locked;
  }

  // `groupId` names the frame a child belongs to. It is stored rather than
  // inferred from geometry: inferring it re-parents an element the moment it
  // happens to land inside a dashed rectangle, and makes "take this out of
  // the group" inexpressible. One id, the same contract `startId` already uses.
  const groupId = optId(raw.groupId, `${path}.groupId`);
  if (groupId) base.groupId = groupId;

  const authorId = optId(raw.authorId, `${path}.authorId`);
  if (authorId !== undefined) base.authorId = authorId;
  const createdAt = optNum(raw.createdAt, `${path}.createdAt`);
  if (createdAt !== undefined) base.createdAt = createdAt;
  const updatedAt = optNum(raw.updatedAt, `${path}.updatedAt`);
  if (updatedAt !== undefined) base.updatedAt = updatedAt;

  // --- Per-type geometry. Where points define the shape, the box is derived
  // --- so the two can never disagree.
  switch (type) {
    case 'pen': {
      const points = pointList(raw.points, `${path}.points`);
      const b = boundsOfPoints(points);
      base.x = b.x;
      base.y = b.y;
      base.w = b.w;
      base.h = b.h;
      base.points = points;
      break;
    }
    case 'arrow':
    case 'line': {
      const points = pointList(raw.points, `${path}.points`);
      if (points.length !== 2) {
        fail('a connector has exactly 2 points (start, end)', `${path}.points`);
      }
      base.points = [points[0], points[1]];
      const b = boundsOfPoints(base.points);
      base.x = b.x;
      base.y = b.y;
      base.w = b.w;
      base.h = b.h;
      const startId = optId(raw.startId, `${path}.startId`);
      const endId = optId(raw.endId, `${path}.endId`);
      if (startId) base.startId = startId;
      if (endId) base.endId = endId;
      break;
    }
    case 'text': {
      const text = raw.text;
      if (typeof text !== 'string' || text.length > LIMITS.MAX_TEXT) {
        fail(`text must be a string <= ${LIMITS.MAX_TEXT} chars`, `${path}.text`);
      }
      base.text = text;
      const fontSize = optNum(raw.fontSize, `${path}.fontSize`) ?? 24;
      if (fontSize < 4 || fontSize > 512) fail('fontSize must be 4..512', `${path}.fontSize`);
      base.fontSize = fontSize;
      if (raw.align !== undefined) {
        if (!['left', 'center', 'right'].includes(raw.align)) {
          fail('align must be left, center or right', `${path}.align`);
        }
        base.align = raw.align;
      }
      break;
    }
    case 'sticky': {
      const label = raw.label;
      if (typeof label !== 'string' || label.length > LIMITS.MAX_LABEL) {
        fail(`label must be a string <= ${LIMITS.MAX_LABEL} chars`, `${path}.label`);
      }
      base.label = label;
      if (!base.fill) base.fill = '#fde68a';
      break;
    }
    case 'image': {
      const src = raw.src;
      if (typeof src !== 'string' || src.length === 0) {
        fail('image src is required', `${path}.src`);
      }
      if (src.length > LIMITS.MAX_IMAGE_CHARS) {
        fail(`image src too large (max ${LIMITS.MAX_IMAGE_CHARS} chars)`, `${path}.src`);
      }
      // Only inline data and https URLs. Rejects javascript:, which would be
      // stored and then rendered into every visitor's page.
      if (!/^(data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+|https:\/\/[^\s]+)$/.test(src)) {
        fail('image src must be an https URL or a base64 data:image', `${path}.src`);
      }
      base.src = src;
      const nw = optNum(raw.naturalWidth, `${path}.naturalWidth`);
      const nh = optNum(raw.naturalHeight, `${path}.naturalHeight`);
      if (nw !== undefined) base.naturalWidth = nw;
      if (nh !== undefined) base.naturalHeight = nh;
      break;
    }
    case 'rect':
    case 'ellipse':
    case 'diamond':
    case 'cylinder':
      // Nothing extra. The box is the whole truth.
      break;
    default:
      fail(`unhandled type ${type}`, `${path}.type`);
  }

  return base;
}

/** Fields a patch may touch. Identity and kind are deliberately absent. */
const PATCHABLE = new Set([
  'x', 'y', 'w', 'h', 'rotation', 'stroke', 'fill', 'strokeWidth', 'strokeStyle',
  'opacity', 'label', 'text', 'fontSize', 'align', 'points', 'startId', 'endId',
  'src', 'naturalWidth', 'naturalHeight', 'updatedAt', 'locked', 'groupId',
]);

/** Drop unknown keys from a patch so they cannot smuggle fields into an element. */
function sanitisePatch(patch, path) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k)) continue;
    if (k === 'points') {
      out.points = pointList(v, `${path}.points`);
    } else if (k === 'label') {
      out.label = optStr(v, `${path}.label`, LIMITS.MAX_LABEL);
    } else if (k === 'text') {
      out.text = optStr(v, `${path}.text`, LIMITS.MAX_TEXT);
    } else if (k === 'src') {
      out.src = optStr(v, `${path}.src`, LIMITS.MAX_IMAGE_CHARS);
    } else if (k === 'fontSize' || k === 'rotation' || k === 'strokeWidth' || k === 'opacity') {
      out[k] = reqNum(v, `${path}.${k}`);
    } else if (k === 'stroke' || k === 'fill') {
      const c = optColor(v, `${path}.${k}`);
      if (c !== undefined) out[k] = c;
    } else if (k === 'strokeStyle') {
      if (!STROKE_STYLES.includes(v)) fail('bad strokeStyle', `${path}.strokeStyle`);
      out.strokeStyle = v;
    } else if (k === 'align') {
      if (!['left', 'center', 'right'].includes(v)) fail('bad align', `${path}.align`);
      out.align = v;
    } else if (k === 'locked') {
      if (typeof v !== 'boolean') fail('locked must be a boolean', `${path}.locked`);
      out.locked = v;
    } else if (k === 'groupId') {
      // Nullable: `null` is how a child is released from its group, which is a
      // real operation and not the same as "never had one".
      if (v === null) out.groupId = null;
      else {
        const i = optId(v, `${path}.groupId`);
        if (i !== undefined) out.groupId = i;
      }
    } else if (k === 'startId' || k === 'endId') {
      const i = optId(v, `${path}.${k}`);
      if (i !== undefined) out[k] = i;
    } else if (k === 'w' || k === 'h') {
      out[k] = Math.max(0, reqNum(v, `${path}.${k}`));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Validate a batch of ops. Throws on the first bad op, naming its index, so a
 * 200-op batch fails loudly rather than half-applying.
 * @param {unknown} rawOps
 * @returns {Object[]} clean ops
 */
export function validateOps(rawOps) {
  if (!Array.isArray(rawOps)) fail('ops must be an array', 'ops');
  if (rawOps.length > LIMITS.MAX_OPS_PER_BATCH) {
    fail(`at most ${LIMITS.MAX_OPS_PER_BATCH} ops per batch`, 'ops');
  }
  return rawOps.map((raw, i) => {
    const p = `ops[${i}]`;
    if (!raw || typeof raw !== 'object') fail('expected an object', p);
    const opId = optId(raw.opId, `${p}.opId`);
    if (!opId) fail('opId is required', p);
    const kind = raw.kind;
    if (!['create', 'update', 'delete', 'reorder', 'clear'].includes(kind)) {
      fail('kind must be create, update, delete, reorder or clear', `${p}.kind`);
    }
    const op = { opId, kind };

    if (kind === 'create') {
      op.element = validateElement(raw.element, `${p}.element`);
    } else if (kind === 'update') {
      op.elementId = optId(raw.elementId, `${p}.elementId`);
      if (!op.elementId) fail('elementId is required for update', p);
      if (raw.patch !== undefined) {
        if (!raw.patch || typeof raw.patch !== 'object' || Array.isArray(raw.patch)) {
          fail('patch must be an object', `${p}.patch`);
        }
        // A patch may not change identity or kind: that is a delete+create.
        for (const banned of ['id', 'type']) {
          if (banned in raw.patch) fail(`patch must not change ${banned}`, `${p}.patch.${banned}`);
        }
        op.patch = sanitisePatch(raw.patch, `${p}.patch`);
      }
    } else if (kind === 'delete') {
      op.elementId = optId(raw.elementId, `${p}.elementId`);
      if (!op.elementId) fail('elementId is required for delete', p);
    } else if (kind === 'reorder') {
      if (!Array.isArray(raw.order)) fail('order must be an array of ids', `${p}.order`);
      op.order = raw.order.map((v, j) => optId(v, `${p}.order[${j}]`));
    }

    const baseRev = optNum(raw.baseRev, `${p}.baseRev`);
    if (baseRev !== undefined) op.baseRev = baseRev;
    const actorId = optId(raw.actorId, `${p}.actorId`);
    if (actorId !== undefined) op.actorId = actorId;
    const at = optNum(raw.at, `${p}.at`);
    if (at !== undefined) op.at = at;
    return op;
  });
}

/**
 * Non-throwing wrapper, for the web client to validate before it sends.
 * @param {unknown} raw
 * @returns {{valid: true, element: Object} | {valid: false, error: string, path: string}}
 */
export function tryValidateElement(raw) {
  try {
    return { valid: true, element: validateElement(raw) };
  } catch (e) {
    if (e instanceof Invalid) return { valid: false, error: e.message, path: e.path };
    throw e;
  }
}

/** Non-throwing op validator, same role for op batches. */
export function tryValidateOps(raw) {
  try {
    return { valid: true, ops: validateOps(raw) };
  } catch (e) {
    if (e instanceof Invalid) return { valid: false, error: e.message, path: e.path };
    throw e;
  }
}

/**
 * Which drawing tool produces which element type. Kept here so the toolbar and
 * the server agree on the mapping without either importing the other's UI.
 */
export function elementTypeForTool(tool) {
  return DRAWING_TOOLS.includes(tool) ? tool : null;
}
