/**
 * focusTrap.js — where Tab / Shift+Tab go inside a modal dialog.
 *
 * Plain JS (no JSX) so node tests can import it; ui/Dialog.jsx applies it.
 */

/**
 * The element Tab (or Shift+Tab with `shift`) must move to so focus stays
 * inside the dialog, or null to let the browser move it (it stays inside).
 *
 * Focus that is on none of `items` — the dialog container itself, where it
 * starts when no field asks for it — counts as "before the first item":
 * Tab goes to the first, Shift+Tab wraps to the last. (Only exact first/last
 * matches used to wrap, so a first Shift+Tab from the container escaped to
 * the page behind the modal, where Enter then zoomed the board.)
 *
 * @param {Element[]} items focusable elements of the dialog, in tab order
 * @param {Element|null} active document.activeElement
 * @param {boolean} shift
 * @returns {Element|null}
 */
export function trapTabTarget(items, active, shift) {
  if (!items.length) return null;
  const first = items[0];
  const last = items[items.length - 1];
  const i = items.indexOf(active);
  if (i < 0) return shift ? last : first;
  if (shift && i === 0) return last;
  if (!shift && i === items.length - 1) return first;
  return null;
}
