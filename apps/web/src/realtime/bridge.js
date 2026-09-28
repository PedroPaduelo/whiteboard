/**
 * The binding between the realtime client and the board store: every server
 * message becomes a store write here, and nowhere else. Plain JS (no React),
 * so the whole protocol — ready, broadcasts, acks, resync, cursors, presence —
 * is exercised in node by `apps/web/test/realtime.test.js`.
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
 */

import { CURSOR_TTL_MS, useBoardStore } from '../store/boardStore.js';
import { api } from '../api/client.js';
import { realtime as defaultClient } from './realtime.js';
import { storeSync as defaultSync, withRemote } from './sync.js';

/** How many times a resync refetches a snapshot that is older than what we have seen. */
const MAX_STALE_REFETCH = 3;

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
        if (!boardId || !alive) break;
        let snap;
        try {
          snap = await fetchSnapshot(boardId);
        } catch (err) {
          const notFound = err?.status === 404;
          report(notFound ? 'board not found' : `resync failed: ${err?.message ?? err}`, {
            kind: 'resync',
            code: notFound ? 'BOARD_NOT_FOUND' : err?.code ?? null,
          });
          if (notFound) S().setError('Este quadro não existe mais.');
          break;
        }
        if (!alive || client.boardId !== boardId) break; // switched boards meanwhile
        if (!snap || !snap.board || !Array.isArray(snap.elements)) break;

        // A broadcast or ack newer than this snapshot was already applied
        // here; applying the snapshot would roll it back. Ask again.
        if (Number.isFinite(snap.rev) && snap.rev < client.rev && staleRefetches < MAX_STALE_REFETCH) {
          staleRefetches += 1;
          again = true;
          continue;
        }

        withRemote(() => S().resyncSnapshot(snap, pending()));
        if (Number.isFinite(snap.rev)) client.rev = Math.max(client.rev, snap.rev);
      } while (again && alive);
    } finally {
      resyncing = false;
    }
  }

  function report(message, info = {}) {
    if (typeof console !== 'undefined' && isDev()) console.warn('[realtime]', message, info);
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
        const mine = pending();
        withRemote(() => S().applyRemoteOps(ops, mine));
      }
      if (Number.isFinite(msg?.rev)) S().setRev(msg.rev);
    },

    onAck(result) {
      if (Number.isFinite(result?.rev) && result.rev > 0) S().setRev(result.rev);
    },

    onPeerCursor(peerId, cursor) {
      S().upsertCursor(peerId, { ...cursor, at: Date.now() });
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
  const unsubscribeTool = store.subscribe((state) => {
    if (state.tool !== lastTool) announceTool(state.tool);
  });

  // ------------------------------------------------ cursor sweep
  const pruneTimer = pruneCursors ? setInterval(() => S().pruneCursors(), CURSOR_TTL_MS / 2) : null;

  sync.start();

  return function detach() {
    if (!alive) return;
    alive = false;
    if (pruneTimer) clearInterval(pruneTimer);
    unsubscribeTool();
    sync.stop(); // flushes the debounce window into the client's outbox
    for (const key of Object.keys(handlers)) {
      if (client.handlers[key] === handlers[key]) client.handlers[key] = null;
    }
  };
}

function isDev() {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}
