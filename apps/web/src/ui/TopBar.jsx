/**
 * TopBar.jsx — the floating pill across the top of the board.
 *
 * Left: the board title, inline-editable, plus the board switcher dropdown.
 * Middle: presence. Right: share, theme, export, help.
 *
 * The title input is the one place in the app where a global shortcut would be
 * catastrophic if it fired (renaming a board should not also set the eraser
 * tool). That is handled in `shortcuts.js` by `matchesEvent`, which refuses
 * to match while the event target is an input — the guard is in the shared
 * matcher, not in each component, so no component can forget it.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useBoards, useCreateBoard, useDeleteBoard, useUpdateBoard } from '../api/queries.js';
import { useStore } from './store.js';
import { toast } from './Toasts.jsx';
import { PeerRoster } from './PeerRoster.jsx';
import {
  IconChevronDown,
  IconCopy,
  IconDownload,
  IconHelp,
  IconLayers,
  IconList,
  IconMoon,
  IconPlus,
  IconShare,
  IconSun,
  IconTrash,
} from './Icons.jsx';

const THEME_KEY = 'whiteboard:theme';

/* --- theme ----------------------------------------------------------------- */

export function readStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* private mode: fall through to the system preference */
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

/**
 * @param {'light'|'dark'} theme
 * @param {boolean} [persist=true] false for a theme that came FROM a board:
 *   it applies for this session but is not written to localStorage, so it
 *   stays a default and the OS preference still wins next time.
 */
export function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (!persist) return;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage is optional; the in-memory theme still applies */
  }
}

/**
 * The theme is owned by App (there is exactly one `data-theme` on <html>),
 * so this is a pure view + one callback. Two independent theme states would
 * let the toggle and the Ctrl+Shift+D shortcut disagree for a frame.
 */
function ThemeToggle({ theme, onToggle }) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="btn btn--icon"
      onClick={onToggle}
      title={`Switch to ${next} mode  (Ctrl+Shift+D)`}
      aria-label={`Switch to ${next} mode`}
    >
      {theme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
    </button>
  );
}

/* --- title ----------------------------------------------------------------- */

function BoardTitle() {
  const board = useStore((s) => s.board);
  const boardId = useStore((s) => s.boardId);
  const updateBoard = useUpdateBoard();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = useCallback(() => {
    const title = draft.trim();
    setEditing(false);
    if (!boardId || !title || title === board?.title) return;
    updateBoard.mutate(
      { id: boardId, patch: { title } },
      {
        onSuccess: () => toast.success('Board renamed'),
        onError: (e) => toast.error(e?.message || 'Could not rename the board'),
      },
    );
  }, [boardId, board?.title, draft, updateBoard]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="top-bar__title-input"
        value={draft}
        maxLength={120}
        aria-label="Board title"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // matchesEvent() in shortcuts.js already refuses to fire while this
          // input has focus, so the only keys handled here are the editing
          // keys themselves.
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setDraft(board?.title ?? '');
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <span
      className="top-bar__title"
      role="button"
      tabIndex={0}
      title="Click to rename"
      onClick={() => {
        setDraft(board?.title ?? '');
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault();
          setDraft(board?.title ?? '');
          setEditing(true);
        }
      }}
    >
      {board?.title || 'Untitled board'}
    </span>
  );
}

/* --- board switcher -------------------------------------------------------- */

