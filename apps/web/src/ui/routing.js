/**
 * routing.js — the app's two routes (board list, one board) as plain
 * functions over URLs, so they run in node tests. App.jsx wires them to
 * `window.location` and the History API.
 *
 * Moving between the list and a board is a real navigation: it PUSHES a
 * history entry, so the browser's Back returns to the list and Forward
 * reopens the board. (Every navigation used to `replaceState`, so the
 * history never grew, the popstate listener never fired, and Back left the
 * app altogether.) Only a rewrite of the SAME place — the canonical form of
 * the URL already shown — replaces.
 */

const DEFAULT_ORIGIN = 'http://localhost';

function originOf(loc) {
  return loc?.origin || DEFAULT_ORIGIN;
}

/**
 * Board id out of a URL, in priority order:
 *   ?board=<id>   the canonical form we write
 *   /b/<id>       the share-link form (what the Share button copies)
 *   /<id>         tolerated, so a bare pasted id still opens
 * Returns null for the board list (`/`, and `/b` with no id).
 */
export function resolveBoardId(href, origin = DEFAULT_ORIGIN) {
  let url;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }

  const q = url.searchParams.get('board');
  if (q) return q;

  const path = url.pathname.replace(/\/+$/, '');
  const byPath = path.match(/^\/b\/([^/]+)/);
  if (byPath) return safeDecode(byPath[1]);
  // `/b` alone is the share-link prefix without an id: the list, not a board called "b".
  if (path === '/b') return null;

  // Tolerate a bare `/<id>` so a pasted id still opens, but not a file path.
  const bare = path.replace(/^\//, '');
  if (bare && !bare.includes('/') && !bare.includes('.') && !bare.startsWith('api')) {
    return safeDecode(bare);
  }
  return null;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The address-bar path for a board: `/b/<id>?board=<id>` (other query params
 * kept). For null, the root — the list — so a reload does not reopen the
 * board that was just left.
 */
export function boardUrl(boardId, href = `${DEFAULT_ORIGIN}/`, origin = DEFAULT_ORIGIN) {
  if (!boardId) return '/';
  const url = new URL(href, origin);
  url.pathname = `/b/${encodeURIComponent(boardId)}`;
  url.searchParams.set('board', boardId);
  return `${url.pathname}${url.search}`;
}

/**
 * How to move the address bar from `currentHref` to board `nextBoardId`:
 *   'none'     already there, byte for byte
 *   'replace'  same board (or both the list), only the URL's form changes
 *   'push'     a different place: a new history entry
 * @returns {{mode: 'none'|'replace'|'push', url: string}}
 */
export function planNavigation(currentHref, nextBoardId, origin = DEFAULT_ORIGIN) {
  const url = boardUrl(nextBoardId, currentHref, origin);
  let here = '';
  try {
    const u = new URL(currentHref, origin);
    here = `${u.pathname}${u.search}`;
  } catch {
    here = '';
  }
  if (here === url) return { mode: 'none', url };
  const currentId = resolveBoardId(currentHref, origin);
  return { mode: (currentId ?? null) === (nextBoardId ?? null) ? 'replace' : 'push', url };
}

/** Apply `planNavigation` to the real window (no-op outside a browser). */
export function navigateTo(boardId, win = typeof window !== 'undefined' ? window : null) {
  if (!win?.history || !win.location) return;
  const plan = planNavigation(win.location.href, boardId ?? null, originOf(win.location));
  const state = { boardId: boardId ?? null };
  if (plan.mode === 'push') win.history.pushState(state, '', plan.url);
  else if (plan.mode === 'replace') win.history.replaceState(state, '', plan.url);
}
