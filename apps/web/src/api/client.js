/**
 * HTTP client for the whiteboard API.
 *
 * Two things this file is careful about, because both fail silently when
 * gotten wrong:
 *
 *  1. The WebSocket URL. The API lives at `http://host/api` but the socket
 *     lives at `http://host/api/ws`. There is no such thing as "it just
 *     worked" here — a wrong URL produces a socket that opens and then dies,
 *     or never opens at all, and collaboration silently does not exist. The
 *     derivation is written out in full and loudly commented so it can be
 *     audited at a glance.
 *  2. `localStorage`. Safari private mode throws on `setItem` (quota) and
 *     some embedded webviews throw on *access*. A whiteboard that cannot boot
 *     because it could not store a peer id is not acceptable, so every
 *     access is wrapped and falls back to an in-memory id.
 */

import { QueryClient } from '@tanstack/react-query';
import { nanoid } from 'nanoid';

/**
 * Base URL for every REST call. `/api` included — routes are prefixed.
 *
 * The default is RELATIVE (`/api`), not an absolute `http://localhost:3001`.
 * That is the single most important default in this file.
 *
 * An absolute localhost default works on the developer's machine and breaks
 * everywhere else, in a way that looks like a network error rather than a
 * misconfiguration: the browser resolves `localhost` to ITS OWN machine, so
 * behind a reverse proxy, a preview URL or a published static host the app
 * silently fetches from the visitor's laptop and gets `ERR_CONNECTION_REFUSED`
 * with no hint that the API is fine.
 *
 * Relative also means same-origin, so the deployment serves web and API from
 * one host and needs no CORS at all. `VITE_API_URL` still wins when the two
 * are genuinely split across hosts; set it in the build environment then.
 */
export const API_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) ||
  '/api';

/**
 * Derive the WebSocket URL from the API URL.
 *
 * `http://localhost:3001/api`  ->  `ws://localhost:3001/api/ws`
 * `https://board.example/api`  ->  `wss://board.example/api/ws`
 * `/api` (relative, same-origin via the vite proxy)  ->  `/api/ws`
 *
 * The trailing-slash dance matters: `http://host/api/` must not become
 * `http://host/api//ws`, and a URL with no path at all must still get `/ws`.
 */
function deriveWsUrl(apiUrl) {
  const trimmed = String(apiUrl).replace(/\/+$/, ''); // kill trailing slashes
  if (/^https?:\/\//i.test(trimmed)) {
    const ws = trimmed.replace(/^http/i, 'ws'); // http->ws, https->wss
    return `${ws}/ws`;
  }
  // Relative or protocol-relative: leave the origin alone and just append.
  return `${trimmed}/ws`;
}

/** WebSocket endpoint. `VITE_WS_URL` wins if set, otherwise derived. */
export const WS_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_WS_URL) ||
  deriveWsUrl(API_URL);

/** Thrown for every non-2xx response. Carries what callers branch on. */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{status: number, code?: string, body?: unknown, path?: string}} info
   */
  constructor(message, { status, code, body, path } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? 0;
    this.code = code ?? null;
    this.body = body ?? null;
    this.path = path ?? null;
  }

  /** True for the rev-mismatch case; `useApplyOps` resyncs on it. */
  get isConflict() {
    return this.status === 409;
  }
}

const NETWORK_MESSAGE =
  `Could not reach the API at ${API_URL}. ` +
  'Check that the server is running and that VITE_API_URL points at it ' +
  '(this is a connection failure, not an application error).';

/**
 * Perform one JSON request.
 *
 * @param {string} path  Path relative to API_URL, e.g. `/boards/abc`.
 * @param {{method?: string, body?: unknown, signal?: AbortSignal, headers?: Record<string,string>}} [opts]
 * @returns {Promise<any>} parsed JSON, or `null` for 204/empty bodies
 */
export async function request(path, { method = 'GET', body, signal, headers } = {}) {
  const url = `${API_URL}${path}`;
  const init = {
    method,
    signal,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : null),
      ...headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Aborts are the caller's business, not ours — rethrow untouched.
    if (err && err.name === 'AbortError') throw err;
    // "Failed to fetch" tells a user nothing. Say what was actually attempted.
    const cause = err && err.message ? ` (${err.message})` : '';
    throw new ApiError(`${NETWORK_MESSAGE}${cause}`, { status: 0, path });
  }

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // A non-JSON body on an error response is still an error worth showing.
      payload = { message: text.slice(0, 500) };
    }
  }

  if (!res.ok) {
    const body = payload;
    const code =
      (body && (body.code || body.error)) ||
      (res.headers.get('x-error-code') || null) ||
      null;
    const message =
      (body && (body.message || body.error_description)) ||
      `${method} ${url} failed with ${res.status} ${res.statusText}`.trim();
    throw new ApiError(message, { status: res.status, code, body, path });
  }

  return payload;
}

/** Ergonomic verb wrappers. Paths are relative to API_URL. */
export const api = {
  get: (path, opts) => request(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
};

/**
 * The app-wide TanStack Query client. `main.jsx` wires this into
 * `<QueryClientProvider>`. Defaults come from the contract: 5s stale, 1 retry.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

/** Short, URL-safe id. */
export const newId = () => nanoid(10);

/** Short, URL-safe op id — the server dedupes batches on these. */
export const newOpId = () => nanoid(12);

/** Fallback registry so a blocked localStorage still yields a stable-per-session id. */
const memoryIds = new Map();

/**
 * A stable id for this browser on this board, so reconnects are recognisable
 * as the same participant. Every storage access is guarded: Safari private
 * mode throws on `setItem`, and some webviews throw on property access.
 *
 * @param {string} boardId
 * @returns {string}
 */
export function getActorId(boardId) {
  const key = `whiteboard:peer:${boardId}`;

  // The session fallback wins over a fresh read: if the earlier write was
  // rejected, the only stable value this browser has is the one we kept.
  const remembered = memoryIds.get(key);
  if (remembered) return remembered;

  try {
    const hit = window.localStorage.getItem(key);
    if (hit) {
      memoryIds.set(key, hit);
      return hit;
    }
  } catch {
    /* storage unavailable (private mode, disabled cookies, sandboxed iframe) */
  }

  const id = newId();
  memoryIds.set(key, id);
  try {
    window.localStorage.setItem(key, id);
  } catch {
    /* quota exceeded — the in-memory value above keeps this session stable */
  }
  return id;
}

/** Drop a cached actor id (board switcher, tests). Never throws. */
export function forgetActorId(boardId) {
  const key = `whiteboard:peer:${boardId}`;
  memoryIds.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}
