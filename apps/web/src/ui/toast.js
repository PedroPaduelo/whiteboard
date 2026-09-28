/**
 * toast.js — a tiny, dependency-free toast store (the view is Toaster.jsx).
 *
 * A module-level store rather than React state or the board store: toasts
 * must be pushable from anywhere — the editor actions (plain functions, run
 * under node in tests), event handlers, module scope — and must survive a
 * board switch. `Toaster.jsx` subscribes with `useSyncExternalStore`.
 *
 * Behaviour that matters:
 *   - success/info auto-dismiss after `duration`; errors stay until closed,
 *     because an error nobody read is an error they will hit again;
 *   - capped at MAX_TOASTS, newest last, so a loop that spams cannot build a
 *     tower over the board;
 *   - the same message pushed again while it is still visible refreshes the
 *     existing toast instead of stacking a duplicate.
 */

const MAX_TOASTS = 3;
const DEFAULT_DURATION = 3000;

let seq = 0;
/** @type {Array<{id:number, kind:'success'|'error'|'info', message:string, duration:number, action?:{label:string, run:Function}}>} */
let toasts = [];
const listeners = new Set();
const timers = new Map();

function emit() {
  for (const l of [...listeners]) l();
}

export function subscribeToasts(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getToasts() {
  return toasts;
}

function schedule(id, duration) {
  const prev = timers.get(id);
  if (prev) clearTimeout(prev);
  if (duration > 0 && typeof setTimeout === 'function') {
    const h = setTimeout(() => dismiss(id), duration);
    // Never keep a node test process alive for a toast.
    if (h && typeof h.unref === 'function') h.unref();
    timers.set(id, h);
  }
}

function push(kind, message, opts = {}) {
  const text = String(message ?? '');
  if (!text) return null;
  const duration = opts.duration ?? (kind === 'error' ? 0 : DEFAULT_DURATION);
  const dup = toasts.find((x) => x.kind === kind && x.message === text);
  if (dup) {
    schedule(dup.id, duration);
    return dup.id;
  }
  const id = ++seq;
  toasts = [...toasts, { id, kind, message: text, duration, action: opts.action }].slice(-MAX_TOASTS);
  emit();
  schedule(id, duration);
  return id;
}

export function dismiss(id) {
  const h = timers.get(id);
  if (h) {
    clearTimeout(h);
    timers.delete(id);
  }
  const next = toasts.filter((x) => x.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

export function clearToasts() {
  for (const h of timers.values()) clearTimeout(h);
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
  clear: clearToasts,
};

/** Clear every toast — used on navigation so old messages die with the board. */
export const resetToasts = clearToasts;

export default toast;
