/**
 * In-memory Store — the reference implementation.
 *
 * Plain `Map`s, no disk. `test/store.test.js` runs the exact same suite against
 * this driver and against `sqlite.js`, so anything that passes here must also
 * pass there: the two are interchangeable behind the Store interface.
 *
 * Structure mirrors the SQLite schema 1:1, so reading one driver tells you how
 * the other works:
 *
 *   boards    Map<boardId, BoardRow>
 *   elements  Map<boardId, Element[]>   // z-order, index 0 paints first
 *   seenOps   Map<boardId, Map<opId, seenAt>>
 *
 * The batch semantics are NOT implemented here — they live in `ops.js` and are
 * shared with the sqlite driver, so the two can never disagree about rev,
 * dedupe or atomicity.
 */

import { randomUUID } from 'node:crypto';
import { applyOpBatch } from './ops.js';

/** Dedupe entries older than this are pruned opportunistically. */
const DEFAULT_OP_TTL_MS = 86400000; // 24h — mirrors config.OP_DEDUPE_TTL_MS

let clock = () => Date.now();

/**
 * Test seam: replace the clock. Not part of the Store contract; used to prove
 * that the seen_ops TTL actually expires entries.
 * @param {(() => number)|null} fn
 */
export function __setClock(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}

const now = () => clock();

