/**
 * The applyOps algorithm, shared by BOTH drivers.
 *
 * This file exists so the atomicity and rev semantics can only be written once:
 * the memory driver and the sqlite driver differ in *where* state lives, never
 * in *what a batch does*. Any change to the 7 rules of the API contract happens
 * here, and both drivers inherit it.
 *
 * A driver supplies a tiny "persistence port":
 *
 *   load()              -> Element[]          current z-ordered element list
 *   isSeen(opId)        -> boolean            has this opId been recorded?
 *   recordSeen(ids)     -> void               record opIds inside the txn
 *   prune()             -> void               drop expired seen_ops rows
 *   touch()             -> void               bump boards.updated_at
 *   bumpRev(nextRev)    -> void               write the new rev
 *   save(next, prev)    -> void               persist the new element list
 *
 * ATOMICITY BY CONSTRUCTION: the function mutates only locals until the very
 * end, where it hands the driver exactly one `save` + one `bumpRev`. If any op
 * throws, nothing was ever written, so the driver has nothing to undo — and the
 * sqlite driver still runs the whole thing inside BEGIN IMMEDIATE/COMMIT, so a
 * concurrent writer cannot interleave with our reads.
 *
 * COST PROPORTIONAL TO THE CHANGE, NOT TO THE BOARD. Every drag frame is a
 * batch, and a board may hold megabytes of inline images, so nothing here may
 * copy, serialise or re-validate the whole board:
 *
 *  - Element objects are NEVER mutated. `load()` may hand us the driver's own
 *    (frozen) objects in a fresh array; every change makes a new object, and
 *    an element the batch did not touch keeps its identity all the way to
 *    `save`.
 *  - `save(next, prev)` gets the list before the batch too, so a driver can
 *    write only the elements whose identity changed (sqlite: one row each)
 *    instead of the whole board.
 *  - Every element this batch created or changed is deep-frozen before
 *    `save`, so a driver may keep the list as its cache and a caller holding
 *    a result can never reach in and change stored state.
 */

import { validateElement, LIMITS, resolveConnectors } from '@whiteboard/shared';

/** Op kinds that can change an element's geometry, and so need re-resolving. */
const GEOMETRY_KINDS = new Set(['create', 'update', 'delete', 'clear']);

/**
 * `err.code`s applyOpBatch throws when it REFUSES a batch (the client's
 * fault, nothing written). Anything else thrown by a store is an
 * infrastructure failure (a locked database, a closed store) and must be
 * reported as ours, never as a bad request.
 */
export const REJECTION_CODES = Object.freeze([
  'DUPLICATE_ELEMENT',
  'TOO_MANY_ELEMENTS',
  'BOARD_TOO_LARGE',
  'INVALID_OP',
]);

/**
 * Classify a store throw: the contract code for a refused batch
 * (`VALIDATION_FAILED` for an element that fails validateElement), or null
 * for an infrastructure failure.
 */
export function rejectionCode(err) {
  if (err && REJECTION_CODES.includes(err.code)) return err.code;
  if (err && err.name === 'InvalidElement') return 'VALIDATION_FAILED';
  return null;
}

function fail(msg, extra = {}) {
  const err = new Error(msg);
  Object.assign(err, extra);
  err.code = extra.code ?? 'INVALID_OP';
  throw err;
}

/** Freeze an element and its points, so a shared reference is read-only. */
function freezeElement(el) {
  if (Object.isFrozen(el)) return el;
  if (Array.isArray(el.points)) {
    for (const p of el.points) Object.freeze(p);
    Object.freeze(el.points);
  }
  return Object.freeze(el);
}

/**
 * detachMissingConnectors without the in-place mutation: a connector whose
 * start/end names an element that is no longer on the board becomes a NEW
 * object without that binding; everything else keeps its identity. The
 * shared helper deletes keys on the objects it is given, which would write
 * through to a driver's cached (frozen) elements.
 */
function detachMissing(list) {
  let ids = null;
  let out = list;
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (el.type !== 'arrow' && el.type !== 'line') continue;
    if (!el.startId && !el.endId) continue;
    ids ??= new Set(list.map((e) => e.id));
    const dropStart = el.startId && !ids.has(el.startId);
    const dropEnd = el.endId && !ids.has(el.endId);
    if (!dropStart && !dropEnd) continue;
    const next = { ...el };
    if (dropStart) delete next.startId;
    if (dropEnd) delete next.endId;
    if (out === list) out = list.slice();
    out[i] = next;
  }
  return out;
}

/**
 * What a batch weighs, for the whole-board caps: characters of inline image
 * data and points across every element. O(elements), no serialising.
 */
function boardWeight(list) {
  let imageChars = 0;
  let points = 0;
  for (const el of list) {
    if (el.type === 'image' && typeof el.src === 'string') imageChars += el.src.length;
    if (Array.isArray(el.points)) points += el.points.length;
  }
  return { imageChars, points };
}

