/**
 * BoardList.jsx — the landing screen: every board you own, with create,
 * open, rename, duplicate and delete.
 *
 * "Duplicate" is the interesting one. It is a create + a replay of the
 * source board's elements as create ops, which is the same path an import
 * takes. The new board gets a fresh id from the server, so the two boards
 * are genuinely independent afterwards — editing the copy does not touch the
 * original, which is what "duplicate" has to mean on a collaborative board.
 *
 * Relative timestamps tick on a 30s timer: "2 min ago" that says "2 min ago"
 * after ten minutes is the kind of small lie that makes a whole screen feel
 * untrustworthy.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  keys as queryKeys,
  useApplyOps,
  useBoards,
  useCreateBoard,
  useDeleteBoard,
  useUpdateBoard,
} from '../api/queries.js';
import { api } from '../api/client.js';
import { toast } from './Toasts.jsx';
import {
  IconClose,
  IconCopy,
  IconLayers,
  IconPlus,
  IconTrash,
} from './Icons.jsx';

const TICK_MS = 30_000;

/* --- time ------------------------------------------------------------------ */

function relativeTime(ts) {
  if (!ts) return 'unknown';
  const secs = Math.max(0, (Date.now() - ts) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * A tiny deterministic thumbnail: the board's title rendered at a glance
 * scale. It is not a real render of the board (that would mean fetching every
 * snapshot to draw a 96px box, and the cost is not worth a list), but it is
 * derived from real data, so two boards do not look identical by accident.
 */
function BoardPreview({ seed, w = 96, h = 64 }) {
  const shapes = useMemo(() => {
    let hsh = 2166136261;
    const s = String(seed || 'board');
    for (let i = 0; i < s.length; i++) {
      hsh ^= s.charCodeAt(i);
      hsh = Math.imul(hsh, 16777619);
    }
    const rnd = () => {
      hsh = Math.imul(hsh ^ (hsh >>> 15), 2246822519);
      return ((hsh ^ (hsh >>> 13)) >>> 0) / 4294967296;
    };
    const out = [];
    const n = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const sw = 16 + rnd() * 26;
      const sh = 10 + rnd() * 18;
      out.push({
        x: 6 + rnd() * (w - sw - 12),
        y: 6 + rnd() * (h - sh - 12),
        w: sw,
        h: sh,
        round: rnd() > 0.6,
      });
    }
    return out;
  }, [seed, w, h]);

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      focusable="false"
      style={{
        flex: 'none',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--color-border)',
        background: 'var(--color-surface-sunken)',
      }}
    >
      {shapes.map((s, i) => (
        <rect
          key={i}
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          rx={s.round ? 4 : 1}
          fill="var(--color-border)"
          stroke="var(--color-border-strong)"
          strokeWidth="0.75"
        />
      ))}
    </svg>
  );
}

/* --- a card ---------------------------------------------------------------- */

/**
 * One row. It owns the three per-board mutations (rename / duplicate /
 * delete) because each is a hook, and a list cannot call hooks in a loop.
 */
