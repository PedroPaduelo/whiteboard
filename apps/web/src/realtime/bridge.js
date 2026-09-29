/**
 * The binding between the realtime client and the board store: every server
 * message becomes a store write here, and nowhere else. Plain JS (no React),
 * so the whole protocol — ready, broadcasts, acks, resync, cursors, presence,
 * collaborators' selections — is exercised in node by
 * `apps/web/test/realtime.test.js`.
 *
 * The one idea that makes collaboration converge: **the server applies ops in
 * arrival order, so the local board must look like "server state + my ops
 * that the server has not acknowledged yet"**. Every network write is
 * therefore followed by re-applying this client's pending ops on top:
 *
 *  - a remote batch: `applyRemoteOps(theirOps, myPendingOps)`. If a peer and
 *    I both moved the same shape and my batch is still in flight, the server
 *    will apply mine AFTER theirs, so mine must win locally too (and my
 *    pending creates land above theirs, as on the server);
 *  - `ready` (first join and every reconnect) and every resync: the fresh
 *    snapshot with the pending ops re-applied (`store.resyncSnapshot`), so
 *    the author keeps seeing edits that are still on their way.
 *
 * All of it runs inside `withRemote`, so the sync bridge never ships the
 * network's own state back as new ops.
 *
 * A resync snapshot can be OLDER than what this client already shows: while
 * the GET is in flight, peers keep editing and their broadcasts (and our own
 * acks) keep arriving. Applying it as is rolled those edits back for good —
 * a broadcast only carries its own ops, so nothing would ever bring them
 * back. So every applied batch whose ops we know is remembered by rev (the
 * server bumps the rev exactly once per applied batch), and a snapshot at rev
 * R is brought up to date by replaying the remembered batches after R before
 * the pending ops go on top. Only when a rev in between is unknown does the
 * resync fetch again, with backoff.
 */

import { CURSOR_TTL_MS, useBoardStore, applyOpsToElements, settleConnectors } from '../store/boardStore.js';
import { api } from '../api/client.js';
import { realtime as defaultClient } from './realtime.js';
import { storeSync as defaultSync, withRemote } from './sync.js';

/**
 * How many times a resync refetches a snapshot it cannot bring up to date (a
 * rev in between is unknown — rare: every applied batch reaches this client
 * as a broadcast or an ack). After that the snapshot is applied with what is
 * known, as before.
 */
const MAX_STALE_REFETCH = 4;

/** Backoff between those refetches: 50 ms, 100 ms, 200 ms, 400 ms. */
const REFETCH_BASE_MS = 50;
const REFETCH_MAX_MS = 1000;

/** How many applied batches (by rev) are remembered for replaying over an older snapshot. */
const BATCH_LOG_LIMIT = 1000;

/** What the store's error says when the board does not exist (any of the three signals). */
export const BOARD_MISSING_MESSAGE = 'Este quadro não existe mais.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The batches the server applied, by rev, as far as this client knows them
 * (broadcasts from others, and our own acked batches).
 */
export class BatchLog {
  constructor(limit = BATCH_LOG_LIMIT) {
    this.limit = limit;
    /** @type {Map<number, object[]>} */
    this.byRev = new Map();
  }

  add(rev, ops) {
    if (!Number.isFinite(rev) || rev <= 0 || !Array.isArray(ops) || ops.length === 0) return;
    this.byRev.set(rev, ops);
    while (this.byRev.size > this.limit) this.byRev.delete(this.byRev.keys().next().value);
  }

  /** Forget everything at or below `rev` (a snapshot at `rev` already holds it). */
  dropThrough(rev) {
    if (!Number.isFinite(rev)) return;
    for (const r of this.byRev.keys()) if (r <= rev) this.byRev.delete(r);
  }

  clear() {
    this.byRev.clear();
  }

  /**
   * The remembered batches with a rev in (from, to], in rev order, and
   * whether every rev in that range was known.
   * @returns {{batches: object[][], complete: boolean}}
   */
  between(from, to) {
    const batches = [];
    if (to - from > this.limit) return { batches, complete: false };
    let complete = true;
    for (let r = Math.floor(from) + 1; r <= to; r++) {
      const ops = this.byRev.get(r);
      if (ops) batches.push(ops);
      else complete = false;
    }
    return { batches, complete };
  }
}

/**
 * A snapshot brought forward by `batches` (each applied like the server
 * does: in order, then one connector pass). Pure.
 */
export function replayOnto(elements, batches) {
  let out = elements;
  for (const ops of batches) {
    const step = applyOpsToElements(out, ops);
    out = step.geometry ? settleConnectors(step.elements) : step.elements;
  }
  return out;
}

/** GET the board snapshot (`{board, elements, rev}`). */
export function fetchBoardSnapshot(boardId) {
  return api.get(`/boards/${encodeURIComponent(boardId)}/snapshot`);
}

