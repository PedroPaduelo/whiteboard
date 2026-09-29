/**
 * SQLite Store — `node:sqlite` (Node 22.5+, behind --experimental-sqlite).
 *
 * The synchronous API is a feature, not a compromise: an `applyOps` batch is a
 * short, pure-CPU transaction, and running it to completion without an `await`
 * inside means no other request can interleave between our read and our write.
 * Every method still returns a Promise so the interface matches the memory
 * driver exactly.
 *
 * The batch semantics live in `ops.js`, shared with the memory driver. What is
 * specific here is *how* they are made durable and isolated.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { applyOpBatch } from './ops.js';

/** Dedupe entries older than this are pruned opportunistically. */
const DEFAULT_OP_TTL_MS = 86400000; // 24h — mirrors config.OP_DEDUPE_TTL_MS

/**
 * How many boards' parsed element lists the driver keeps, and roughly how
 * many JSON characters of them (the least recently written/read go first;
 * the board being written is always kept). Parsing a board is O(its bytes),
 * so doing it on every drag frame of an image-heavy board stalled the whole
 * server; a hot board is parsed once and then served from here.
 */
const CACHE_BOARDS = 32;
const CACHE_CHARS = 64 * 1024 * 1024;

/**
 * Schema from docs/API_CONTRACT.md "Persistence notes", verbatim.
 *
 * Elements are stored ONE ROW PER ELEMENT, each row a JSON document, ordered
 * by `pos`. They used to be one JSON blob per board, which made every op
 * batch (one per 50ms of dragging) parse, re-serialise and rewrite the entire
 * board, inline images included: 100-600ms of blocked event loop per frame
 * on a board with a few photos. With rows, a one-field update rewrites one
 * row. Each row is still a JSON document, so a new optional element field is
 * still only a shared-validator change, never a migration.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS boards (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'light',
     rev INTEGER NOT NULL DEFAULT 0, owner_id TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS element_rows (
     board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
     id TEXT NOT NULL,
     pos INTEGER NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (board_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_element_rows_pos ON element_rows(board_id, pos)`,
  `CREATE TABLE IF NOT EXISTS seen_ops (
     board_id TEXT NOT NULL, op_id TEXT NOT NULL, seen_at INTEGER NOT NULL,
     PRIMARY KEY (board_id, op_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_seen_ops_at ON seen_ops(seen_at)`,
  // Additive and idempotent, so it runs on every boot like the rest of the
  // schema. Serving `?owner=` is a predicate on this column, and without the
  // index SQLite scans the whole table for it.
  `CREATE INDEX IF NOT EXISTS idx_boards_owner ON boards(owner_id)`,
];

/** Row -> public `Board` wire shape. */
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
 * "Boards belonging to ?owner, plus every board nobody has claimed."
 *
 * The `OR owner_id IS NULL` half is deliberate and NOT a bug, so please do not
 * "fix" it into a plain equality: `owner_id` was added after these boards
 * already existed, and a board created without a nickname lands there too.
 * Filtering those out would make every board a person already had disappear
 * the instant they typed a nickname — the worst thing this feature could do.
 * An unowned board is a board anyone may claim; PATCH /boards/:id is the claim.
 */
const OWNER_SQL = '(owner_id = ? OR owner_id IS NULL)';

const BOARD_COLS = 'id, title, theme, rev, owner_id, created_at, updated_at';
const ORDER_SQL = 'ORDER BY created_at DESC, id ASC';

/**
 * Title search, identical to memory.js's predicate on purpose: a plain,
 * literal, Unicode-aware substring match. It runs in JS rather than as
 * `LOWER(title) LIKE ?`: SQLite's LOWER() and LIKE fold ASCII only (node:sqlite
 * has no ICU), so 'área' never found 'Área de testes' here while memory.js
 * found it, and LIKE also needed its own wildcard escaping to stay literal.
 * Only board METADATA is scanned (never an element), and the UI does not
 * search at all today.
 */
function titleMatches(title, needle) {
  return typeof title === 'string' && title.toLowerCase().includes(needle);
}

/** Freeze a parsed element (and its points): cached objects are shared. */
function freezeElement(el) {
  if (el && typeof el === 'object') {
    if (Array.isArray(el.points)) {
      for (const p of el.points) Object.freeze(p);
      Object.freeze(el.points);
    }
    Object.freeze(el);
  }
  return el;
}

/**
 * @param {{path: string, opTtlMs?: number, idFactory?: () => string}} options
 * @returns {Object} Store
 */