function BoardCard({ board, onOpen }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(board.title || '');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  // A fresh mutation bound to THIS board — `useUpdateBoard` keys its cache
  // invalidation on the id, so sharing one across rows would invalidate the
  // wrong board.
  const updateBoard = useUpdateBoard(board.id);
  const createBoard = useCreateBoard();
  const deleteBoard = useDeleteBoard();
  const applyOps = useApplyOps(board.id);
  const qc = useQueryClient();

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  const commitRename = useCallback(() => {
    const title = draft.trim();
    setRenaming(false);
    if (!title || title === board.title) return;
    updateBoard.mutate(
      { title },
      {
        onSuccess: () => toast.success('Board renamed'),
        onError: (e) => toast.error(e?.message || 'Could not rename the board'),
      },
    );
  }, [board.title, draft, updateBoard]);

  /**
   * Duplicate = create an empty board, then replay the source snapshot onto
   * it as `create` ops. This is the same wire path an import uses, and it
   * gives the copy FRESH element ids — so the two boards are independent
   * afterwards, which is what "duplicate" has to mean on a board that other
   * people may be editing.
   */
  const duplicate = useCallback(() => {
    setBusy(true);
    createBoard.mutate(
      { title: `${board.title || 'Untitled board'} (copy)` },
      {
        onSuccess: async (created) => {
          try {
            const snap = await api.get(`/boards/${board.id}`);
            const source = Array.isArray(snap?.elements) ? snap.elements : [];
            if (!source.length) {
              toast.success(`Duplicated as “${created.title}”`);
              onOpen?.(created.id);
              return;
            }
            const now = Date.now();
            const ops = source.map((el, i) => ({
              opId: `dup-${created.id}-${i}-${now}`,
              boardId: created.id,
              kind: 'create',
              element: { ...el, id: `${el.id}-c${now.toString(36)}${i}` },
              actorId: snap?.board?.ownerId ?? undefined,
              at: now,
            }));
            const res = await applyOps.applyOps({ ops });
            if (res.ok) {
              toast.success(
                `Duplicated as “${created.title}” — ${ops.length} ${
                  ops.length === 1 ? 'element' : 'elements'
                } copied`,
              );
            } else {
              toast.error(
                `Created “${created.title}”, but the copy came out empty (${res.code}). Open it and import the original instead.`,
              );
            }
            // The copy is a different id; drop any cached board list view so
            // the row appears with the right element count.
            qc.invalidateQueries({ queryKey: queryKeys.boards });
            qc.invalidateQueries({ queryKey: queryKeys.board(created.id) });
            onOpen?.(created.id);
          } catch (e) {
            toast.error(e?.message || 'Could not copy the board contents');
          } finally {
            setBusy(false);
          }
        },
        onError: (e) => {
          setBusy(false);
          toast.error(e?.message || 'Could not duplicate the board');
        },
      },
    );
  }, [board.id, board.title, applyOps, createBoard, onOpen, qc]);

  const remove = useCallback(() => {
    deleteBoard.mutate(board.id, {
      onSuccess: () => toast.success('Board deleted'),
      onError: (e) => toast.error(e?.message || 'Could not delete the board'),
    });
  }, [board.id, deleteBoard]);

  const disabled = busy || createBoard.isPending || deleteBoard.isPending;

  return (
    // The whole row opens the board, not just the title: people click the card,
    // the thumbnail or the timestamp expecting it to open, and a row that only
    // responds on its title text reads as a dead control. The per-board action
    // buttons stop the click from bubbling (see below) so they still act on the
    // board instead of opening it.
    //
    // `data-board-id` + a stable class make the row addressable from tests and
    // from the console. The class is deliberately NOT `board-list__item` —
    // that one belongs to the board switcher popover in TopBar.jsx, and reusing
    // it would couple two unrelated surfaces.
    <li
      className="board-row"
      data-board-id={board.id}
      style={{
        display: 'flex',
        gap: 'var(--sp-3)',
        alignItems: 'center',
        padding: 'var(--sp-3)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
        cursor: 'pointer',
        transition: 'border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease)',
      }}
      onClick={() => onOpen(board.id)}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border-strong)';
        e.currentTarget.style.boxShadow = 'var(--shadow-1)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <BoardPreview seed={board.id} />

      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        {renaming ? (
          <input
            ref={inputRef}
            className="field"
            style={{ minHeight: 30, fontSize: 'var(--fs-md)' }}
            value={draft}
            maxLength={120}
            aria-label={`Rename ${board.title}`}
            // The row opens the board, so anything interactive inside it has to
            // opt out — otherwise clicking into the rename field would navigate
            // out from under you mid-edit.
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraft(board.title || '');
                setRenaming(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            onClick={(e) => {
              // The row handles the open; stop here so the click is not handled
              // twice (which would fire two navigations and leave the board
              // briefly in a double-render).
              e.stopPropagation();
              onOpen(board.id);
            }}
            style={{
              display: 'block',
              maxWidth: '100%',
              textAlign: 'left',
              fontSize: 'var(--fs-md)',
              fontWeight: 'var(--fw-semibold)',
              color: 'var(--color-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={`Open ${board.title}`}
          >
            {board.title || 'Untitled board'}
          </button>
        )}
        <p
          style={{
            color: 'var(--color-text-muted)',
            fontSize: 'var(--fs-xs)',
            lineHeight: 'var(--lh-xs)',
            marginTop: 2,
          }}
        >
          Updated {relativeTime(board.updatedAt)}
          {Number.isFinite(board.rev) ? ` · rev ${board.rev}` : ''}
        </p>
      </div>

      {confirming ? (
        // Per-board actions live inside a row that opens the board, so the
        // whole group opts out of the row's click. Without this, "Delete" would
        // navigate into the board you were trying to delete.
        <div
          style={{ display: 'flex', gap: 'var(--sp-1)', flex: 'none' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="btn btn--danger"
            style={{ minHeight: 30, padding: '0 var(--sp-3)' }}
            disabled={disabled}
            onClick={remove}
          >
            Delete
          </button>
          <button
            type="button"
            className="btn btn--icon"
            style={{ minHeight: 30, minWidth: 30 }}
            aria-label="Cancel delete"
            onClick={() => setConfirming(false)}
          >
            <IconClose size={15} />
          </button>
        </div>
      ) : (
        // Same reason as the confirm group above: rename/duplicate/delete must
        // not double as "open this board".
        <div
          style={{ display: 'flex', gap: 2, flex: 'none' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="btn btn--icon"
            style={{ minHeight: 30, minWidth: 30 }}
            title="Rename"
            aria-label={`Rename ${board.title}`}
            disabled={disabled}
            onClick={() => {
              setDraft(board.title || '');
              setRenaming(true);
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 'var(--fw-semibold)' }}>Aa</span>
          </button>
          <button
            type="button"
            className="btn btn--icon"
            style={{ minHeight: 30, minWidth: 30 }}
            title="Duplicate"
            aria-label={`Duplicate ${board.title}`}
            disabled={disabled}
            onClick={duplicate}
          >
            <IconCopy size={15} />
          </button>
          <button
            type="button"
            className="btn btn--icon"
            style={{ minHeight: 30, minWidth: 30 }}
            title="Delete"
            aria-label={`Delete ${board.title}`}
            disabled={disabled}
            onClick={() => setConfirming(true)}
          >
            <IconTrash size={15} />
          </button>
        </div>
      )}
    </li>
  );
}

/* --- the screen ------------------------------------------------------------ */

export function BoardList({ onOpen }) {
  const { data: boards, isLoading, isError, error, refetch } = useBoards();
  const createBoard = useCreateBoard();
  const [tick, setTick] = useState(0);

  // The relative timestamps above are pure functions of Date.now(); bumping a
  // counter re-renders them without any data refetch.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const list = useMemo(() => (boards ?? []).slice().sort((a, b) => {
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  }), [boards, tick]);

  const create = useCallback(() => {
    createBoard.mutate(
      { title: 'Untitled board' },
      {
        onSuccess: (b) => {
          toast.success('Board created');
          onOpen?.(b.id);
        },
        onError: (e) => toast.error(e?.message || 'Could not create a board'),
      },
    );
  }, [createBoard, onOpen]);

  return (
    <div
      className="app-shell"
      // One hook that says "the board list is on screen and these are its rows",
      // so a test can wait for the list without counting every <li> on the page
      // (skeleton rows are <li> too).
      data-screen="board-list"
      style={{ overflow: 'auto', display: 'block', background: 'var(--color-bg)' }}
    >
      <div style={{ maxWidth: 860, margin: '0 auto', padding: 'var(--sp-7) var(--sp-5) var(--sp-8)' }}>
        {/* --- header --------------------------------------------------- */}
        <header style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--sp-3)' }}>
          <span style={{ color: 'var(--color-accent)', flex: 'none', marginBottom: 4 }}>
            <IconLayers size={26} />
          </span>
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            <h1
              style={{
                fontSize: 'var(--fs-2xl)',
                lineHeight: 'var(--lh-2xl)',
                fontWeight: 'var(--fw-semibold)',
                letterSpacing: '-0.01em',
              }}
            >
              Boards
            </h1>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)' }}>
              A shared whiteboard. Open one to start drawing, or create a new board.
            </p>
          </div>
          <button
            type="button"
            className="btn btn--primary"
            onClick={create}
            disabled={createBoard.isPending}
          >
            <IconPlus size={16} />
            {createBoard.isPending ? 'Creating…' : 'New board'}
          </button>
        </header>

        {/* --- body ----------------------------------------------------- */}
        <div style={{ marginTop: 'var(--sp-6)' }}>
          {isLoading ? (
            <ul
              data-board-list-state="loading"
              style={{ display: 'grid', gap: 'var(--sp-2)' }}
            >
              {[0, 1, 2].map((i) => (
                <li
                  key={i}
                  style={{
                    height: 92,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    opacity: 0.5,
                  }}
                />
              ))}
            </ul>
          ) : isError ? (
            <div
              className="panel"
              role="alert"
              style={{ padding: 'var(--sp-5)', textAlign: 'center' }}
            >
              <h2 className="panel__title" style={{ fontSize: 'var(--fs-lg)' }}>
                Could not load your boards
              </h2>
              <p
                style={{
                  color: 'var(--color-text-muted)',
                  fontSize: 'var(--fs-sm)',
                  margin: 'var(--sp-2) 0 var(--sp-4)',
                }}
              >
                {error?.message || 'The server did not answer.'}
              </p>
              <button type="button" className="btn btn--primary" onClick={() => refetch()}>
                Try again
              </button>
            </div>
          ) : list.length === 0 ? (
            <div
              className="panel"
              data-board-list-state="empty"
              style={{
                padding: 'var(--sp-8) var(--sp-5)',
                textAlign: 'center',
                display: 'grid',
                justifyItems: 'center',
                gap: 'var(--sp-2)',
              }}
            >
              <span
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  width: 56,
                  height: 56,
                  borderRadius: 'var(--radius-pill)',
                  background: 'var(--color-accent-soft)',
                  color: 'var(--color-accent)',
                  marginBottom: 'var(--sp-2)',
                }}
              >
                <IconLayers size={26} />
              </span>
              <h2 className="panel__title" style={{ fontSize: 'var(--fs-lg)' }}>
                No boards yet
              </h2>
              <p
                style={{
                  color: 'var(--color-text-muted)',
                  fontSize: 'var(--fs-sm)',
                  maxWidth: '42ch',
                  lineHeight: 'var(--lh-md)',
                }}
              >
                A board is a shared canvas — draw shapes, drop sticky notes, and invite
                other people to work alongside you in real time.
              </p>
              <button
                type="button"
                className="btn btn--primary"
                style={{ marginTop: 'var(--sp-3)' }}
                onClick={create}
                disabled={createBoard.isPending}
              >
                <IconPlus size={16} />
                Create your first board
              </button>
            </div>
          ) : (
            <ul
              className="board-rows"
              data-board-list-state="ready"
              style={{ display: 'grid', gap: 'var(--sp-2)', listStyle: 'none', margin: 0, padding: 0 }}
            >
              {list.map((b) => (
                <BoardCard key={b.id} board={b} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default BoardList;
