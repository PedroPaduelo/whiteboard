/**
 * Toasts.jsx — a tiny, dependency-free toast store plus the <Toaster /> view.
 *
 * Why a local store instead of the board store: toasts are shell-level and
 * must survive a board switch, and they must be pushable from anywhere
 * (including module scope and event handlers) without a hook. A module-level
 * store with `useSyncExternalStore` gives exactly that.
 *
 * Behaviour that matters:
 *   - success/info auto-dismiss after `duration`; errors NEVER auto-dismiss,
 *     because an error the user never read is an error they will hit again
 *   - stacked, newest at the bottom, capped at MAX so a render loop that
 *     spams cannot build a tower of toasts over the board
 *   - the container is `role="status" aria-live="polite"`, so a screen reader
 *     announces toasts without stealing focus
 */

import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { IconAlert, IconCheck, IconClose, IconInfo } from './Icons.jsx';

const MAX_TOASTS = 4;
const DEFAULT_DURATION = 3200;
const ERROR_DURATION = 0; // 0 = sticky

let seq = 0;
/** @type {Array<{id:number,kind:'success'|'error'|'info',message:string,action?:{label:string,run:Function},duration:number}>} */
let toasts = [];
const listeners = new Set();
const timers = new Map();

function emit() {
  for (const l of listeners) l();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot() {
  return toasts;
}

function push(kind, message, opts = {}) {
  const id = ++seq;
  const duration = opts.duration ?? (kind === 'error' ? ERROR_DURATION : DEFAULT_DURATION);
  const next = [...toasts, { id, kind, message, duration, action: opts.action }];
  toasts = next.slice(-MAX_TOASTS);
  emit();
  if (duration > 0) {
    timers.set(
      id,
      setTimeout(() => dismiss(id), duration),
    );
  }
  return id;
}

function dismiss(id) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  const next = toasts.filter((x) => x.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

function clear() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  if (toasts.length) {
    toasts = [];
    emit();
  }
}

export const toast = {
  success: (message, opts) => push('success', message, opts),
  error: (message, opts) => push('error', message, opts),
  info: (message, opts) => push('info', message, opts),
  dismiss,
  clear,
};

function useToasts() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const ICONS = { success: IconCheck, error: IconAlert, info: IconInfo };

function ToastRow({ toast: t, onDismiss }) {
  const Icon = ICONS[t.kind] ?? IconInfo;
  const accent =
    t.kind === 'success' ? 'success' : t.kind === 'error' ? 'danger' : 'accent';
  return (
    <div className={`toast toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
      <span
        style={{
          flex: 'none',
          marginTop: 1,
          color: `var(--color-${accent})`,
        }}
      >
        <Icon size={16} />
      </span>
      <span style={{ minWidth: 0, flex: '1 1 auto', overflowWrap: 'anywhere' }}>{t.message}</span>
      {t.action ? (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            try {
              t.action.run();
            } finally {
              onDismiss(t.id);
            }
          }}
        >
          {t.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn--icon"
        onClick={() => onDismiss(t.id)}
        aria-label="Dismiss notification"
        style={{ minHeight: 22, minWidth: 22, flex: 'none' }}
      >
        <IconClose size={13} />
      </button>
    </div>
  );
}

/**
 * The toast viewport. Render exactly once, near the root of the app — it is
 * absolutely positioned so it does not affect layout.
 */
export function Toaster() {
  const items = useToasts();
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const onDismiss = useCallback((id) => dismissRef.current(id), []);

  return (
    <div className="toast-area" role="status" aria-live="polite" aria-relevant="additions text">
      {items.map((t) => (
        <ToastRow key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/** Clear every toast — used when the board changes so old messages die. */
export function resetToasts() {
  clear();
}

export default Toaster;
