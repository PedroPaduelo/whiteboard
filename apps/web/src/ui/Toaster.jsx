/**
 * Toaster.jsx — renders the toast store (ui/toast.js) at the bottom centre,
 * above the footer islands. `role="status"` + `aria-live` so screen readers
 * announce toasts without moving focus; errors use `role="alert"`.
 */

import React, { useSyncExternalStore } from 'react';
import { subscribeToasts, getToasts, dismiss } from './toast.js';
import { IconAlert, IconCheck, IconClose, IconInfo } from './Icons.jsx';
import { t } from './strings.js';

const ICONS = { success: IconCheck, error: IconAlert, info: IconInfo };

export function Toaster() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return (
    <div className="toast-area" role="status" aria-live="polite" aria-relevant="additions text">
      {items.map((it) => {
        const Icon = ICONS[it.kind] ?? IconInfo;
        return (
          <div key={it.id} className={`toast island toast--${it.kind}`} role={it.kind === 'error' ? 'alert' : undefined}>
            <span className="toast__icon">
              <Icon size={16} />
            </span>
            <span className="toast__msg">{it.message}</span>
            {it.action ? (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  try {
                    it.action.run();
                  } finally {
                    dismiss(it.id);
                  }
                }}
              >
                {it.action.label}
              </button>
            ) : null}
            <button type="button" className="toast__close" aria-label={t.toast.dismiss} onClick={() => dismiss(it.id)}>
              <IconClose size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default Toaster;