/**
 * Apply a server snapshot to the store the right way: skipped when it is
 * older than what this board already shows, otherwise
 * `resyncSnapshot(snapshot, pendingOps)` inside `withRemote`. Use this for the
 * HTTP seed of a board as well; a bare `setSnapshot` would drop edits still
 * in the outbox from the author's own screen.
 *
 * @param {{board: object, elements: object[], rev: number}} snapshot
 * @param {{client?: object, sync?: object, store?: object, force?: boolean}} [deps]
 * @returns {boolean} whether it was applied
 */
export function applyServerSnapshot(snapshot, { client = defaultClient, sync = defaultSync, store = useBoardStore, force = false } = {}) {
  if (!snapshot || !snapshot.board || !Array.isArray(snapshot.elements)) return false;
  const s = store.getState();
  const stale =
    s.board && s.boardId === snapshot.board.id && Number.isFinite(snapshot.rev) && snapshot.rev < s.rev;
  if (stale && !force) return false;
  const pending = pendingOf(client, sync);
  withRemote(() => store.getState().resyncSnapshot(snapshot, pending));
  return true;
}

/** Everything this client has not had acknowledged: in flight, queued, and still debouncing. */
function pendingOf(client, sync) {
  const a = typeof client?.pendingOps === 'function' ? client.pendingOps() : [];
  const b = typeof sync?.pendingOps === 'function' ? sync.pendingOps() : [];
  return b.length ? [...a, ...b] : a;
}

/**
 * Wire `client.handlers` to the store and start the sync bridge.
 *
 * @param {object} [deps]
 * @param {import('./realtime.js').RealtimeClient} [deps.client]
 * @param {import('./sync.js').StoreSync} [deps.sync]
 * @param {object} [deps.store]  the zustand store hook (getState/subscribe)
 * @param {(boardId: string) => Promise<{board, elements, rev}>} [deps.fetchSnapshot]
 * @param {(message: string, info: object) => void} [deps.onError]  e.g. a toast
 * @param {boolean} [deps.pruneCursors]  sweep stale cursors (default true)
 * @returns {() => void} detach: stops the sync bridge (flushing it) and unwires
 */
