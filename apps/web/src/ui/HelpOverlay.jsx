/**
 * HelpOverlay.jsx — the shortcut sheet.
 *
 * Rendered straight from `SHORTCUTS` via `groupedShortcuts()`, so it cannot go
 * stale: adding a binding to the table adds a row here automatically, and
 * removing one removes the row. There is no second list of shortcuts
 * anywhere in this app.
 *
 * Accessibility: this is a modal dialog, so it does the three things a modal
 * has to do — Escape closes it, Tab is trapped inside it, and focus returns to
 * whatever opened it on close. The first focusable element gets focus on open
 * because a dialog that opens with focus still on the page behind is only
 * half-modal.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { groupedShortcuts, formatKeys } from './shortcuts.js';
import { IconClose } from './Icons.jsx';

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function KeyCaps({ keys }) {
  return (
    <span className="shortcut-row__keys">
      {keys.map((k, i) => (
        <kbd key={`${k}-${i}`}>{formatKeys([k])}</kbd>
      ))}
    </span>
  );
}

export function HelpOverlay({ open, onClose }) {
  const sheetRef = useRef(null);
  const restoreRef = useRef(null);

  /* --- Escape to close, Tab trapped ------------------------------------- */
  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement;

    const node = sheetRef.current;
    // Focus the sheet itself rather than the close button: a screen reader
    // then reads the dialog name first instead of "Close, button".
    node?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = node ? [...node.querySelectorAll(FOCUSABLE)] : [];
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const restore = restoreRef.current;
      if (restore && typeof restore.focus === 'function' && document.contains(restore)) {
        restore.focus();
      }
    };
  }, [open, onClose]);

  const onBackdrop = useCallback(
    (event) => {
      if (event.target === event.currentTarget) onClose?.();
    },
    [onClose],
  );

  if (!open) return null;

  const groups = groupedShortcuts();

  return (
    <div className="backdrop" onMouseDown={onBackdrop}>
      <div
        ref={sheetRef}
        className="panel help-overlay__sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog__header" style={{ margin: 'calc(var(--sp-5) * -1) calc(var(--sp-5) * -1) 0', padding: 'var(--sp-4) var(--sp-5)' }}>
          <div>
            <h2 id="help-title" className="panel__title" style={{ fontSize: 'var(--fs-lg)', lineHeight: 'var(--lh-lg)' }}>
              Keyboard shortcuts
            </h2>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)', marginTop: 2 }}>
              Ctrl is ⌘ on macOS. Shortcuts stay inactive while you type in a text field.
            </p>
          </div>
          <button
            type="button"
            className="btn btn--icon"
            onClick={onClose}
            aria-label="Close shortcuts"
            title="Close  (Esc)"
          >
            <IconClose size={17} />
          </button>
        </div>

        <div className="shortcut-grid">
          {groups.map(({ group, items }) => (
            <section key={group} className="shortcut-grid__group">
              <h3 className="shortcut-grid__heading">{group}</h3>
              {items.map((s) => (
                <div key={s.id} className="shortcut-row">
                  <span style={{ minWidth: 0 }}>{s.label}</span>
                  <KeyCaps keys={s.keys} />
                </div>
              ))}
            </section>
          ))}
        </div>

        <div
          className="panel__footer"
          style={{ margin: 'calc(var(--sp-5) * -1) calc(var(--sp-5) * -1) calc(var(--sp-5) * -1)', borderRadius: '0 0 var(--radius-lg) var(--radius-lg)' }}
        >
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

export default HelpOverlay;