export function createStore(options = {}) {
  const { path } = options;
  if (typeof path !== 'string' || path === '') {
    throw new Error('sqlite store requires a `path`');
  }
  const opTtlMs = Number.isFinite(options.opTtlMs) ? options.opTtlMs : DEFAULT_OP_TTL_MS;
  const newId = options.idFactory ?? randomUUID;

  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });

  const db = new DatabaseSync(abs);

  // WAL: readers never block the writer, which is what lets a snapshot GET run
  // while an ops batch is committing.
  db.exec('PRAGMA journal_mode = WAL');
  // Without this, deleting a board would leave orphan element rows.
  db.exec('PRAGMA foreign_keys = ON');
  // THE concurrency knob: a second writer waits up to 5s for the lock instead of
  // failing immediately with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  for (const ddl of SCHEMA) db.exec(ddl);
  migrateBlobTable(db);

  let closed = false;

  // Prepared once, reused. Every value below is bound, never concatenated.
  const stmt = {
    // The listing: paged IN SQL (a page of 50 no longer reads every board),
    // with the element count from the element_rows primary-key index instead
    // of parsing each board's elements.
    pageBoards: db.prepare(
      `SELECT ${BOARD_COLS} FROM boards ${ORDER_SQL} LIMIT ? OFFSET ?`,
    ),
    countBoards: db.prepare('SELECT COUNT(*) AS n FROM boards'),
    // Same two reads, narrowed by owner. Kept as their own prepared statements
    // instead of one statement with an optional WHERE fragment: the SQL text
    // stays fixed at prepare time, so the owner value is always bound and never
    // concatenated into the query.
    pageBoardsByOwner: db.prepare(
      `SELECT ${BOARD_COLS} FROM boards WHERE ${OWNER_SQL} ${ORDER_SQL} LIMIT ? OFFSET ?`,
    ),
    countBoardsByOwner: db.prepare(`SELECT COUNT(*) AS n FROM boards WHERE ${OWNER_SQL}`),
    // Search reads metadata only and filters in JS (see titleMatches).
    allBoards: db.prepare(`SELECT ${BOARD_COLS} FROM boards ${ORDER_SQL}`),
    allBoardsByOwner: db.prepare(`SELECT ${BOARD_COLS} FROM boards WHERE ${OWNER_SQL} ${ORDER_SQL}`),
    getBoard: db.prepare(`SELECT ${BOARD_COLS} FROM boards WHERE id = ?`),
    insertBoard: db.prepare(
      'INSERT INTO boards (id, title, theme, rev, owner_id, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
    ),
    updateBoard: db.prepare(
      'UPDATE boards SET title = ?, theme = ?, owner_id = ?, updated_at = ? WHERE id = ?',
    ),
    touchBoard: db.prepare('UPDATE boards SET updated_at = ? WHERE id = ?'),
    deleteBoard: db.prepare('DELETE FROM boards WHERE id = ?'),
    getRev: db.prepare('SELECT rev FROM boards WHERE id = ?'),
    bumpRev: db.prepare('UPDATE boards SET rev = ? WHERE id = ?'),
    countEls: db.prepare('SELECT COUNT(*) AS n FROM element_rows WHERE board_id = ?'),
    readRows: db.prepare('SELECT id, pos, data FROM element_rows WHERE board_id = ? ORDER BY pos'),
    insertRow: db.prepare('INSERT INTO element_rows (board_id, id, pos, data) VALUES (?, ?, ?, ?)'),
    updateRow: db.prepare('UPDATE element_rows SET pos = ?, data = ? WHERE board_id = ? AND id = ?'),
    moveRow: db.prepare('UPDATE element_rows SET pos = ? WHERE board_id = ? AND id = ?'),
    deleteRow: db.prepare('DELETE FROM element_rows WHERE board_id = ? AND id = ?'),
    deleteRows: db.prepare('DELETE FROM element_rows WHERE board_id = ?'),
    isSeen: db.prepare('SELECT 1 AS hit FROM seen_ops WHERE board_id = ? AND op_id = ?'),
    insertSeen: db.prepare(
      'INSERT OR IGNORE INTO seen_ops (board_id, op_id, seen_at) VALUES (?, ?, ?)',
    ),
    pruneSeen: db.prepare('DELETE FROM seen_ops WHERE seen_at < ?'),
    deleteSeenForBoard: db.prepare('DELETE FROM seen_ops WHERE board_id = ?'),
  };

  /* ------------------------------------------------ parsed-board cache */

  /**
   * boardId -> {rev, elements, meta, chars}: the board's element list as of
   * `rev` (frozen objects, z-order), and per element id its row `pos` and
   * JSON length. Valid only while the stored rev still equals `rev`, and
   * every write path either refreshes or drops the entry, so a stale entry
   * can never be served. Map order is recency (oldest first).
   */
  const cache = new Map();
  let cachedChars = 0;

  /** Test seam (not part of the Store contract): what the driver did. */
  const stats = { boardLoads: 0, rowsWritten: 0, rowsDeleted: 0 };

  function cacheDrop(boardId) {
    const entry = cache.get(boardId);
    if (!entry) return;
    cachedChars -= entry.chars;
    cache.delete(boardId);
  }

  function cachePut(boardId, entry) {
    cacheDrop(boardId);
    cache.set(boardId, entry);
    cachedChars += entry.chars;
    for (const [id, old] of cache) {
      if (cache.size <= 1) break;
      if (cache.size <= CACHE_BOARDS && cachedChars <= CACHE_CHARS) break;
      if (id === boardId) continue;
      cachedChars -= old.chars;
      cache.delete(id);
    }
  }

  /** Read and parse a board's rows: O(its bytes). Only on a cache miss. */
  function loadEntry(boardId, rev) {
    stats.boardLoads += 1;
    const elements = [];
    const meta = new Map();
    let chars = 0;
    for (const row of stmt.readRows.all(boardId)) {
      elements.push(freezeElement(JSON.parse(row.data)));
      meta.set(row.id, { pos: Number(row.pos), len: row.data.length });
      chars += row.data.length;
    }
    return { rev, elements, meta, chars };
  }

  /** The board as of `rev`, from the cache when it is current. */
  function entryAt(boardId, rev) {
    const hit = cache.get(boardId);
    if (hit && hit.rev === rev) {
      // Touch: most recently used goes to the end.
      cache.delete(boardId);
      cache.set(boardId, hit);
      return hit;
    }
    const entry = loadEntry(boardId, rev);
    cachePut(boardId, entry);
    return entry;
  }

  /**
   * Persist `next` over `entry` (the board before the batch), writing only
   * what changed: a new row per created element, one UPDATE per element whose
   * object identity changed (ops.js never modifies an element in place, so
   * identity IS "changed"), a pos-only UPDATE for one that merely moved in
   * z-order, a DELETE per removed one. Positions are kept where they are
   * still increasing and only re-numbered where the order actually changed,
   * so appending or deleting never renumbers the rest of the board.
   * @returns {Object} the cache entry describing `next`
   */
  function writeDiff(boardId, entry, next, rev) {
    const prevById = new Map();
    for (const el of entry.elements) prevById.set(el.id, el);
    const meta = new Map();
    let chars = 0;
    if (next.length === 0) {
      if (entry.elements.length > 0) {
        stmt.deleteRows.run(boardId);
        stats.rowsDeleted += entry.elements.length;
      }
      return { rev, elements: next, meta, chars };
    }
    let last = null;
    for (const el of next) {
      const old = entry.meta.get(el.id);
      const pos = old !== undefined && (last === null || old.pos > last) ? old.pos : last === null ? 0 : last + 1;
      last = pos;
      const prev = prevById.get(el.id);
      let len;
      if (prev === undefined) {
        const data = JSON.stringify(el);
        stmt.insertRow.run(boardId, el.id, pos, data);
        stats.rowsWritten += 1;
        len = data.length;
      } else if (prev !== el) {
        const data = JSON.stringify(el);
        stmt.updateRow.run(pos, data, boardId, el.id);
        stats.rowsWritten += 1;
        len = data.length;
      } else {
        if (old.pos !== pos) {
          stmt.moveRow.run(pos, boardId, el.id);
          stats.rowsWritten += 1;
        }
        len = old.len;
      }
      prevById.delete(el.id);
      meta.set(el.id, { pos, len });
      chars += len;
    }
    // Whatever is left was not in `next`: deleted by this batch.
    for (const id of prevById.keys()) {
      stmt.deleteRow.run(boardId, id);
      stats.rowsDeleted += 1;
    }
    return { rev, elements: next, meta, chars };
  }

  /** A fresh, deep, mutable copy of a board's elements, for callers. */
  function readElements(boardId) {
    return stmt.readRows.all(boardId).map((row) => JSON.parse(row.data));
  }

  function guard(name, fn) {
    return async (...args) => {
      if (closed) throw new Error('store is closed (' + name + ')');
      return fn(...args);
    };
  }

  return {
    /** @returns {Promise<{boards: Object[], total: number}>} */
    listBoards: guard('listBoards', async ({ limit = 50, offset = 0, search, owner } = {}) => {
      // `search` is a case-insensitive substring on title; `total` is the
      // filtered count, so a page is never short while `total` disagrees.
      // `owner` narrows to that owner PLUS unowned boards — see OWNER_SQL.
      const useSearch = typeof search === 'string' && search.trim() !== '';
      // A present-but-empty owner is the same as no owner at all.
      const useOwner = typeof owner === 'string' && owner !== '';
      const start = Math.max(0, offset | 0);
      const unlimited = limit === undefined || limit === null;
      const size = unlimited ? -1 : Math.max(0, limit | 0); // LIMIT -1 = no limit

      let page;
      let total;
      if (useSearch) {
        const needle = search.trim().toLowerCase();
        const rows = (useOwner ? stmt.allBoardsByOwner.all(owner) : stmt.allBoards.all())
          .filter((r) => titleMatches(r.title, needle));
        total = rows.length;
        page = unlimited ? rows.slice(start) : rows.slice(start, start + size);
      } else if (useOwner) {
        total = Number(stmt.countBoardsByOwner.get(owner).n);
        page = size === 0 ? [] : stmt.pageBoardsByOwner.all(owner, size, start);
      } else {
        total = Number(stmt.countBoards.get().n);
        page = size === 0 ? [] : stmt.pageBoards.all(size, start);
      }
      return {
        boards: page.map((r) => ({
          ...toBoard(r),
          elementCount: Number(stmt.countEls.get(r.id).n),
        })),
        total,
      };
    }),

    /** @returns {Promise<Object|null>} */
    getBoard: guard('getBoard', async (id) => toBoard(stmt.getBoard.get(id) ?? null)),

    /** @returns {Promise<Object>} */
    createBoard: guard('createBoard', async ({ title, theme, ownerId, id } = {}) => {
      const boardId = id ?? newId();
      const ts = Date.now();
      const title0 = typeof title === 'string' && title !== '' ? title : 'Untitled board';
      const theme0 = theme === 'dark' ? 'dark' : 'light';
      db.exec('BEGIN IMMEDIATE');
      try {
        if (stmt.getBoard.get(boardId)) throw new Error('board already exists: ' + boardId);
        stmt.insertBoard.run(boardId, title0, theme0, ownerId ?? null, ts, ts);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      cacheDrop(boardId);
      return toBoard(stmt.getBoard.get(boardId));
    }),

    /** @returns {Promise<Object|null>} null when the board does not exist. */
    updateBoard: guard('updateBoard', async (id, patch = {}) => {
      const row = stmt.getBoard.get(id);
      if (!row) return null;
      const title = typeof patch.title === 'string' && patch.title !== '' ? patch.title : row.title;
      const theme = patch.theme === 'light' || patch.theme === 'dark' ? patch.theme : row.theme;
      // `ownerId` is assignable, and `null` means "unclaim" as well as "no
      // change" — routes/boards.js only ever passes the key when the client
      // sent it, so an absent ownerId must fall back to the stored value rather
      // than silently wiping ownership on a title-only patch.
      const ownerId =
        patch.ownerId === undefined
          ? (row.owner_id ?? null)
          : (patch.ownerId === null ? null : patch.ownerId);
      stmt.updateBoard.run(title, theme, ownerId, Date.now(), id);
      return toBoard(stmt.getBoard.get(id));
    }),

    /** @returns {Promise<boolean>} true if it existed. */
    deleteBoard: guard('deleteBoard', async (id) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        // CASCADE removes the element rows; seen_ops has no FK, so clear it
        // here or a later board reusing the id would inherit stale opIds.
        stmt.deleteSeenForBoard.run(id);
        const res = stmt.deleteBoard.run(id);
        db.exec('COMMIT');
        cacheDrop(id);
        return Number(res.changes) > 0;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }),

    /** @returns {Promise<Object[]>} in z-order, index 0 first. */
    listElements: guard('listElements', async (boardId) => readElements(boardId)),

    /** @returns {Promise<{board: Object, elements: Object[], rev: number}|null>} */
    getSnapshot: guard('getSnapshot', async (boardId) => {
      const row = stmt.getBoard.get(boardId);
      if (!row) return null;
      return {
        board: toBoard(row),
        elements: readElements(boardId),
        rev: row.rev,
      };
    }),

    /**
     * The 7 rules live in `ops.js`; what is sqlite-specific is the transaction
     * and writing only what the batch changed.
     *
     * BEGIN IMMEDIATE, NOT the default deferred BEGIN. A deferred transaction
     * takes a read lock first and only upgrades to a write lock at the first
     * write; if another connection committed in between, that upgrade fails with
     * SQLITE_BUSY_SNAPSHOT and is NOT retryable. That is exactly the concurrent
     * "two people dragging the same box" bug. IMMEDIATE takes the write lock up
     * front (waiting up to busy_timeout) and cannot be surprised by a snapshot.
     */
    applyOps: guard('applyOps', async (boardId, ops, actorId) => {
      db.exec('BEGIN IMMEDIATE');
      let result;
      let written = null;
      try {
        const revRow = stmt.getRev.get(boardId);
        const missing = revRow === undefined;
        const currentRev = missing ? 0 : Number(revRow.rev);
        let entry = null;

        result = applyOpBatch({
          ops,
          actorId,
          currentRev,
          boardMissing: missing,
          // Read inside the write lock, so the rev this entry is keyed on is
          // the rev we are about to bump.
          load: () => {
            entry = entryAt(boardId, currentRev);
            return entry.elements.slice();
          },
          isSeen: (opId) => stmt.isSeen.get(boardId, opId) !== undefined,
          recordSeen: (opIds) => {
            const ts = Date.now();
            for (const opId of opIds) stmt.insertSeen.run(boardId, opId, ts);
          },
          prune: () => {
            if (opTtlMs > 0) stmt.pruneSeen.run(Date.now() - opTtlMs);
          },
          save: (next) => {
            written = writeDiff(boardId, entry, next, currentRev + 1);
          },
          bumpRev: (rev) => stmt.bumpRev.run(rev, boardId),
          touch: () => stmt.touchBoard.run(Date.now(), boardId),
        });

        db.exec('COMMIT');
      } catch (e) {
        // Any throw — duplicate element, MAX_ELS, an invalid merged element —
        // lands here with nothing written, and the client gets a 400. The
        // cache still describes the committed board: nothing in it was
        // modified (ops.js replaces elements, it never edits them).
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back / no transaction open */
        }
        throw e;
      }
      // Only a COMMITTED batch becomes the cached board.
      if (written) cachePut(boardId, written);
      return result;
    }),

    /** Removes every element and bumps rev. A mutation, even on an empty board. */
    clearBoard: guard('clearBoard', async (boardId) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const revRow = stmt.getRev.get(boardId);
        if (revRow === undefined) {
          db.exec('ROLLBACK');
          return 0;
        }
        stmt.deleteRows.run(boardId);
        const next = Number(revRow.rev) + 1;
        stmt.bumpRev.run(next, boardId);
        stmt.touchBoard.run(Date.now(), boardId);
        db.exec('COMMIT');
        cacheDrop(boardId);
        return next;
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw e;
      }
    }),

    /** @returns {Promise<boolean>} has this opId been recorded for this board? */
    hasOp: guard('hasOp', async (boardId, opId) => stmt.isSeen.get(boardId, opId) !== undefined),

    /** Test seam: counters of loads and row writes (not part of the contract). */
    __stats() {
      return { ...stats, cachedBoards: cache.size };
    },

    async close() {
      if (closed) return;
      closed = true;
      cache.clear();
      cachedChars = 0;
      try {
        db.close();
      } catch {
        /* closing twice must not throw */
      }
    },
  };
}