function relativeTime(ts) {
  if (!ts) return '';
  const secs = Math.max(0, (Date.now() - ts) / 1000);
  if (secs < 60) return 'just now';
  const mins = secs / 60;
  if (mins < 60) return `${Math.floor(mins)} min ago`;
  const hrs = mins / 60;
  if (hrs < 24) return `${Math.floor(hrs)}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function BoardSwitcher({ onNavigate }) {
  const boardId = useStore((s) => s.boardId);
  const { data: boards, isLoading } = useBoards();
  const createBoard = useCreateBoard();
  const deleteBoard = useDeleteBoard();

  const [open, setOpen] = useState(false);
  const [confirmId, setConfirmId] = useState(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const list = boards ?? [];
  const current = list.find((b) => b.id === boardId);

  const create = () => {
    createBoard.mutate(
      { title: 'Untitled board' },
      {
        onSuccess: (b) => {
          setOpen(false);
          toast.success('Board created');
          onNavigate?.(b.id);
        },
        onError: (e) => toast.error(e?.message || 'Could not create a board'),
      },
    );
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        className="btn btn--icon"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch board  (Ctrl+Shift+B)"
        aria-label="Switch board"
        style={{
          background: open ? 'var(--color-surface-hover)' : undefined,
          minWidth: 0,
          padding: '0 6px',
        }}
      >
        <IconLayers size={17} />
        <IconChevronDown size={13} />
      </button>

      {open ? (
        <div
          className="panel board-list"
          role="menu"
          style={{ top: 'calc(100% + var(--sp-2))', left: 0, width: 280, padding: 'var(--sp-2)' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: 'var(--sp-1) var(--sp-2) var(--sp-2)',
            }}
          >
            <span className="panel__title">Your boards</span>
            <button
              type="button"
              className="btn btn--icon"
              onClick={create}
              disabled={createBoard.isPending}
              title="New board"
              aria-label="New board"
            >
              <IconPlus size={16} />
            </button>
          </div>

          {isLoading ? (
            <p className="board-list__empty">Loading…</p>
          ) : list.length === 0 ? (
            <p className="board-list__empty">No boards yet.</p>
          ) : (
            <ul>
              {list.map((b) => (
                <li key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-current={b.id === boardId}
                    className="board-list__item"
                    onClick={() => {
                      setOpen(false);
                      onNavigate?.(b.id);
                    }}
                  >
                    <IconList size={15} />
                    <span className="board-list__name">{b.title || 'Untitled board'}</span>
                    <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                      {relativeTime(b.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--icon"
                    style={{ minHeight: 26, minWidth: 26, flex: 'none' }}
                    aria-label={`Delete ${b.title || 'Untitled board'}`}
                    title="Delete board"
                    onClick={() => setConfirmId(b.id)}
                  >
                    <IconTrash size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {confirmId ? (
            <div
              role="alertdialog"
              aria-label="Confirm delete"
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeContent: 'center',
                gap: 'var(--sp-2)',
                padding: 'var(--sp-3)',
                background: 'var(--panel-bg-solid)',
                borderRadius: 'var(--radius-md)',
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: 'var(--fs-sm)' }}>
                Delete &ldquo;
                {list.find((b) => b.id === confirmId)?.title || 'Untitled board'}
                &rdquo;? This cannot be undone.
              </p>
              <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'center' }}>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setConfirmId(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => {
                    const id = confirmId;
                    setConfirmId(null);
                    setOpen(false);
                    deleteBoard.mutate(id, {
                      onSuccess: () => {
                        toast.success('Board deleted');
                        if (id === boardId) onNavigate?.(null);
                      },
                      onError: (e) => toast.error(e?.message || 'Could not delete the board'),
                    });
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ) : null}

          {current ? (
            <div
              style={{
                borderTop: '1px solid var(--color-border)',
                marginTop: 'var(--sp-2)',
                paddingTop: 'var(--sp-2)',
                margin: 'var(--sp-2) 0 0',
              }}
            >
              <button
                type="button"
                className="btn btn--ghost"
                style={{ width: '100%' }}
                onClick={() => {
                  setOpen(false);
                  onNavigate?.(null);
                }}
              >
                <IconCopy size={14} />
                All boards
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* --- share ----------------------------------------------------------------- */

function ShareButton() {
  const boardId = useStore((s) => s.boardId);
  return (
    <button
      type="button"
      className="btn"
      title="Copy a link to this board  (Ctrl+Shift+L)"
      onClick={async () => {
        if (!boardId) return;
        const url = `${location.origin}/b/${boardId}`;
        try {
          await navigator.clipboard.writeText(url);
          toast.success('Share link copied');
        } catch {
          // Clipboard permission denied (or an insecure origin). Fall back to
          // a selectable prompt so the link is still reachable.
          window.prompt('Copy this link', url);
        }
      }}
    >
      <IconShare size={16} />
      <span className="share-label">Share</span>
    </button>
  );
}

/* --- the bar --------------------------------------------------------------- */

export function TopBar({ onNavigate, onOpenExport, onOpenHelp, theme, onToggleTheme }) {
  return (
    <div className="top-bar panel" role="banner">
      <BoardSwitcher onNavigate={onNavigate} />
      <BoardTitle />

      <span
        style={{
          width: '1px',
          height: 20,
          background: 'var(--color-border)',
          flex: 'none',
        }}
        aria-hidden="true"
      />

      <PeerRoster />

      <div className="top-bar__actions">
        <ShareButton />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <button
          type="button"
          className="btn btn--icon"
          title="Export or import  (Ctrl+Shift+E)"
          aria-label="Export or import"
          onClick={onOpenExport}
        >
          <IconDownload size={17} />
        </button>
        <button
          type="button"
          className="btn btn--icon"
          title="Keyboard shortcuts  (?)"
          aria-label="Keyboard shortcuts"
          onClick={onOpenHelp}
        >
          <IconHelp size={17} />
        </button>
      </div>
    </div>
  );
}

export default TopBar;