export function attachRealtime({
  client = defaultClient,
  sync = defaultSync,
  store = useBoardStore,
  fetchSnapshot = fetchBoardSnapshot,
  onError = null,
  pruneCursors = true,
} = {}) {
  const S = () => store.getState();
  const pending = () => pendingOf(client, sync);
  let alive = true;
  /** Applied batches by rev, for bringing an older resync snapshot up to date. */
  const log = new BatchLog();
  let logBoard = client.boardId;
  const logFor = (boardId) => {
    if (boardId !== logBoard) {
      log.clear();
      logBoard = boardId;
    }
    return log;
  };

  // ------------------------------------------------------------- resync
  let resyncing = false;
  let again = false;

  /** Fetch the snapshot and converge on it, keeping pending edits. Coalesced. */
  async function resync() {
    if (resyncing) {
      again = true;
      return;
    }
    resyncing = true;
    let staleRefetches = 0;
    try {
      do {
        again = false;
        const boardId = client.boardId;
        if (!boardId || !alive || client.fatal) break;
        let snap;
        try {
          snap = await fetchSnapshot(boardId);
        } catch (err) {
          const notFound = err?.status === 404;
          report(notFound ? 'board not found' : `resync failed: ${err?.message ?? err}`, {
            kind: 'resync',
            code: notFound ? 'BOARD_NOT_FOUND' : err?.code ?? null,
          });
          break;
        }
        if (!alive || client.boardId !== boardId) break; // switched boards meanwhile
        if (!snap || !snap.board || !Array.isArray(snap.elements)) break;

        // A broadcast or ack newer than this snapshot was already applied
        // here; applying the snapshot alone would roll it back. Replay the
        // batches after its rev on top — or, when one of them is unknown,
        // ask again (a little later) for a newer snapshot.
        let target = snap;
        if (Number.isFinite(snap.rev) && snap.rev < client.rev) {
          const { batches, complete } = logFor(boardId).between(snap.rev, client.rev);
          if (!complete && staleRefetches < MAX_STALE_REFETCH) {
            staleRefetches += 1;
            again = true;
            await sleep(Math.min(REFETCH_BASE_MS * 2 ** (staleRefetches - 1), REFETCH_MAX_MS));
            continue;
          }
          target = { ...snap, elements: replayOnto(snap.elements, batches), rev: client.rev };
        }

        withRemote(() => S().resyncSnapshot(target, pending()));
        if (Number.isFinite(snap.rev)) {
          client.rev = Math.max(client.rev, snap.rev);
          logFor(boardId).dropThrough(snap.rev);
        }
      } while (again && alive);
    } finally {
      resyncing = false;
    }
  }

  function report(message, info = {}) {
    if (typeof console !== 'undefined' && isDev()) console.warn('[realtime]', message, info);
    // However the server said it (unknown id at join, a `missing` ack, a
    // deleted board's eviction, a 404 on resync), the store says it the same way.
    if (info?.code === 'BOARD_NOT_FOUND') {
      S().setError(BOARD_MISSING_MESSAGE);
      S().setStatus('missing');
    }
    try {
      onError?.(message, info);
    } catch {
      /* a failing toast must not break the socket loop */
    }
  }

  // ---------------------------------------------------------- handlers
  const handlers = {
    onReady(msg) {
      const snapshot = { board: msg.board, elements: Array.isArray(msg.elements) ? msg.elements : [], rev: msg.rev };
      // Everything up to this rev is in the snapshot; a gap before it (the
      // socket was down) no longer matters.
      logFor(client.boardId).dropThrough(Number(msg.rev));
      withRemote(() => {
        const s = S();
        if (snapshot.board) s.resyncSnapshot(snapshot, pending());
        s.setMyPeerId(msg.peerId ?? null);
        if (Array.isArray(msg.peers)) s.setPeers(msg.peers);
        s.setStatus('ready');
        s.setError(null);
      });
    },

    onOp(ops, msg) {
      if (Array.isArray(ops) && ops.length > 0) {
        logFor(client.boardId).add(msg?.rev, ops);
        const mine = pending();
        withRemote(() => S().applyRemoteOps(ops, mine));
      }
      if (Number.isFinite(msg?.rev)) S().setRev(msg.rev);
    },

    onAck(result, info) {
      // Our own batch is part of the board at this rev now (and no longer
      // pending): remember it, so an older resync snapshot does not lose it.
      if (result?.status === 'applied') {
        const ops = Array.isArray(result.appliedOps) ? result.appliedOps : info?.ops;
        logFor(client.boardId).add(result.rev, ops);
      }
      if (Number.isFinite(result?.rev) && result.rev > 0) S().setRev(result.rev);
    },

    onPeerCursor(peerId, cursor) {
      S().upsertCursor(peerId, { ...cursor, at: Date.now() });
    },

    onPeerSelection(peerId, selection) {
      S().setPeerSelection(peerId, selection);
    },

    onPresence(peers) {
      S().setPeers(peers);
    },

    onBoard(board) {
      const s = S();
      if (!board || (s.boardId && board.id && board.id !== s.boardId)) return;
      s.setBoard(board);
    },

    onResync() {
      void resync();
    },

    onStatus(status) {
      const s = S();
      s.setConnection(status);
      // Off the board: the roster (and every remote cursor with it) is stale.
      if (status === 'offline' || status === 'disconnected' || status === 'idle') {
        if (s.peers.length > 0 || s.remoteCursors.size > 0) s.setPeers([]);
      }
    },

    onError(message, info) {
      report(message, info);
    },
  };
  Object.assign(client.handlers, handlers);

  // Mirror the current connection state now; later changes are pushed.
  S().setConnection(client.status);

  // ------------------------------------------------ tool -> presence
  let lastTool = null;
  const announceTool = (tool) => {
    if (!tool || tool === lastTool) return;
    lastTool = tool;
    client.sendActivity(tool);
  };
  announceTool(S().tool);

  // ------------------------------------------ selection -> peer-selection
  // What this user is working on, for the others to see outlined in this
  // user's colour: the selection, plus the text being edited (which is not
  // always selected). The client throttles and skips unchanged lists.
  let lastSelection = null;
  let lastEditing = null;
  const announceSelection = (state) => {
    if (state.selection === lastSelection && state.editingId === lastEditing) return;
    lastSelection = state.selection;
    lastEditing = state.editingId;
    client.sendSelection(selectionOf(state));
  };
  announceSelection(S());

  const unsubscribeLocal = store.subscribe((state) => {
    if (state.tool !== lastTool) announceTool(state.tool);
    announceSelection(state);
  });

  // ------------------------------------------------ cursor sweep
  const pruneTimer = pruneCursors ? setInterval(() => S().pruneCursors(), CURSOR_TTL_MS / 2) : null;

  sync.start();

  return function detach() {
    if (!alive) return;
    alive = false;
    if (pruneTimer) clearInterval(pruneTimer);
    unsubscribeLocal();
    sync.stop(); // flushes the debounce window into the client's outbox
    for (const key of Object.keys(handlers)) {
      if (client.handlers[key] === handlers[key]) client.handlers[key] = null;
    }
  };
}

/** The element ids this user is working on: the selection, plus the text being edited. */
export function selectionOf(state) {
  const ids = state?.selection ? [...state.selection] : [];
  const editing = state?.editingId;
  if (editing && !state.selection?.has?.(editing)) ids.push(editing);
  return ids;
}

function isDev() {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}