/**
 * One-time upgrade of a database written by the one-blob-per-board schema
 * (`elements(board_id PRIMARY KEY, data TEXT)`): every blob becomes one row
 * per element, in the same z-order, and the old table is dropped. Runs in
 * one transaction on boot, so a crash half-way leaves the old table intact
 * and the next boot simply tries again. A no-op on any newer database.
 */
function migrateBlobTable(db) {
  const legacy = db
    .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'elements'")
    .get();
  if (!legacy) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Only boards that still exist: the old table cascaded, but be defensive,
    // since element_rows enforces the foreign key.
    const blobs = db
      .prepare('SELECT e.board_id AS board_id, e.data AS data FROM elements e JOIN boards b ON b.id = e.board_id')
      .all();
    const insert = db.prepare(
      'INSERT OR REPLACE INTO element_rows (board_id, id, pos, data) VALUES (?, ?, ?, ?)',
    );
    for (const { board_id: boardId, data } of blobs) {
      let list;
      try {
        list = JSON.parse(data);
      } catch {
        list = [];
      }
      if (!Array.isArray(list)) continue;
      list.forEach((el, i) => {
        if (el && typeof el === 'object' && typeof el.id === 'string' && el.id !== '') {
          insert.run(boardId, el.id, i, JSON.stringify(el));
        }
      });
    }
    db.exec('DROP TABLE elements');
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* nothing to roll back */
    }
    throw e;
  }
}

export default createStore;
