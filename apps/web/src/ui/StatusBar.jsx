/**
 * StatusBar.jsx — the floating pill at the bottom of the board.
 *
 * Shows zoom, cursor position in board units, element count, grid/snap state,
 * the realtime connection state, and the last error with a dismiss.
 *
 * The cursor readout is the interesting part. It is fed by a throttled
 * pointermove listener that writes into a ref and a single rAF, NOT through
 * React state on every event: at 120Hz a mouse, a state write per event would
 * re-render the status bar 120 times a second and, because React commits
 * synchronously enough to matter here, drag the whole app's frame budget
 * down with it. The throttled value is the only thing that changes; the
 * component re-renders ~20x/second, which is invisible to the eye.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useStore, getStoreApi } from './store.js';
import { realtime } from '../realtime/useRealtime.js';
import { IconAlert, IconClose } from './Icons.jsx';

const CURSOR_INTERVAL_MS = 50; // ~20 updates/second

/**
 * The socket's state lives on the realtime singleton, not in the store — the
 * store only carries the user-facing `error` string. Reading it here keeps a
 * transport detail out of the store's contract.
 */
function readConnection() {
  return realtime?.status ?? 'connecting';
}

export function StatusBar() {
  const zoom = useStore((s) => s.view?.zoom ?? 1);
  const elementCount = useStore((s) => s.elements?.length ?? 0);
  const selectionCount = useStore((s) => s.selection?.size ?? 0);
  const gridSize = useStore((s) => s.gridSize ?? 0);
  const snapEnabled = useStore((s) => Boolean(s.snapEnabled));
  const error = useStore((s) => s.error ?? null);
  const status = useStore((s) => s.status ?? 'idle');

  const [cursor, setCursor] = useState(null);
  const [conn, setConn] = useState(readConnection);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const [dismissedError, setDismissedError] = useState(null);

  const store = getStoreApi();
  const last = useRef(0);
  const pending = useRef(null);
  const frame = useRef(0);

  /* --- cursor readout, throttled to 20Hz -------------------------------- */
  useEffect(() => {
    const host = document.querySelector('.canvas-host');
    const target = host || document;
    let disposed = false;

    const flush = () => {
      frame.current = 0;
      if (disposed) return;
      const p = pending.current;
      pending.current = null;
      if (p) setCursor(p);
    };

    const onMove = (event) => {
      const now = performance.now();
      if (now - last.current < CURSOR_INTERVAL_MS) return;
      last.current = now;
      const view = store.view ?? { zoom: 1, panX: 0, panY: 0 };
      // screen = board * zoom + pan, inverted here.
      const host0 = target === document ? { left: 0, top: 0 } : target.getBoundingClientRect();
      const sx = event.clientX - host0.left;
      const sy = event.clientY - host0.top;
      pending.current = {
        x: Math.round((sx - view.panX) / view.zoom),
        y: Math.round((sy - view.panY) / view.zoom),
      };
      if (!frame.current) frame.current = requestAnimationFrame(flush);
    };

    const onLeave = () => {
      pending.current = null;
      setCursor(null);
    };

    target.addEventListener('pointermove', onMove, { passive: true });
    target.addEventListener('pointerleave', onLeave, { passive: true });
    return () => {
      disposed = true;
      if (frame.current) cancelAnimationFrame(frame.current);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerleave', onLeave);
    };
  }, [store]);

  /* --- connection state ---------------------------------------------------
     The realtime client notifies through a handler rather than a store slice,
     so the status is polled on a short interval. A socket drop is something
     the user must learn about within a second or two — five seconds of "Live"
     after the connection is actually dead is a lie.
     ------------------------------------------------------------------- */
  useEffect(() => {
    const sync = () => setConn(readConnection());
    sync();
    const id = setInterval(sync, 1500);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      clearInterval(id);
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  const zoomPct = Math.round(zoom * 100);
  const showError = error && error !== dismissedError;
  // realtime.status is idle | connecting | connected | offline | disconnected.
  // `disconnected` is a definite dead socket (we set a loud store error for
  // it); `offline` and `idle` are softer and mean "reconnecting".
  const connLabel =
    conn === 'connected'
      ? 'Live'
      : conn === 'connecting'
        ? 'Connecting'
        : conn === 'disconnected'
          ? 'Disconnected'
          : conn === 'offline'
            ? 'Offline'
            : 'Idle';

  return (
    <div className="status-bar panel" role="status" aria-live="off">
      <button
        type="button"
        className="status-bar__item btn btn--icon"
        style={{ minHeight: 20, minWidth: 0, padding: '0 4px', borderRadius: 4 }}
        title="Reset zoom to 100%  (Ctrl+0)"
        onClick={() => store.resetView()}
      >
        <span className="mono">{zoomPct}%</span>
      </button>

      <span className="status-bar__item mono" title="Cursor position in board units">
        {cursor ? `${cursor.x}, ${cursor.y}` : '— , —'}
      </span>

      <span className="status-bar__item" title="Elements on this board">
        {elementCount} {elementCount === 1 ? 'element' : 'elements'}
        {selectionCount > 0 ? ` · ${selectionCount} selected` : ''}
      </span>

      <span className="status-bar__item" title={gridSize > 0 ? `Grid every ${gridSize}px` : 'Grid is off'}>
        Grid {gridSize > 0 ? `${gridSize}px` : 'off'}
      </span>

      <span className="status-bar__item" title="Snap to grid">
        Snap {snapEnabled ? 'on' : 'off'}
      </span>

      <span className="status-bar__item" title={`Realtime connection: ${connLabel}`}>
        <span className="conn-dot" data-state={conn} />
        {connLabel}
      </span>

      {status === 'loading' ? <span className="status-bar__item">Syncing…</span> : null}

      {showError ? (
        <span className="status-bar__item status-bar__item--error" role="alert" title={error}>
          <IconAlert size={12} />
          <span
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {error}
          </span>
          <button
            type="button"
            className="btn btn--icon"
            style={{ minHeight: 16, minWidth: 16, padding: 0 }}
            aria-label="Dismiss error"
            onClick={() => setDismissedError(error)}
          >
            <IconClose size={11} />
          </button>
        </span>
      ) : null}

      <span className="sr-only" aria-live="polite">
        {connLabel}
      </span>
    </div>
  );
}

export default StatusBar;
