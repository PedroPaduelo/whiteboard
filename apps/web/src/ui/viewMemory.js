/**
 * viewMemory.js — where each board was being looked at (zoom and pan), per
 * browser, so a reload or a return to a board puts the view back instead of
 * at the board origin (Excalidraw restores its scroll position too).
 *
 * One localStorage entry holds every board's view, most recent first and
 * capped at MAX_VIEWS boards, so the key never grows without bound. Storage
 * is optional: private mode or blocked storage just means no memory.
 *
 * Plain JS (no JSX) so node tests can import it.
 */

import { ZOOM_LIMITS } from '@whiteboard/shared';

export const VIEWS_KEY = 'whiteboard:views';
export const MAX_VIEWS = 50;

const storageOf = (storage) => {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** A view as stored, or null when it is not a usable one. */
export function sanitizeView(v) {
  if (!v || typeof v !== 'object') return null;
  const zoom = Number(v.zoom);
  const panX = Number(v.panX);
  const panY = Number(v.panY);
  if (!Number.isFinite(zoom) || !Number.isFinite(panX) || !Number.isFinite(panY)) return null;
  if (zoom < ZOOM_LIMITS.min || zoom > ZOOM_LIMITS.max) return null;
  return { zoom, panX: Math.round(panX), panY: Math.round(panY) };
}

function readAll(storage) {
  try {
    const raw = storage?.getItem(VIEWS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string') : [];
  } catch {
    return [];
  }
}

/** The remembered view of a board, or null. */
export function loadView(boardId, storage) {
  if (!boardId) return null;
  const entry = readAll(storageOf(storage)).find((e) => e.id === boardId);
  return entry ? sanitizeView(entry) : null;
}

/** Remember a board's view (moves it to the front; drops the oldest past MAX_VIEWS). */
export function saveView(boardId, view, storage) {
  const s = storageOf(storage);
  const v = sanitizeView(view);
  if (!boardId || !s || !v) return;
  const rest = readAll(s).filter((e) => e.id !== boardId);
  const list = [{ id: boardId, ...v }, ...rest].slice(0, MAX_VIEWS);
  try {
    s.setItem(VIEWS_KEY, JSON.stringify(list));
  } catch {
    /* quota / blocked: the view is simply not remembered */
  }
}
