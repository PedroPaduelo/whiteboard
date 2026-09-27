/**
 * `useRealtime(boardId)` — the only component that should ever talk to the
 * socket, and the only place server messages are turned into store updates.
 *
 * StrictMode safety is the constraint that shapes this file. In development
 * React mounts every component twice: effects run, clean up, run again. With
 * a naive effect that opens a socket and a cleanup that closes it, you get
 * two sockets, two `join`s and two peer ids — the roster shows you twice and
 * every op is applied twice. The guard below is a module-level refcount: the
 * first mount connects, the second mount is a no-op, and only the LAST
 * unmount disconnects.
 *
 * Note also that the socket is a module singleton (`realtime`), not a
 * per-hook instance. Even with the refcount, a fresh socket per mount would
 * throw away the outbox on every board switch.
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { realtime } from './realtime.js';
import { startSync, stopSync, withRemote } from './sync.js';
import { useBoardStore } from '../store/boardStore.js';
import { keys } from '../api/queries.js';
import { CURSOR_TTL_MS } from '../store/boardStore.js';

/** How many mounted consumers currently want a live connection. */
let consumerCount = 0;

/** A display name for this browser, stable enough to recognise later. */
const ADJECTIVES = ['Swift', 'Quiet', 'Bright', 'Bold', 'Calm', 'Keen', 'Warm', 'Sharp'];
const ANIMALS = ['Otter', 'Heron', 'Lynx', 'Finch', 'Marten', 'Ibis', 'Gannet', 'Stoat'];

function defaultName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a} ${b}`;
}

/**
 * @param {string|null|undefined} boardId
 * @param {{name?: string, enabled?: boolean}} [opts]
 */
export function useRealtime(boardId, { name, enabled = true } = {}) {
  const queryClient = useQueryClient();
  const store = useBoardStore;

  // Keep the latest values in refs so the effect does not have to re-run
  // (and the socket does not have to be re-joined) when a callback identity
  // changes on a re-render.
  const boardIdRef = useRef(boardId);
  const nameRef = useRef(name);
  boardIdRef.current = boardId;
  nameRef.current = name;

  useEffect(() => {
    if (!boardId || !enabled) return undefined;

    consumerCount += 1;
    const ownsConnection = consumerCount === 1;

    const { setSnapshot, setMyPeerId, setPeers, upsertCursor, pruneCursors, applyRemoteOp, setError, setStatus, setRev } =
      store.getState();

    // --- wire the handlers -------------------------------------------------
    realtime.handlers.onReady = (msg) => {
      // `ready` is the full board state from the server. Wrapped in
      // withRemote so the resulting store change is not diffed and shipped
      // straight back out.
      withRemote(() => {
        setSnapshot({ board: msg.board, elements: msg.elements, rev: msg.rev });
        setMyPeerId(msg.peerId ?? null);
        if (Array.isArray(msg.peers)) setPeers(msg.peers);
        if (Number.isFinite(msg.rev)) setRev(msg.rev);
        setError(null);
        setStatus('ready');
      });
    };

    realtime.handlers.onOp = (ops) => {
      if (!Array.isArray(ops) || ops.length === 0) return;
      withRemote(() => {
        for (const op of ops) applyRemoteOp(op);
      });
    };

    realtime.handlers.onAck = (result) => {
      if (Number.isFinite(result?.rev)) setRev(result.rev);
    };

    realtime.handlers.onPeerCursor = (peerId, cursor) => {
      upsertCursor(peerId, { ...cursor, at: Date.now() });
    };

    realtime.handlers.onPresence = (peers) => {
      setPeers(peers);
    };

    realtime.handlers.onResync = () => {
      // The board moved under us. Refetch the snapshot; the board switcher's
      // `useBoardSnapshot` picks it up and re-hydrates the store. Any queued
      // ops were already dropped by the realtime client — replaying stale
      // ops onto a moved board is how a diagram gets silently corrupted.
      if (boardIdRef.current) {
        queryClient.invalidateQueries({ queryKey: keys.snapshot(boardIdRef.current) });
      }
    };

    realtime.handlers.onStatus = (status) => {
      const cur = store.getState();
      if (status === 'connected' || status === 'connecting') {
        cur.setError(null);
      } else if (status === 'disconnected') {
        // A definite dead connection, not a transient blip: the user needs to
        // be told, because silently retrying forever is indistinguishable
        // from collaboration simply not working.
        cur.setError('Live connection lost. Reload to reconnect — unsent changes are not saved.');
      } else if (status === 'offline') {
        cur.setError('Reconnecting to the live board…');
      }
    };

    realtime.handlers.onError = (message) => {
      if (typeof console !== 'undefined' && import.meta.env?.DEV) console.warn('[realtime]', message);
    };

    // --- connect (only if nobody else already has) -----------------------
    startSync();
    if (ownsConnection) {
      realtime.connect(boardId, { name: nameRef.current || defaultName() });
    }

    // Cursors go stale when a peer vanishes without a goodbye; sweep them so
    // a departed collaborator does not leave an arrow stuck on the board.
    const pruneTimer = setInterval(() => store.getState().pruneCursors(), CURSOR_TTL_MS / 2);

    return () => {
      clearInterval(pruneTimer);
      stopSync();

      // Only the last consumer takes the socket down.
      consumerCount = Math.max(0, consumerCount - 1);
      if (consumerCount === 0) {
        realtime.disconnect();
      }

      realtime.handlers.onReady = null;
      realtime.handlers.onOp = null;
      realtime.handlers.onAck = null;
      realtime.handlers.onPeerCursor = null;
      realtime.handlers.onPresence = null;
      realtime.handlers.onResync = null;
      realtime.handlers.onStatus = null;
      realtime.handlers.onError = null;
    };
  }, [boardId, enabled, queryClient, store]);

  return realtime;
}

export { realtime };
export default useRealtime;
