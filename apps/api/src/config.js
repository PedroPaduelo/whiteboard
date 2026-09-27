/**
 * Runtime configuration — the single source of truth for anything tunable.
 *
 * Parsed exactly once, at import time, and frozen. Reading `process.env` from
 * deep inside a route handler is how a service ends up with two different
 * ports in two different code paths; every consumer imports this instead.
 *
 * Every key has a working default, so `node src/server.js` with no env at all
 * boots a fully functional dev instance.
 */

const isProduction = process.env.NODE_ENV === 'production';

function str(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  return trimmed === '' ? fallback : trimmed;
}

function int(key, fallback) {
  const raw = str(key, undefined);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new TypeError(`Invalid ${key}: ${JSON.stringify(raw)} is not a number`);
  }
  return Math.trunc(n);
}

function bool(key, fallback) {
  const raw = str(key, undefined);
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new TypeError(`Invalid ${key}: ${JSON.stringify(raw)} is not a boolean`);
}

/**
 * `*` means "any origin" and is preserved as the single-element list `['*']`
 * so consumers never have to special-case a raw string. Anything else is a
 * comma-separated allowlist, trimmed and de-duplicated.
 */
function list(key, fallback) {
  const raw = str(key, undefined);
  if (raw === undefined) return fallback;
  if (raw === '*') return ['*'];
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) return fallback;
  if (parts.includes('*')) return ['*'];
  return [...new Set(parts)];
}

function oneOf(key, allowed, fallback) {
  const raw = str(key, undefined);
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (!allowed.includes(v)) {
    throw new TypeError(`Invalid ${key}: ${JSON.stringify(raw)} is not one of ${allowed.join(', ')}`);
  }
  return v;
}

function prefix(key, fallback) {
  let p = str(key, fallback);
  if (!p.startsWith('/')) p = `/${p}`;
  // No trailing slash: '/api/' would make every route declaration '/api//boards'.
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  return p === '/' ? '' : p;
}

const corsOrigin = list('CORS_ORIGIN', ['*']);

const config = Object.freeze({
  isProduction,
  nodeEnv: str('NODE_ENV', isProduction ? 'production' : 'development'),

  // --- HTTP listener ---
  host: str('HOST', '0.0.0.0'),
  port: int('PORT', 3001),

  /** Prefix every route hangs off. `API_PREFIX=/api` -> `/api/boards`. */
  apiPrefix: prefix('API_PREFIX', '/api'),

  /** `['*']` or an exact-match allowlist. See plugins/cors.js. */
  corsOrigin,

  /** Bytes. Anything larger gets a 413 before the handler runs. */
  bodyLimit: int('BODY_LIMIT', 8 * 1024 * 1024),

  logLevel: str('LOG_LEVEL', isProduction ? 'info' : 'info'),

  /** Honour X-Forwarded-*. Only enable behind a proxy you control. */
  trustProxy: bool('TRUST_PROXY', false),

  // --- Storage ---
  /** 'sqlite' (durable) or 'memory' (tests, throwaway dev). */
  storage: oneOf('STORAGE', ['sqlite', 'memory'], 'sqlite'),
  sqlitePath: str('SQLITE_PATH', './data/whiteboard.db'),

  // --- Realtime ---
  /** Drop a peer that has not pinged within this window. */
  wsPeerTtlMs: int('WS_PEER_TTL_MS', 30_000),
  /** Minimum gap between two cursor broadcasts from the same peer. */
  wsCursorRateMs: int('WS_CURSOR_RATE_MS', 33),

  /** How long a recorded opId suppresses a retried batch. */
  opDedupeTtlMs: int('OP_DEDUPE_TTL_MS', 86_400_000),

  // --- First run ---
  /** Populate a starter board when the store is empty. Off in production. */
  seedDemoBoard: bool('SEED_DEMO_BOARD', !isProduction),
});

export default config;
export { isProduction };
