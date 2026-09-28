/**
 * Dialog.jsx — the modal shell every dialog uses: backdrop, a titled island,
 * a close button, focus moved in on open and restored on close, Tab kept
 * inside. Escape is handled centrally (the keyboard map's "close overlay"),
 * so the shell does not bind it a second time.
 */

import React, { useEffect, useId, useRef } from 'react';
import { IconButton } from './common.jsx';
import { IconClose } from './Icons.jsx';
import { t } from './strings.js';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, className = '', size = 'md', footer, testId, initialFocus }) {
  const ref = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const prev = document.activeElement;
    const root = ref.current;
    // The dialog itself by default (no focus ring on the close button);
    // `initialFocus` picks a field or the safe button of a confirmation.
    const first = (initialFocus && root?.querySelector(initialFocus)) || root;
    first?.focus({ preventScroll: true });
    return () => {
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [initialFocus]);

  const onKeyDown = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...(ref.current?.querySelectorAll(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={ref}
        className={`dialog island dialog--${size} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="dialog__head">
          <h2 id={titleId} className="dialog__title">
            {title}
          </h2>
          {onClose ? (
            <IconButton label={t.dialog.close} className="dialog__close" onClick={onClose}>
              <IconClose size={18} />
            </IconButton>
          ) : null}
        </header>
        <div className="dialog__body">{children}</div>
        {footer ? <footer className="dialog__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export default Dialog;
