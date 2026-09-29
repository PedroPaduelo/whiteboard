/**
 * colorHex.js — the hex field of the colour popover (PropertiesPanel.jsx), as
 * plain functions testable in node.
 */

/** `#rrggbb` (lower case) for a 6-digit hex with or without `#`, else null. */
export function normalizeHex(text) {
  const v = String(text ?? '').trim();
  if (!/^#?[0-9a-fA-F]{6}$/.test(v)) return null;
  return (v.startsWith('#') ? v : `#${v}`).toLowerCase();
}

/** What the hex field shows for a colour: the hex without `#`, '' for none/transparent/mixed. */
export function hexFieldValue(color) {
  const norm = normalizeHex(color);
  return norm ? norm.slice(1) : '';
}

/**
 * The colour to apply when the hex field is submitted (Enter or blur), or null.
 * Only an EDITED field applies anything: focusing and leaving it must not
 * re-apply what it shows — which, when it had gone stale, reverted the colour
 * just picked from a swatch. A value equal to the current colour is a no-op too.
 *
 * @param {string} text      the field's text
 * @param {boolean} edited   the user typed in the field since it last synced
 * @param {string|null} current  the selection's colour (null when mixed)
 */
export function hexToApply(text, edited, current) {
  if (!edited) return null;
  const norm = normalizeHex(text);
  if (!norm) return null;
  if (typeof current === 'string' && norm === current.toLowerCase()) return null;
  return norm;
}
