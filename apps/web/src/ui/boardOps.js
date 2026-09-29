/**
 * boardOps.js — board-level operations the board list runs over HTTP, kept out
 * of the component so they are plain functions testable in node.
 *
 * Duplicating a board = create the copy, then replay the source's elements
 * into it as `create` ops cloned with `cloneElements` (fresh ids, bindings and
 * groups remapped). The ops MUST be posted to the COPY's `/boards/<id>/ops`:
 * the server applies a batch to the board in the URL and ignores `op.boardId`,
 * so posting them anywhere else writes the clones into that other board (the
 * old code bound the request to the source board and doubled its content
 * while leaving the copy empty).
 */

import { cloneElements } from '../editor/elements.js';
import { api, newOpId } from '../api/client.js';

/** The server accepts at most 200 ops per batch; stay well under it. */
export const COPY_BATCH_OPS = 150;
/** …and keep a batch's JSON well under the API body limit (8 MB), since image elements carry data URLs. */
export const COPY_BATCH_BYTES = 2_000_000;

/**
 * `create` ops for copies of `source` on board `targetId`. `locked` is kept
 * (cloneElements drops it) when the copies line up one-to-one with the source.
 * @returns {object[]}
 */
export function duplicateOps(source, targetId, { now = Date.now(), makeOpId = newOpId } = {}) {
  const list = Array.isArray(source) ? source : [];
  if (!list.length || !targetId) return [];
  const cloned = cloneElements(list);
  const copies = cloned.length === list.length ? cloned.map((el, i) => (list[i].locked ? { ...el, locked: true } : el)) : cloned;
  return copies.map((element) => ({ opId: makeOpId(), boardId: targetId, kind: 'create', element, at: now }));
}

/**
 * Split ops into batches bounded by count and by serialised size. A single op
 * larger than the byte budget still goes out, alone.
 * @returns {object[][]}
 */
export function chunkOps(ops, { maxOps = COPY_BATCH_OPS, maxBytes = COPY_BATCH_BYTES } = {}) {
  const out = [];
  let batch = [];
  let bytes = 0;
  for (const op of ops ?? []) {
    const size = JSON.stringify(op).length;
    if (batch.length && (batch.length >= maxOps || bytes + size > maxBytes)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(op);
    bytes += size;
  }
  if (batch.length) out.push(batch);
  return out;
}

/**
 * Copy every element of board `sourceId` into board `targetId`.
 *
 * `http` is injectable for tests; it defaults to the app's API client. Any
 * failed request stops the copy and resolves `{ok:false}` (never rejects for a
 * server refusal) so the caller can say the copy is incomplete.
 *
 * @returns {Promise<{ok: boolean, count: number, copied: number, error?: string}>}
 */
export async function copyBoardElements(sourceId, targetId, { http = api, now } = {}) {
  if (!sourceId || !targetId || sourceId === targetId) return { ok: false, count: 0, copied: 0, error: 'bad board ids' };
  const snap = await http.get(`/boards/${encodeURIComponent(sourceId)}`);
  const source = Array.isArray(snap?.elements) ? snap.elements : [];
  const ops = duplicateOps(source, targetId, { now });
  let copied = 0;
  for (const batch of chunkOps(ops)) {
    try {
      // The TARGET's endpoint: this is what decides where the elements land.
      await http.post(`/boards/${encodeURIComponent(targetId)}/ops`, { ops: batch });
    } catch (err) {
      return { ok: false, count: ops.length, copied, error: err?.message ?? String(err) };
    }
    copied += batch.length;
  }
  return { ok: true, count: ops.length, copied };
}

/* --- the paged board list ------------------------------------------------------ */

/** Rows per request of the board list (the server's default page is 50 too). */
export const BOARD_PAGE_SIZE = 50;

/** The rows of one `GET /boards` reply (`{boards, total}` or a bare array). */
export function pageRows(page) {
  return Array.isArray(page) ? page : Array.isArray(page?.boards) ? page.boards : [];
}

/** The server's total for one reply, or null when it did not say. */
export function pageTotal(page) {
  return typeof page?.total === 'number' && Number.isFinite(page.total) ? page.total : null;
}

/**
 * Every loaded row, once. Offset paging can repeat a row when a board is
 * created between two requests (everything shifts down by one); the first
 * copy wins.
 */
export function mergeBoardPages(pages) {
  const seen = new Set();
  const out = [];
  for (const page of pages ?? []) {
    for (const b of pageRows(page)) {
      if (!b || !b.id || seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
    }
  }
  return out;
}

/**
 * Offset of the next page, or undefined when everything is loaded (TanStack's
 * "no next page"). Counts raw rows, not de-duplicated ones, so the offset
 * matches what the server skipped.
 */
export function nextPageOffset(lastPage, pages) {
  const rows = pageRows(lastPage);
  if (!rows.length) return undefined;
  const loaded = (pages ?? []).reduce((n, p) => n + pageRows(p).length, 0);
  const total = pageTotal(lastPage);
  if (total === null) return rows.length < BOARD_PAGE_SIZE ? undefined : loaded;
  return loaded < total ? loaded : undefined;
}

/** `GET /boards` query string for one page. */
export function boardListQuery({ owner, search, offset = 0, limit = BOARD_PAGE_SIZE }) {
  const params = new URLSearchParams();
  if (owner) params.set('owner', owner);
  const q = typeof search === 'string' ? search.trim() : '';
  if (q) params.set('search', q);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `/boards?${params.toString()}`;
}