/** Strip a board row down to the public `Board` wire shape. */
function toBoard(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    theme: row.theme,
    rev: row.rev,
    ownerId: row.owner_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Copy so callers can never reach into stored state through a return value.
 * Used by the READ paths only. The write path (applyOps) does not deep-copy:
 * stored elements are frozen by ops.js and never modified in place, so a
 * batch works on a shallow copy of the list and costs O(elements it touches)
 * rather than a structuredClone of every image on the board per drag frame.
 */
const clone = (v) => (v === undefined || v === null ? v : structuredClone(v));

/**
 * Does this row belong in the result of a `?owner=` filter?
 *
 * The `owner_id == null` case is deliberate and NOT a bug, so please do not
 * "fix" it into a plain equality: `owner_id` was added after these boards
 * already existed, and a board created without a nickname lands there too.
 * Filtering those out would make every board a person already had disappear
 * the instant they typed a nickname — the worst thing this feature could do.
 * An unowned board is a board anyone may claim; PATCH /boards/:id is the claim.
 * Mirrors OWNER_SQL in sqlite.js; store.test.js runs one suite against both.
 */
function ownedBy(row, owner) {
  return row.owner_id == null || row.owner_id === owner;
}

/**
 * @param {{opTtlMs?: number, idFactory?: () => string}} [options]
 * @returns {Object} Store
 */
export function createStore(options = {}) {
  const opTtlMs = Number.isFinite(options.opTtlMs) ? options.opTtlMs : DEFAULT_OP_TTL_MS;
  const newId = options.idFactory ?? randomUUID;

  /** @type {Map<string, Object>} */
  const boards = new Map();
  /** @type {Map<string, Object[]>} */
  const elements = new Map();
  /** @type {Map<string, Map<string, number>>} */
  const seenOps = new Map();

  let closed = false;

  /**
   * Every public method funnels through here, so a closed store REJECTS instead
   * of crashing the process or silently half-working.
   */
  function guard(name, fn) {
    return async (...args) => {
      if (closed) throw new Error(`store is closed (${name})`);
      return fn(...args);
    };
  }

  const seenFor = (boardId) => {
    let m = seenOps.get(boardId);
    if (!m) {
      m = new Map();
      seenOps.set(boardId, m);
    }
    return m;
  };

  const pruneSeen = (boardId) => {
    if (!(opTtlMs > 0)) return;
    const m = seenOps.get(boardId);
    if (!m || m.size === 0) return;
    const cutoff = now() - opTtlMs;
    for (const [opId, at] of m) {
      if (at < cutoff) m.delete(opId);
    }
  };

  return {
    /** @returns {Promise<{boards: Object[], total: number}>} */
    listBoards: guard('listBoards', async ({ limit = 50, offset = 0, search, owner } = {}) => {
      let rows = [...boards.values()];
      // A present-but-empty owner is the same as no owner at all.
      if (typeof owner === 'string' && owner !== '') {
        rows = rows.filter((r) => ownedBy(r, owner));
      }
      if (typeof search === 'string' && search.trim() !== '') {
        const needle = search.trim().toLowerCase();
        rows = rows.filter((r) => r.title.toLowerCase().includes(needle));
      }
      // Newest first; id breaks ties so paging is stable.
      rows.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const total = rows.length;
      const start = Math.max(0, offset | 0);
      const end = limit === undefined || limit === null ? undefined : start + Math.max(0, limit | 0);
      return {
        boards: rows.slice(start, end).map((r) => ({
          ...toBoard(r),
          elementCount: (elements.get(r.id) ?? []).length,
        })),
        total,
      };
    }),

    /** @returns {Promise<Object|null>} */
    getBoard: guard('getBoard', async (id) => toBoard(boards.get(id) ?? null)),

    /** @returns {Promise<Object>} */
    createBoard: guard('createBoard', async ({ title, theme, ownerId, id } = {}) => {
      const boardId = id ?? newId();
      if (boards.has(boardId)) throw new Error(`board already exists: ${boardId}`);
      const ts = now();
      boards.set(boardId, {
        id: boardId,
        title: typeof title === 'string' && title !== '' ? title : 'Untitled board',
        theme: theme === 'dark' ? 'dark' : 'light',
        rev: 0,
        owner_id: ownerId ?? null,
        created_at: ts,
        updated_at: ts,
      });
      elements.set(boardId, []);
      seenOps.set(boardId, new Map());
      return toBoard(boards.get(boardId));
    }),

    /** @returns {Promise<Object|null>} null when the board does not exist. */
    updateBoard: guard('updateBoard', async (id, patch = {}) => {
      const row = boards.get(id);
      if (!row) return null;
      if (typeof patch.title === 'string' && patch.title !== '') row.title = patch.title;
      if (patch.theme === 'light' || patch.theme === 'dark') row.theme = patch.theme;
      // `ownerId` is assignable, and `null` means "unclaim" as well as "no
      // change" — routes/boards.js only ever passes the key when the client
      // sent it, so an absent ownerId must leave ownership alone rather than
      // silently wiping it on a title-only patch.
      if (patch.ownerId !== undefined) row.owner_id = patch.ownerId ?? null;
      row.updated_at = now();
      return toBoard(row);
    }),

    /** @returns {Promise<boolean>} true if it existed. */
    deleteBoard: guard('deleteBoard', async (id) => {
      const existed = boards.delete(id);
      elements.delete(id);
      seenOps.delete(id);
      return existed;
    }),

    /** @returns {Promise<Object[]>} in z-order, index 0 first. */
    listElements: guard('listElements', async (boardId) => clone(elements.get(boardId) ?? [])),

    /** @returns {Promise<{board: Object, elements: Object[], rev: number}|null>} */
    getSnapshot: guard('getSnapshot', async (boardId) => {
      const row = boards.get(boardId);
      if (!row) return null;
      return {
        board: toBoard(row),
        elements: clone(elements.get(boardId) ?? []),
        rev: row.rev,
      };
    }),

    /**
     * The heart of the store. See docs/API_CONTRACT.md "applyOps semantics".
     */
    applyOps: guard('applyOps', async (boardId, ops, actorId) => {
      const row = boards.get(boardId) ?? null;
      return applyOpBatch({
        ops,
        actorId,
        currentRev: row ? row.rev : 0,
        boardMissing: row === null,
        // A fresh array of the stored (frozen) element objects: ops.js never
        // modifies an element in place, so a throw mid-batch leaves the stored
        // list untouched without deep-copying the board.
        load: () => (elements.get(boardId) ?? []).slice(),
        isSeen: (opId) => seenFor(boardId).has(opId),
        recordSeen: (opIds) => {
          const m = seenFor(boardId);
          const ts = now();
          for (const opId of opIds) m.set(opId, ts);
        },
        prune: () => pruneSeen(boardId),
        // A copy of the array, so a caller holding `result.elements` cannot
        // push into the stored list.
        save: (next) => elements.set(boardId, next.slice()),
        bumpRev: (rev) => {
          if (row) row.rev = rev;
        },
        touch: () => {
          if (row) row.updated_at = now();
        },
      });
    }),

    /** Removes every element and bumps rev. A mutation, even on an empty board. */
    clearBoard: guard('clearBoard', async (boardId) => {
      const row = boards.get(boardId);
      if (!row) return 0;
      pruneSeen(boardId);
      elements.set(boardId, []);
      row.rev += 1;
      row.updated_at = now();
      return row.rev;
    }),

    /** @returns {Promise<boolean>} has this opId been recorded for this board? */
    hasOp: guard('hasOp', async (boardId, opId) => seenFor(boardId).has(opId)),

    async close() {
      closed = true;
      boards.clear();
      elements.clear();
      seenOps.clear();
    },
  };
}

export default createStore;
