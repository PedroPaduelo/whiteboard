/**
 * share.js — the one "copy the board link" implementation (menu, Share
 * button and context use it). The link format `${origin}/b/<id>` is what the
 * nginx fallback and `resolveBoardId` in App.jsx understand.
 */

import { toast } from './toast.js';
import { t } from './strings.js';

export function shareUrl(boardId) {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/b/${encodeURIComponent(boardId)}`;
}

/** Copy the board link; falls back to a prompt where the clipboard is blocked. */
export async function copyShareLink(boardId) {
  if (!boardId) return false;
  const url = shareUrl(boardId);
  try {
    if (!globalThis.navigator?.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(url);
    toast.success(t.toast.linkCopied);
    return true;
  } catch {
    if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
      window.prompt(t.board.share, url);
      return true;
    }
    toast.error(t.toast.linkCopyFailed);
    return false;
  }
}
