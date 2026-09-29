/**
 * A per-board stash, in localStorage, of ops that may not have reached the
 * server when the page went away.
 *
 * Closing a tab gives the realtime client one synchronous moment (`pagehide`)
 * and nothing after it: a request chained on a previous response never
 * starts, and browsers refuse `keepalive` bodies past ~64 KiB in flight per
 * page. So an outbox bigger than that — a big paste, a long burst on a slow
 * link — could only ever be partly delivered, and the rest was lost for good.
 * Now everything still pending is also written here, and the next time this
 * browser opens the board the client queues it again, in order, ahead of new
 * edits. The server dedupes by opId (for 24 h), so whatever DID land is a
 * no-op the second time; the stash is only replayed while it is well inside
 * that window.
 *
 * Every storage access is guarded (private mode, blocked storage, quota): a
 * stash that cannot be written is a best effort that failed, never a crash.
 */

const PREFIX = 'whiteboard:unsent:';

/** A stash older than this is dropped unread: the server's opId dedupe lasts 24 h. */
export const STASH_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Ops bigger than this (images) are the first thing left out when storage is full. */
const BIG_OP_CHARS = 256 * 1024;

function storage() {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function read(ls, key) {
  try {
    const raw = ls.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.ops) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Add `ops` to the stash of `boardId` (after whatever an earlier visit left
 * there, deduped by opId).
 * @returns {boolean} whether all of them were stored
 */
export function saveStash(boardId, ops, now = Date.now()) {
  const ls = storage();
  if (!ls || !boardId || !Array.isArray(ops) || ops.length === 0) return false;
  const key = PREFIX + boardId;
  const prior = read(ls, key);
  const seen = new Set();
  const all = [];
  for (const op of [...(prior && now - prior.at <= STASH_MAX_AGE_MS ? prior.ops : []), ...ops]) {
    if (!op || !op.opId || seen.has(op.opId)) continue;
    seen.add(op.opId);
    all.push(op);
  }
  const write = (list) => {
    try {
      ls.setItem(key, JSON.stringify({ at: now, ops: list }));
      return true;
    } catch {
      return false;
    }
  };
  if (write(all)) return true;
  // Over quota: keep everything but the big ops (images) rather than nothing.
  const small = all.filter((op) => JSON.stringify(op).length <= BIG_OP_CHARS);
  if (small.length > 0 && small.length < all.length) write(small);
  return false;
}

/**
 * Read and REMOVE the stash of `boardId`. A stash past STASH_MAX_AGE_MS is
 * discarded: replaying it could re-apply ops the server no longer dedupes.
 * @returns {object[]} ops in their original order ([] when there are none)
 */
export function takeStash(boardId, now = Date.now()) {
  const ls = storage();
  if (!ls || !boardId) return [];
  const key = PREFIX + boardId;
  const stash = read(ls, key);
  try {
    ls.removeItem(key);
  } catch {
    /* nothing to do */
  }
  if (!stash || !(now - stash.at <= STASH_MAX_AGE_MS)) return [];
  return stash.ops.filter((op) => op && op.opId && op.kind);
}

/** Forget the stash of `boardId` (the board is gone). Never throws. */
export function dropStash(boardId) {
  const ls = storage();
  if (!ls || !boardId) return;
  try {
    ls.removeItem(PREFIX + boardId);
  } catch {
    /* nothing to do */
  }
}

/** The default the realtime client uses; tests pass their own or null. */
export const localStash = Object.freeze({ save: saveStash, take: takeStash, drop: dropStash });