/**
 * The patch as it actually took effect: what the store KEPT, not what the
 * client sent. validateElement strips fields a type does not use (a `text`
 * on a rect) and re-derives the box of pen strokes and connectors from their
 * points, so the raw patch can name values the stored element does not have.
 * Broadcasting the raw patch made every peer's copy diverge from the server's.
 */
function effectivePatch(patch, stored) {
  const out = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (Object.prototype.hasOwnProperty.call(stored, k)) out[k] = stored[k];
    else if (v === null) out[k] = null; // a removal that took effect
    // else: a field this type does not store; the store dropped it, so do we.
  }
  return out;
}

/**
 * Apply one op to the working element list, in place (the list is ours; the
 * element objects are not, so they are replaced, never modified).
 * Throws on a contract violation; silently skips benign races.
 * `index` is the op's position in the batch AS SENT, so an error message
 * names the op the client actually wrote even after dedupe dropped some.
 * @returns {Object} the op as it took effect, for `appliedOps`
 */
function applyOne(op, list, index, maxEls) {
  const at = `ops[${index}]`;

  switch (op.kind) {
    case 'create': {
      // Re-validate, so the box is re-derived from the points: never trust a
      // client's x/y/w/h for pen strokes and connectors.
      const element = validateElement(op.element, `${at}.element`);
      if (list.some((e) => e.id === element.id)) {
        fail(`${at}: element "${element.id}" already exists`, { code: 'DUPLICATE_ELEMENT' });
      }
      if (list.length + 1 > maxEls) {
        fail(`${at}: board would exceed ${maxEls} elements`, { code: 'TOO_MANY_ELEMENTS' });
      }
      // END of the array == TOP of the z-order.
      list.push(element);
      return op;
    }

    case 'update': {
      const i = list.findIndex((e) => e.id === op.elementId);
      if (i === -1) {
        // A delete that raced this update is normal, not an error. Skip it.
        return op;
      }
      const merged = { ...list[i], ...(op.patch ?? {}) };
      // Re-validate the MERGED element, not the patch. This is what catches an
      // update that makes a pen stroke's points disagree with its box, or that
      // hands a `text` element a non-string.
      list[i] = validateElement(merged, `${at}.result`);
      if (op.patch === undefined) return op;
      return { ...op, patch: effectivePatch(op.patch, list[i]) };
    }

    case 'delete': {
      const i = list.findIndex((e) => e.id === op.elementId);
      if (i !== -1) list.splice(i, 1);
      return op;
    }

    case 'reorder': {
      const wanted = Array.isArray(op.order) ? op.order : [];
      const byId = new Map(list.map((e) => [e.id, e]));
      const next = [];
      const used = new Set();
      for (const id of wanted) {
        const e = byId.get(id);
        if (!e || used.has(id)) continue; // unknown ids ignored, duplicates collapsed
        next.push(e);
        used.add(id);
      }
      // Ids not named in `order` keep their relative order, at the end.
      for (const e of list) {
        if (!used.has(e.id)) next.push(e);
      }
      list.length = 0;
      list.push(...next);
      return op;
    }

    case 'clear': {
      list.length = 0;
      return op;
    }

    default:
      fail(`${at}: unknown op kind "${op.kind}"`);
  }
}

/**
 * The 7 rules, in order. See docs/API_CONTRACT.md "applyOps semantics".
 *
 * Result shape (OpResult in @whiteboard/shared):
 *   applied    {status:'applied',   rev, applied, appliedOps, elements}
 *   duplicate  {status:'duplicate', rev, applied, appliedOps: []}
 *   conflict   {status:'conflict',  rev, applied: [], appliedOps: [], message}
 *   missing    {status:'missing',   rev: 0, applied: [], appliedOps: [], message}
 * `applied` lists every opId of the batch the server now holds (applied now,
 * or by an earlier delivery of the same opId), so a client can drop exactly
 * those from its outbox; `appliedOps` is only what took effect THIS time.
 *
 * @param {Object} io
 * @param {Object[]} io.ops
 * @param {string} [io.actorId]
 * @param {number} io.currentRev          0 when the board does not exist
 * @param {boolean} [io.boardMissing]
 * @param {() => Object[]} io.load
 * @param {(opId: string) => boolean} io.isSeen
 * @param {(opIds: string[]) => void} io.recordSeen
 * @param {() => void} io.prune
 * @param {() => void} io.touch
 * @param {(rev: number) => void} io.bumpRev
 * @param {(next: Object[], prev: Object[]) => void} io.save  the list after, and before, the batch
 * @param {number} [io.maxEls]
 * @param {number} [io.maxImageChars]  whole-board cap (LIMITS.MAX_BOARD_IMAGE_CHARS)
 * @param {number} [io.maxPoints]      whole-board cap (LIMITS.MAX_BOARD_POINTS)
 * @returns {Object} OpApplyResult
 */
