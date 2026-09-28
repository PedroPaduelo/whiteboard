/**
 * BoardList.jsx — the landing screen: the boards you own plus the ones nobody
 * has claimed yet, with create, open, rename, duplicate, claim and delete.
 *
 * The list is SCOPED BY NICKNAME (`useBoards` sends `?owner=<nickname>` and
 * keys its cache by it). Every row says whose board it is, and an unclaimed
 * row says so and offers to take it — ownership must be legible, or your work
 * and a stranger's look identical.
 *
 * Duplicate = create a board, then replay the source elements as `create`
 * ops cloned with `cloneElements` (fresh short ids, bindings and groups
 * remapped), so the copy is independent of the original.
 *
 * The root URL never auto-creates a board: creating one is a click.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  keys as queryKeys,
  useApplyOps,
  useBoards,
  useClaimBoard,
  useCreateBoard,
  useDeleteBoard,
  useNickname,
  useUpdateBoard,
} from '../api/queries.js';
import { api, newOpId } from '../api/client.js';
import { cloneElements } from '../editor/elements.js';
import { toast } from './toast.js';
import { NicknameSwitcher } from './NicknameGate.jsx';
import { IconBoards, IconCheck, IconClose, IconDuplicate, IconEdit, IconPlus, IconTrash } from './Icons.jsx';
import { t } from './strings.js';

const TICK_MS = 30_000;
const T = t.boards;

export function relativeTime(ts, now = Date.now()) {
  if (!ts) return T.time.unknown;
  const secs = Math.max(0, (now - ts) / 1000);
  if (secs < 45) return T.time.now;
  const mins = Math.round(secs / 60);
  if (mins < 60) return T.time.minutes(mins);
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return T.time.hours(hrs);
  const days = Math.round(hrs / 24);
  if (days < 7) return T.time.days(days);
  return new Date(ts).toLocaleDateString('pt-BR');
}

/** A small deterministic sketch derived from the board id (not a real render). */
function BoardPreview({ seed }) {
  const w = 104;
  const h = 68;
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
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const sw = 18 + rnd() * 26;
      const sh = 12 + rnd() * 18;
      out.push({ x: 8 + rnd() * (w - sw - 16), y: 8 + rnd() * (h - sh - 16), w: sw, h: sh, kind: Math.floor(rnd() * 3) });
    }
    return out;
  }, [seed]);
  return (
    <svg className="board-preview" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
      {shapes.map((s, i) =>
        s.kind === 1 ? (
          <ellipse key={i} cx={s.x + s.w / 2} cy={s.y + s.h / 2} rx={s.w / 2} ry={s.h / 2} />
        ) : s.kind === 2 ? (
          <path key={i} d={`M${s.x} ${s.y + s.h / 2} L${s.x + s.w / 2} ${s.y} L${s.x + s.w} ${s.y + s.h / 2} L${s.x + s.w / 2} ${s.y + s.h} Z`} />
        ) : (
          <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx={4} />
        ),
      )}
    </svg>
  );
}

function OwnerTag({ board, nickname, onClaim, claiming }) {
  const owner = board.ownerId;
  if (!owner) {
    return (
      <span className="owner">
        <span className="owner-tag owner-tag--unclaimed" data-testid="owner-unclaimed" data-owner="" title={T.unclaimedTitle}>
          {T.unclaimed}
        </span>
        <button
          type="button"
          className="btn btn--xs"
          data-testid="claim-board"
          data-board-id={board.id}
          disabled={claiming}
          title={T.claimTitle}
          aria-label={T.claimLabel(board.title || T.defaultTitle)}
          onClick={(e) => {
            // The row opens the board; claiming must not also navigate.
            e.stopPropagation();
            onClaim();
          }}
        >
          {claiming ? '…' : T.claim}
        </button>
      </span>
    );
  }
  const mine = owner === nickname;
  return (
    <span className={`owner-tag ${mine ? 'owner-tag--mine' : ''}`} data-testid="owner-tag" data-owner={owner} title={mine ? T.yoursTitle : T.ownedBy(owner)}>
      {mine ? <IconCheck size={12} /> : null}
      {mine ? T.yours : owner}
    </span>
  );
}

