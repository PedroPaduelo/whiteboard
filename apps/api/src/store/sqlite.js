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

/** Schema from docs/API_CONTRACT.md "Persistence notes", verbatim. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS boards (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'light',
     rev INTEGER NOT NULL DEFAULT 0, owner_id TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  // Elements as one JSON blob per board: the whole board is one document, and
  // every read wants all of it. Rows-per-element would only add joins and
  // N+1s on the one query that matters.
  `CREATE TABLE IF NOT EXISTS elements (
     board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
     data TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS seen_ops (
     board_id TEXT NOT NULL, op_id TEXT NOT NULL, seen_at INTEGER NOT NULL,
     PRIMARY KEY (board_id, op_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_seen_ops_at ON seen_ops(seen_at)`,
].join(';\n');

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
 * escapeLike() is load-bearing, not defensive noise: without it a search for
 * "100%" becomes a wildcard and stops matching the literal substring that
 * memory.js's plain substring match returns. The two drivers must agree on
 * every input; store.test.js runs the same suite against both, including a
 * wildcard case, so dropping the escaping fails the suite rather than
 * silently diverging. The value is still bound, never concatenated.
 */
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
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
  for (const ddl of SCHEMA.split(';\n')) {
    const sql = ddl.trim();
    if (sql) db.exec(sql);
  }

  let closed = false;

  // Prepared once, reused. Every value below is bound, never concatenated.
  const stmt = {
    listBoards: db.prepare(
      'SELECT id, title, theme, rev, owner_id, created_at, updated_at FROM boards ORDER BY created_at DESC, id ASC',
    ),
    searchBoards: db.prepare(
      "SELECT id, title, theme, rev, owner_id, created_at, updated_at FROM boards WHERE LOWER(title) LIKE ? ESCAPE '\\' ORDER BY created_at DESC, id ASC",
    ),
    getBoard: db.prepare(
      'SELECT id, title, theme, rev, owner_id, created_at, updated_at FROM boards WHERE id = ?',
    ),
    insertBoard: db.prepare(
      'INSERT INTO boards (id, title, theme, rev, owner_id, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
    ),
    updateBoard: db.prepare('UPDATE boards SET title = ?, theme = ?, updated_at = ? WHERE id = ?'),
    touchBoard: db.prepare('UPDATE boards SET updated_at = ? WHERE id = ?'),
    deleteBoard: db.prepare('DELETE FROM boards WHERE id = ?'),
    getRev: db.prepare('SELECT rev FROM boards WHERE id = ?'),
    bumpRev: db.prepare('UPDATE boards SET rev = ? WHERE id = ?'),
    getElements: db.prepare('SELECT data FROM elements WHERE board_id = ?'),
    countEls: db.prepare(
      'SELECT (SELECT json_array_length(data) FROM elements WHERE board_id = ?) AS n',
    ),
    upsertElements: db.prepare(
      'INSERT INTO elements (board_id, data) VALUES (?, ?) ON CONFLICT(board_id) DO UPDATE SET data = excluded.data',
    ),
    isSeen: db.prepare('SELECT 1 AS hit FROM seen_ops WHERE board_id = ? AND op_id = ?'),
    insertSeen: db.prepare(
      'INSERT OR IGNORE INTO seen_ops (board_id, op_id, seen_at) VALUES (?, ?, ?)',
    ),
    pruneSeen: db.prepare('DELETE FROM seen_ops WHERE seen_at < ?'),
    deleteSeenForBoard: db.prepare('DELETE FROM seen_ops WHERE board_id = ?'),
  };

  function guard(name, fn) {
    return async (...args) => {
      if (closed) throw new Error('store is closed (' + name + ')');
      return fn(...args);
    };
  }

  const parseElements = (row) => {
    if (!row) return [];
    const parsed = JSON.parse(row.data);
    return Array.isArray(parsed) ? parsed : [];
  };

  return {
    /** @returns {Promise<{boards: Object[], total: number}>} */
    listBoards: guard('listBoards', async ({ limit = 50, offset = 0, search } = {}) => {
      // `search` is a case-insensitive substring on title; `total` is the
      // filtered count, so a page is never short while `total` disagrees.
      const useSearch = typeof search === 'string' && search.trim() !== '';
      const rows = useSearch
        ? stmt.searchBoards.all('%' + escapeLike(search.trim().toLowerCase()) + '%')
        : stmt.listBoards.all();

      const total = rows.length;
      const start = Math.max(0, offset | 0);
      const size = limit === undefined || limit === null ? total - start : Math.max(0, limit | 0);
      const page = rows.slice(start, start + size);
      return {
        boards: page.map((r) => ({
          ...toBoard(r),
          elementCount: stmt.countEls.get(r.id).n,
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
        // Always start with an (empty) element blob so listElements/applyOps
        // never have to special-case a missing row.
        stmt.upsertElements.run(boardId, '[]');
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return toBoard(stmt.getBoard.get(boardId));
    }),

    /** @returns {Promise<Object|null>} null when the board does not exist. */
    updateBoard: guard('updateBoard', async (id, patch = {}) => {
      const row = stmt.getBoard.get(id);
      if (!row) return null;
      const title = typeof patch.title === 'string' && patch.title !== '' ? patch.title : row.title;
      const theme = patch.theme === 'light' || patch.theme === 'dark' ? patch.theme : row.theme;
      stmt.updateBoard.run(title, theme, Date.now(), id);
      return toBoard(stmt.getBoard.get(id));
    }),

    /** @returns {Promise<boolean>} true if it existed. */
    deleteBoard: guard('deleteBoard', async (id) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        // CASCADE removes the element blob; seen_ops has no FK, so clear it here
        // or a later board reusing the id would inherit stale opIds.
        stmt.deleteSeenForBoard.run(id);
        const res = stmt.deleteBoard.run(id);
        db.exec('COMMIT');
        return Number(res.changes) > 0;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }),

    /** @returns {Promise<Object[]>} in z-order, index 0 first. */
    listElements: guard('listElements', async (boardId) =>
      parseElements(stmt.getElements.get(boardId)),
    ),

    /** @returns {Promise<{board: Object, elements: Object[], rev: number}|null>} */
    getSnapshot: guard('getSnapshot', async (boardId) => {
      const row = stmt.getBoard.get(boardId);
      if (!row) return null;
      return {
        board: toBoard(row),
        elements: parseElements(stmt.getElements.get(boardId)),
        rev: row.rev,
      };
    }),

    /**
     * The 7 rules live in `ops.js`; what is sqlite-specific is the transaction.
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
      try {
        const revRow = stmt.getRev.get(boardId);
        const missing = revRow === undefined;

        result = applyOpBatch({
          ops,
          actorId,
          currentRev: missing ? 0 : Number(revRow.rev),
          boardMissing: missing,
          load: () => parseElements(stmt.getElements.get(boardId)),
          isSeen: (opId) => stmt.isSeen.get(boardId, opId) !== undefined,
          recordSeen: (opIds) => {
            const ts = Date.now();
            for (const opId of opIds) stmt.insertSeen.run(boardId, opId, ts);
          },
          prune: () => {
            if (opTtlMs > 0) stmt.pruneSeen.run(Date.now() - opTtlMs);
          },
          save: (next) => stmt.upsertElements.run(boardId, JSON.stringify(next)),
          bumpRev: (rev) => stmt.bumpRev.run(rev, boardId),
          touch: () => stmt.touchBoard.run(Date.now(), boardId),
        });

        db.exec('COMMIT');
      } catch (e) {
        // Any throw — duplicate element, MAX_ELS, an invalid merged element —
        // lands here with nothing written, and the client gets a 400.
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back / no transaction open */
        }
        throw e;
      }
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
        stmt.upsertElements.run(boardId, '[]');
        const next = Number(revRow.rev) + 1;
        stmt.bumpRev.run(next, boardId);
        stmt.touchBoard.run(Date.now(), boardId);
        db.exec('COMMIT');
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

    async close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        /* closing twice must not throw */
      }
    },
  };
}

export default createStore;
