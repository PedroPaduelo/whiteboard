/**
 * common.jsx — the small building blocks every island uses: the island
 * container, the square icon button, key caps, and the outside-click hook for
 * popovers. Kept together so the chrome looks like one design, not five.
 */

import React, { useEffect, useRef } from 'react';

/** A floating panel (Excalidraw "island": white, soft shadow, 8px radius). */
export const Island = React.forwardRef(function Island({ as: Tag = 'div', className = '', children, ...rest }, ref) {
  return (
    <Tag ref={ref} className={`island ${className}`.trim()} {...rest}>
      {children}
    </Tag>
  );
});

/**
 * Square icon button. `active` renders the violet selected state; `label`
 * is the accessible name and the tooltip (with the shortcut appended).
 *
 * Mouse clicks do not take focus (mousedown default prevented): a toolbar
 * button that kept focus after a click would swallow the next Enter/arrow key
 * the user meant for the board. Keyboard focus (Tab) still works.
 */
export const IconButton = React.forwardRef(function IconButton(
  { label, shortcut, active = false, pressed, className = '', children, badge, onMouseDown, ...rest },
  ref,
) {
  const title = shortcut ? `${label} — ${shortcut}` : label;
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-btn ${active ? 'is-active' : ''} ${className}`.trim()}
      title={title}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : Boolean(pressed)}
      onMouseDown={(e) => {
        e.preventDefault();
        onMouseDown?.(e);
      }}
      {...rest}
    >
      {children}
      {badge ? (
        <span className="icon-btn__badge" aria-hidden="true">
          {badge}
        </span>
      ) : null}
    </button>
  );
});

/** Key caps for one chord: ['Ctrl', 'Shift', 'Z']. */
export function KeyCaps({ caps }) {
  return (
    <span className="keycaps">
      {caps.map((c, i) => (
        <kbd key={`${c}-${i}`} className="kbd">
          {c}
        </kbd>
      ))}
    </span>
  );
}

/**
 * Close a popover on a pointerdown outside `ref` (and outside any element
 * matching `ignoreSelector`, e.g. the button that toggles it).
 */
export function useOutsideClose(ref, open, onClose, ignoreSelector) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      const el = ref.current;
      if (!el || el.contains(e.target)) return;
      if (ignoreSelector && e.target instanceof Element && e.target.closest(ignoreSelector)) return;
      cb.current?.();
    };
    // Capture: the canvas stops nothing, but a gesture there should still close us.
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, ref, ignoreSelector]);
}

const MENU_ITEM_SELECTOR = '[role="menuitem"],[role="menuitemcheckbox"]';

/** Enabled, rendered menu items of a menu (phone-only items are display:none on desktop). */
function menuItems(root) {
  if (!root) return [];
  return [...root.querySelectorAll(MENU_ITEM_SELECTOR)].filter((el) => !el.disabled && el.getClientRects().length > 0);
}

/**
 * Put keyboard focus on the first item of a menu that just opened, so arrow
 * keys move through the menu instead of reaching the board (where they nudge
 * the selection). Call it once the menu is VISIBLE: browsers refuse to focus
 * an element under `visibility: hidden`.
 * @returns {boolean} whether an item took focus
 */
export function focusFirstMenuItem(root) {
  const first = menuItems(root)[0];
  if (!first) return false;
  first.focus({ preventScroll: true });
  return document.activeElement === first;
}

/**
 * Focus the first item whenever `open` turns true (menus opened by a click
 * on a button that does not take focus). Returns the ref for the menu root.
 */
export function useMenuFocus(open) {
  const ref = useRef(null);
  useEffect(() => {
    if (open) focusFirstMenuItem(ref.current);
  }, [open]);
  return ref;
}

/**
 * Arrow-key navigation inside a role="menu": Up/Down/Home/End move focus
 * between enabled menu items. Returns an onKeyDown handler.
 */
export function menuKeyNav(e) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const root = e.currentTarget;
  const items = menuItems(root);
  if (!items.length) return;
  e.preventDefault();
  e.stopPropagation();
  const i = items.indexOf(document.activeElement);
  let next = 0;
  if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
  else if (e.key === 'ArrowUp') next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  else if (e.key === 'End') next = items.length - 1;
  items[next].focus();
}