function BoardCard({ board, onOpen, nickname }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(board.title || '');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  // A rename ends once: a blur after Enter/Escape must not save again (or save
  // a cancelled edit).
  const renameDoneRef = useRef(false);

  const updateBoard = useUpdateBoard(board.id);
  const createBoard = useCreateBoard();
  const deleteBoard = useDeleteBoard();
  const claimBoard = useClaimBoard();
  const applyOps = useApplyOps(board.id);
  const qc = useQueryClient();
  const title = board.title || T.defaultTitle;

  useEffect(() => {
    if (renaming) {
      renameDoneRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  const endRename = useCallback(
    (save) => {
      if (renameDoneRef.current) return;
      renameDoneRef.current = true;
      setRenaming(false);
      const next = draft.trim();
      if (!save || !next || next === board.title) return;
      updateBoard.mutate(
        { title: next },
        { onSuccess: () => toast.success(T.renamed), onError: (e) => toast.error(e?.message || T.renameFailed) },
      );
    },
    [board.title, draft, updateBoard],
  );

  const claim = useCallback(() => {
    claimBoard.mutate(
      { id: board.id, owner: nickname },
      { onSuccess: () => toast.success(T.claimed(nickname)), onError: (e) => toast.error(e?.message || T.claimFailed) },
    );
  }, [board.id, claimBoard, nickname]);

  const duplicate = useCallback(() => {
    setBusy(true);
    createBoard.mutate(
      { title: T.copyTitle(title), ownerId: nickname },
      {
        onSuccess: async (created) => {
          try {
            const snap = await api.get(`/boards/${encodeURIComponent(board.id)}`);
            const source = Array.isArray(snap?.elements) ? snap.elements : [];
            if (!source.length) {
              toast.success(T.duplicated(created.title, 0));
              onOpen?.(created.id);
              return;
            }
            // Fresh ids with bindings/groups remapped. cloneElements drops
            // `locked`; restore it when the copy lines up with the source.
            const cloned = cloneElements(source);
            const copies = cloned.length === source.length ? cloned.map((el, i) => (source[i].locked ? { ...el, locked: true } : el)) : cloned;
            const now = Date.now();
            const ops = copies.map((element) => ({ opId: newOpId(), boardId: created.id, kind: 'create', element, at: now }));
            // The server accepts a bounded batch; send big boards in chunks.
            let ok = true;
            for (let i = 0; i < ops.length && ok; i += 150) {
              const res = await applyOps.applyOps({ ops: ops.slice(i, i + 150) });
              ok = Boolean(res?.ok);
            }
            if (ok) toast.success(T.duplicated(created.title, ops.length));
            else toast.error(T.duplicateEmpty(created.title));
            qc.invalidateQueries({ queryKey: queryKeys.allBoards });
            qc.invalidateQueries({ queryKey: queryKeys.board(created.id) });
            onOpen?.(created.id);
          } catch (e) {
            toast.error(e?.message || T.duplicateFailed);
          } finally {
            setBusy(false);
          }
        },
        onError: (e) => {
          setBusy(false);
          toast.error(e?.message || T.duplicateFailed);
        },
      },
    );
  }, [board.id, title, applyOps, createBoard, nickname, onOpen, qc]);

  const remove = useCallback(() => {
    deleteBoard.mutate(board.id, {
      onSuccess: () => toast.success(T.deleted),
      onError: (e) => toast.error(e?.message || T.deleteFailed),
    });
  }, [board.id, deleteBoard]);

  const disabled = busy || createBoard.isPending || deleteBoard.isPending;

  return (
    <li className="board-row" data-board-id={board.id} onClick={() => !renaming && onOpen(board.id)}>
      <BoardPreview seed={board.id} />
      <div className="board-row__main">
        {renaming ? (
          <input
            ref={inputRef}
            className="field board-row__rename"
            value={draft}
            maxLength={120}
            aria-label={T.renameLabel(title)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => endRename(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                endRename(true);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                endRename(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="board-row__title"
            title={T.open(title)}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(board.id);
            }}
          >
            {title}
          </button>
        )}
        <div className="board-row__meta">
          <span>
            {T.updated(relativeTime(board.updatedAt))}
            {Number.isFinite(board.rev) ? ` · ${T.rev(board.rev)}` : ''}
          </span>
          <OwnerTag board={board} nickname={nickname} onClaim={claim} claiming={claimBoard.isPending} />
        </div>
      </div>
      <div className="board-row__actions" onClick={(e) => e.stopPropagation()}>
        {confirming ? (
          <>
            <button type="button" className="btn btn--danger btn--sm" disabled={disabled} onClick={remove}>
              {T.confirmDelete}
            </button>
            <button type="button" className="icon-btn" aria-label={T.cancelDelete} title={T.cancelDelete} onClick={() => setConfirming(false)}>
              <IconClose size={16} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="icon-btn"
              title={T.rename}
              aria-label={T.renameLabel(title)}
              disabled={disabled}
              onClick={() => {
                setDraft(board.title || '');
                setRenaming(true);
              }}
            >
              <IconEdit size={17} />
            </button>
            <button type="button" className="icon-btn" title={T.duplicate} aria-label={T.duplicateLabel(title)} disabled={disabled} onClick={duplicate}>
              <IconDuplicate size={17} />
            </button>
            <button type="button" className="icon-btn icon-btn--danger" title={T.delete} aria-label={T.deleteLabel(title)} disabled={disabled} onClick={() => setConfirming(true)}>
              <IconTrash size={17} />
            </button>
          </>
        )}
      </div>
    </li>
  );
}

export function BoardList({ onOpen }) {
  const { data: boards, isLoading, isError, error, refetch } = useBoards();
  const createBoard = useCreateBoard();
  const nickname = useNickname();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const list = useMemo(
    () => (boards ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    // `tick` is a dependency on purpose: it re-renders the relative times.
    [boards, tick],
  );
  const counts = useMemo(() => {
    const mine = list.filter((b) => b.ownerId && b.ownerId === nickname).length;
    return { mine, unclaimed: list.filter((b) => !b.ownerId).length, total: list.length };
  }, [list, nickname]);

  const create = useCallback(() => {
    createBoard.mutate(
      { title: T.defaultTitle, ownerId: nickname },
      {
        onSuccess: (b) => {
          toast.success(T.created);
          onOpen?.(b.id);
        },
        onError: (e) => toast.error(e?.message || T.createFailed),
      },
    );
  }, [createBoard, nickname, onOpen]);

  return (
    <div className="screen board-list" data-screen="board-list" data-owner={nickname}>
      <div className="board-list__inner">
        <header className="board-list__head">
          <div className="board-list__brand" aria-hidden="true">
            {t.app.name}
          </div>
          <div className="board-list__heading">
            <h1 className="board-list__title">{T.title}</h1>
            <p className="board-list__subtitle">{counts.total === 0 ? T.subtitleEmpty : T.subtitle(counts.mine, counts.unclaimed)}</p>
          </div>
          <div className="board-list__tools">
            <NicknameSwitcher />
            <button type="button" className="btn btn--primary" onClick={create} disabled={createBoard.isPending} data-testid="new-board">
              <IconPlus size={18} />
              {createBoard.isPending ? T.creating : T.newBoard}
            </button>
          </div>
        </header>

        <div className="board-list__body">
          {isLoading ? (
            <ul className="board-rows" data-board-list-state="loading">
              {[0, 1, 2].map((i) => (
                <li key={i} className="board-row board-row--skeleton" />
              ))}
            </ul>
          ) : isError ? (
            <div className="island board-list__state" role="alert">
              <h2>{T.loadError}</h2>
              <p>{error?.message || T.loadErrorText}</p>
              <button type="button" className="btn btn--primary" onClick={() => refetch()}>
                {T.retry}
              </button>
            </div>
          ) : list.length === 0 ? (
            <div className="island board-list__state" data-board-list-state="empty">
              <span className="board-list__state-icon">
                <IconBoards size={26} />
              </span>
              <h2>{T.emptyTitle(nickname || '—')}</h2>
              <p>
                {T.emptyText} {T.emptyOwner} <strong>{nickname}</strong>.
              </p>
              <p>
                {T.emptyOtherName}{' '}
                <button
                  type="button"
                  className="link-btn"
                  data-testid="empty-change-name"
                  onClick={() => document.querySelector('[data-testid="nickname-chip"]')?.click()}
                >
                  {T.emptyChangeName}
                </button>{' '}
                {T.emptyOtherNameTail}
              </p>
              <button type="button" className="btn btn--primary" onClick={create} disabled={createBoard.isPending}>
                <IconPlus size={18} />
                {T.firstBoard}
              </button>
            </div>
          ) : (
            <ul className="board-rows" data-board-list-state="ready">
              {list.map((b) => (
                <BoardCard key={b.id} board={b} onOpen={onOpen} nickname={nickname} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default BoardList;