export function applyOpBatch(io) {
  const {
    ops,
    actorId,
    currentRev,
    boardMissing = false,
    load,
    isSeen,
    recordSeen,
    prune,
    touch,
    bumpRev,
    save,
    maxEls = LIMITS.MAX_ELS,
    maxImageChars = LIMITS.MAX_BOARD_IMAGE_CHARS,
    maxPoints = LIMITS.MAX_BOARD_POINTS,
  } = io;

  // Rule 4: a missing board short-circuits before anything is read or written.
  if (boardMissing) {
    return { status: 'missing', rev: 0, applied: [], appliedOps: [], message: 'board not found' };
  }

  // `index` remembers each op's position in the batch as sent (see applyOne);
  // it is stripped again before the ops leave this function.
  const list = (Array.isArray(ops) ? ops : []).map((op, index) => ({
    ...op,
    actorId: op.actorId ?? actorId,
    index,
  }));
  const allIds = list.map((op) => op.opId);

  // A batch holds 1..MAX_OPS_PER_BATCH ops (both edges check it too). An
  // empty one is refused here as well: it used to be "applied", costing a
  // full write and a rev bump for nothing.
  if (list.length === 0) fail('ops: expected at least one op');

  // Opportunistic TTL sweep: keeps seen_ops bounded without a cron.
  prune();

  // Rule 2: DEDUPE. Only when EVERY opId is already recorded is this a retry.
  // A partially-seen batch is NOT a retry — its new ops must still take effect.
  if (list.every((op) => isSeen(op.opId))) {
    return { status: 'duplicate', rev: currentRev, applied: allIds, appliedOps: [] };
  }

  // An opId is an idempotency key, so a re-sent opId must have NO effect even
  // when it rides along with ops we have not seen. Without this, a client that
  // retries a two-op batch where only the first op landed would re-apply the
  // first and blow up on its own duplicate element id.
  const fresh = list.filter((op) => !isSeen(op.opId));

  // Rule 3: CONFLICT. ANY op carrying a stale baseRev rejects the WHOLE batch
  // and changes nothing — and crucially does NOT bump the rev, or every
  // subsequent retry would conflict too.
  for (let i = 0; i < fresh.length; i++) {
    const baseRev = fresh[i].baseRev;
    if (baseRev !== undefined && baseRev !== null && baseRev !== currentRev) {
      return {
        status: 'conflict',
        rev: currentRev,
        applied: [],
        appliedOps: [],
        message: 'board moved; resync',
      };
    }
  }

  // Rule 5: apply in order against a working copy of the LIST (a fresh
  // array; the element objects in it are shared and never modified).
  // Throwing here means the driver rolls back and the client gets a 400.
  const before = load();
  let elements = before.slice();
  let geometryTouched = false;
  const effective = [];
  for (let i = 0; i < fresh.length; i++) {
    if (GEOMETRY_KINDS.has(fresh[i].kind)) geometryTouched = true;
    effective.push(applyOne(fresh[i], elements, fresh[i].index, maxEls));
  }

  if (geometryTouched) {
    // Detach FIRST, then resolve. A connector still pointing at an element the
    // batch just deleted would otherwise be resolved once more against a
    // missing anchor before being let go. Both return a NEW array in which
    // only the connectors they changed are new objects.
    const detached = detachMissing(elements);
    const resolved = resolveConnectors(detached);
    const settled = Array.isArray(resolved) ? resolved : detached;
    // A connector the resolver moved is persisted, so it passes the same
    // validation as anything a client sends: the store never saves what it
    // would refuse to accept (a non-finite end is a 400, not a stored NaN).
    for (let i = 0; i < settled.length; i++) {
      const el = settled[i];
      if (el !== elements[i]) {
        settled[i] = validateElement(el, `connector "${el.id}"`);
      }
    }
    elements = settled;
  }

  // Whole-board caps. Only a batch that GROWS the board past a cap is refused:
  // a board already over it (older data) must still accept the deletes that
  // bring it back under.
  const after = boardWeight(elements);
  if (after.imageChars > maxImageChars || after.points > maxPoints) {
    const was = boardWeight(before);
    if (after.imageChars > maxImageChars && after.imageChars > was.imageChars) {
      fail(`board would exceed ${maxImageChars} characters of image data`, { code: 'BOARD_TOO_LARGE' });
    }
    if (after.points > maxPoints && after.points > was.points) {
      fail(`board would exceed ${maxPoints} points`, { code: 'BOARD_TOO_LARGE' });
    }
  }

  // Everything this batch created or replaced becomes read-only before the
  // driver sees it (untouched elements already are, or are the driver's own).
  const kept = new Set(before);
  for (const el of elements) {
    if (!kept.has(el)) freezeElement(el);
  }

  // Rule 6: ONE rev bump per batch, never per op.
  const newRev = currentRev + 1;
  save(elements, before);
  bumpRev(newRev);
  touch();
  // Rule 7: record opIds so a client retrying after a network timeout is deduped.
  recordSeen(fresh.map((op) => op.opId));

  const appliedOps = effective.map(({ index, ...op }) => op);
  return { status: 'applied', rev: newRev, applied: allIds, appliedOps, elements };
}

export default { applyOpBatch, rejectionCode, REJECTION_CODES };
