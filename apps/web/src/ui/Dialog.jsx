/**
 * Dialog.jsx — the modal shell every dialog uses: backdrop, a titled island,
 * a close button, focus moved in on open and restored on close, Tab kept
 * inside. Escape is handled centrally (the keyboard map's "close overlay"),
 * so the shell does not bind it a second time.
 *
 * Focus starts on the BODY (the part that scrolls), not on the dialog box:
 * scroll keys (PageDown, arrows, Space, End) scroll the focused element or
 * its ancestors, never a child, so with focus on the box the help sheet
 * could not be scrolled from the keyboard at all. A body that overflows is
 * also a Tab stop, so it can be reached again after the close button.
 */

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { IconButton } from './common.jsx';
import { IconClose } from './Icons.jsx';
import { trapTabTarget } from './focusTrap.js';
import { t } from './strings.js';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, className = '', size = 'md', footer, testId, initialFocus }) {
  const ref = useRef(null);
  const bodyRef = useRef(null);
  const titleId = useId();
  const [scrolls, setScrolls] = useState(false);

  // Does the body overflow? Then it is a Tab stop (a scrollable region must
  // be reachable from the keyboard); otherwise it only takes focus by script
  // or click, and adds no stop before the dialog's own fields.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return undefined;
    const check = () => setScrolls(body.scrollHeight > body.clientHeight + 1 || body.scrollWidth > body.clientWidth + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(body);
    for (const child of body.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const prev = document.activeElement;
    const root = ref.current;
    // The scrolling body by default (no focus ring on the close button, and
    // the scroll keys work at once); `initialFocus` picks a field or the
    // safe button of a confirmation.
    const first = (initialFocus && root?.querySelector(initialFocus)) || bodyRef.current || root;
    if (first && first === bodyRef.current) {
      // Focus put there on open shows no ring (dialogs.css); coming back to
      // the body with Tab later does.
      first.dataset.autofocus = '';
      first.addEventListener('blur', () => delete first.dataset.autofocus, { once: true });
    }
    first?.focus({ preventScroll: true });
    return () => {
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [initialFocus]);

  const onKeyDown = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...(ref.current?.querySelectorAll(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null);
    if (!items.length) {
      // Nothing to tab to: focus stays on the dialog, never behind it.
      e.preventDefault();
      return;
    }
    const next = trapTabTarget(items, document.activeElement, e.shiftKey);
    if (next) {
      e.preventDefault();
      next.focus();
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
        <div ref={bodyRef} className="dialog__body" tabIndex={scrolls ? 0 : -1}>
          {children}
        </div>
        {footer ? <footer className="dialog__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

export default Dialog;
