/**
 * titleEdit.js — when does closing a title field save? Shared by the board
 * title in the editor (TopRight.jsx) and testable in node.
 */

/**
 * The title to save when a rename field closes, or null for "nothing to do".
 *
 * Compared with the title the field OPENED with (`startTitle`), not only with
 * the live one: if a collaborator renamed the board while this field sat
 * open and untouched, the draft still equals the start, and saving it would
 * write the old title back over theirs for everyone.
 *
 * @param {string} draft       what the field holds
 * @param {string} startTitle  the title when editing started
 * @param {string} [liveTitle] the board's title now (may have changed remotely)
 * @returns {string|null}
 */
export function titleToSave(draft, startTitle, liveTitle) {
  const next = String(draft ?? '').trim();
  if (!next) return null;
  if (next === String(startTitle ?? '').trim()) return null;
  if (next === liveTitle) return null;
  return next;
}
