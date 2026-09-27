/**
 * Store factory.
 *
 * Picks a driver from `config.storage` and returns a Store. Both drivers
 * implement the interface in docs/API_CONTRACT.md exactly; `memory.js` is the
 * reference implementation and `sqlite.js` is the durable one, and the batch
 * semantics they share live in `ops.js` so they cannot drift.
 *
 *     import { createStore } from './store/index.js';
 *     const store = createStore(config);   // config.storage === 'sqlite'|'memory'
 */

import config from '../config.js';
import { createStore as createMemoryStore } from './memory.js';
import { createStore as createSqliteStore } from './sqlite.js';

export { createStore as createMemoryStore } from './memory.js';
export { createStore as createSqliteStore } from './sqlite.js';
export { applyOpBatch } from './ops.js';

/**
 * @param {Object} [cfg] the frozen config from `src/config.js`; defaults to it
 * @param {'sqlite'|'memory'} [cfg.storage]
 * @param {string} [cfg.sqlitePath] file path for the sqlite driver
 * @param {number} [cfg.opDedupeTtlMs] how long a recorded opId is deduped
 * @returns {Object} Store
 */
export function createStore(cfg = config) {
  const storage = cfg?.storage ?? 'memory';
  if (storage === 'memory') {
    return createMemoryStore({ opTtlMs: cfg?.opDedupeTtlMs });
  }
  if (storage === 'sqlite') {
    return createSqliteStore({ path: cfg?.sqlitePath ?? './data/whiteboard.db', opTtlMs: cfg?.opDedupeTtlMs });
  }
  throw new Error(`unknown storage driver: ${storage} (expected sqlite|memory)`);
}

export default createStore;
