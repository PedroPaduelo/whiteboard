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
 *   load()            -> Element[]            current z-ordered element list
 *   isSeen(opId)      -> boolean              has this opId been recorded?
 *   recordSeen(ids)   -> void                 record opIds inside the txn
 *   prune()           -> void                 drop expired seen_ops rows
 *   touch()           -> void                 bump boards.updated_at
 *   bumpRev(nextRev)  -> void                 write the new rev
 *   save(elements)    -> void                 persist the new element list
 *
 * ATOMICITY BY CONSTRUCTION: the function mutates only locals until the very
 * end, where it hands the driver exactly one `save` + one `bumpRev`. If any op
 * throws, nothing was ever written, so the driver has nothing to undo — and the
 * sqlite driver still runs the whole thing inside BEGIN IMMEDIATE/COMMIT, so a
 * concurrent writer cannot interleave with our reads.
 */

import {
  validateElement,
  LIMITS,
  detachMissingConnectors,
  resolveConnectors,
} from '@whiteboard/shared';

/** Op kinds that can change an element's geometry, and so need re-resolving. */
const GEOMETRY_KINDS = new Set(['create', 'update', 'delete', 'clear']);

function fail(msg, extra = {}) {
  const err = new Error(msg);
  Object.assign(err, extra);
  err.code = extra.code ?? 'INVALID_OP';
  throw err;
}

/**
 * Apply one op to the working element list, in place.
 * Throws on a contract violation; silently skips benign races.
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
      return;
    }

    case 'update': {
      const i = list.findIndex((e) => e.id === op.elementId);
      if (i === -1) {
        // A delete that raced this update is normal, not an error. Skip it.
        return;
      }
      const merged = { ...list[i], ...(op.patch ?? {}) };
      // Re-validate the MERGED element, not the patch. This is what catches an
      // update that makes a pen stroke's points disagree with its box, or that
      // hands a `text` element a non-string.
      list[i] = validateElement(merged, `${at}.result`);
      return;
    }

    case 'delete': {
      const i = list.findIndex((e) => e.id === op.elementId);
      if (i !== -1) list.splice(i, 1);
      return;
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
      return;
    }

    case 'clear': {
      list.length = 0;
      return;
    }

    default:
      fail(`${at}: unknown op kind "${op.kind}"`);
  }
}

/**
 * The 7 rules, in order. See docs/API_CONTRACT.md "applyOps semantics".
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
 * @param {(elements: Object[]) => void} io.save
 * @param {number} [io.maxEls]
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
  } = io;

  // Rule 4: a missing board short-circuits before anything is read or written.
  if (boardMissing) {
    return { status: 'missing', rev: 0, appliedOps: [], message: 'board not found' };
  }

  const list = (Array.isArray(ops) ? ops : []).map((op) => ({
    ...op,
    boardId: op.boardId,
    actorId: op.actorId ?? actorId,
  }));

  // Opportunistic TTL sweep: keeps seen_ops bounded without a cron.
  prune();

  // Rule 2: DEDUPE. Only when EVERY opId is already recorded is this a retry.
  // A partially-seen batch is NOT a retry — its new ops must still take effect.
  if (list.length > 0 && list.every((op) => isSeen(op.opId))) {
    return { status: 'duplicate', rev: currentRev, appliedOps: [] };
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
        appliedOps: [],
        message: 'board moved; resync',
      };
    }
  }

  // Rule 5: apply in order against an in-memory copy. Throwing here means the
  // driver rolls back and the client gets a 400.
  let elements = load();
  let geometryTouched = false;
  for (let i = 0; i < fresh.length; i++) {
    if (GEOMETRY_KINDS.has(fresh[i].kind)) geometryTouched = true;
    applyOne(fresh[i], elements, i, maxEls);
  }

  if (geometryTouched) {
    // Detach FIRST, then resolve. A connector still pointing at an element the
    // batch just deleted would otherwise be resolved once more against a
    // missing anchor before being let go. detachMissingConnectors mutates in
    // place and drops only the dangling ids; resolveConnectors returns a NEW
    // array, so its return value is what we must keep.
    detachMissingConnectors(elements);
    const resolved = resolveConnectors(elements);
    if (Array.isArray(resolved)) elements = resolved;
  }

  // Rule 6: ONE rev bump per batch, never per op.
  const newRev = currentRev + 1;
  save(elements);
  bumpRev(newRev);
  touch();
  // Rule 7: record opIds so a client retrying after a network timeout is deduped.
  recordSeen(fresh.map((op) => op.opId));

  return { status: 'applied', rev: newRev, appliedOps: fresh, elements };
}

export default { applyOpBatch };
