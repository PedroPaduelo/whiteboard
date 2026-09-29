/**
 * `useRealtime(boardId, {name})` — mounts the live connection for a board.
 *
 * The App calls it once for the open board with the person's nickname
 * (`useNickname()`), which is the name the roster and the cursor tags show.
 * All protocol logic lives in `realtime.js` (the socket) and `bridge.js`
 * (server messages -> store); this hook only decides WHEN to attach and
 * connect.
 *
 * StrictMode: React runs effect -> cleanup -> effect in development. The
 * module-level refcount plus a ONE-TICK deferred release means that re-run
 * (or a quick remount) keeps the socket that is already open instead of
 * closing it mid-handshake and joining twice; only a real unmount, with no
 * consumer back by the next tick, detaches and disconnects.
 */

import { useEffect, useRef } from 'react';
import { realtime } from './realtime.js';
import { attachRealtime } from './bridge.js';
import { storeSync } from './sync.js';

/** How many mounted consumers currently want a live connection. */
let consumerCount = 0;
/** The bridge's detach function while attached. */
let detachBridge = null;
/** The newest `onError` any consumer passed (the bridge calls through this). */
let errorSink = null;
/** A scheduled release (detach + disconnect) that a quick remount cancels. */
let pendingRelease = null;

/**
 * @param {string|null|undefined} boardId
 * @param {{name?: string, enabled?: boolean, onError?: (message: string, info: object) => void}} [opts]
 * @returns {import('./realtime.js').RealtimeClient}
 */
export function useRealtime(boardId, { name, enabled = true, onError } = {}) {
  // Latest values in refs so a new callback identity or a re-render does not
  // re-run the effect (and re-join the board).
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    if (onError) errorSink = onError;
  });

  useEffect(() => {
    if (!boardId || !enabled) return undefined;

    consumerCount += 1;
    if (pendingRelease !== null) {
      clearTimeout(pendingRelease);
      pendingRelease = null;
    }
    if (!detachBridge) {
      detachBridge = attachRealtime({ onError: (message, info) => errorSink?.(message, info) });
    }
    // Another board: the old board's debounce window goes into the client's
    // queue first, so `connect` posts it to the OLD board with the rest.
    if (realtime.boardId && realtime.boardId !== boardId) storeSync.flush();
    realtime.connect(boardId, { name: nameRef.current || undefined });

    // Back online after a network drop: do not wait out the backoff timer.
    const onOnline = () => {
      if (realtime.fatal) return; // the board does not exist; nothing to reconnect to
      if (realtime.status === 'offline' || realtime.status === 'disconnected') realtime.reconnect();
    };
    // The network is gone: say so now. The socket can look open for a long
    // time after that, and the dot would keep saying "Conectado".
    const onOffline = () => realtime.markOffline();
    // Closing the tab: hand the debounce window to the client, which posts
    // what it can (keepalive) and stashes everything unacknowledged for the
    // next visit, before the page goes away. A page restored from the
    // back/forward cache simply reconnects (and picks the stash back up).
    const onPageHide = () => {
      storeSync.flush();
      realtime.disconnect({ unloading: true });
    };
    const onPageShow = (event) => {
      if (event.persisted) realtime.connect(boardId, { name: nameRef.current || undefined });
    };
    const hasWindow = typeof window !== 'undefined';
    if (hasWindow) {
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      window.addEventListener('pagehide', onPageHide);
      window.addEventListener('pageshow', onPageShow);
    }

    return () => {
      if (hasWindow) {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
      }
      consumerCount = Math.max(0, consumerCount - 1);
      if (consumerCount === 0 && pendingRelease === null) {
        pendingRelease = setTimeout(() => {
          pendingRelease = null;
          if (consumerCount > 0) return;
          // Order matters: detaching flushes the sync debounce window into
          // the client, and disconnecting then posts anything unacknowledged.
          detachBridge?.();
          detachBridge = null;
          realtime.disconnect();
        }, 0);
      }
    };
  }, [boardId, enabled]);

  // A nickname change while on the board re-joins under the new name.
  useEffect(() => {
    if (enabled && name) realtime.setName(name);
  }, [name, enabled]);

  return realtime;
}

export { realtime };
export default useRealtime;
