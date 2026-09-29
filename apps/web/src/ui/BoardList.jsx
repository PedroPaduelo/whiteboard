/**
 * BoardList.jsx — the landing screen: the boards you own plus the ones nobody
 * has claimed yet, with create, open, rename, duplicate, claim and delete.
 *
 * The list is SCOPED BY NICKNAME (`?owner=<nickname>`, and the cache is keyed
 * by it). Every row says whose board it is, and an unclaimed row says so and
 * offers to take it — ownership must be legible, or your work and a
 * stranger's look identical. It is PAGED (`limit`/`offset`, "Carregar mais")
 * and searchable by title, and its counts come from the server's `total`.
 *
 * Duplicate = create a board, then replay the source elements into the COPY
 * as `create` ops cloned with `cloneElements` (fresh short ids, bindings and
 * groups remapped), so the copy is independent of the original — see
 * ui/boardOps.js.
 *
 * The root URL never auto-creates a board: creating one is a click.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { keys as queryKeys, useClaimBoard, useCreateBoard, useDeleteBoard, useNickname, useUpdateBoard } from '../api/queries.js';
import { api } from '../api/client.js';
import { boardListQuery, copyBoardElements, mergeBoardPages, nextPageOffset, pageTotal } from './boardOps.js';
import { previewKind, previewQueryKey, previewSrc } from './boardPreview.js';
import { useUi } from './uiStore.js';
import { toast } from './toast.js';
import { errorMessage, errorSentence } from './errors.js';
import { NicknameSwitcher } from './NicknameGate.jsx';
import { IconBoards, IconCheck, IconClose, IconDuplicate, IconEdit, IconPlus, IconSearch, IconTrash } from './Icons.jsx';
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

/**
 * True once `ref`'s element has come near the viewport (and stays true), so
 * a thumbnail is fetched only for rows someone scrolls to.
 */
function useSeen(ref, margin = '200px') {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: margin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, seen, margin]);
  return seen;
}

/**
 * The board's real content, drawn small (ui/boardPreview.js): fetched once
 * the row is on screen, cached per revision. An empty board says so; a very
 * large one shows its element count.
 */
function BoardPreview({ board }) {
  const ref = useRef(null);
  const kind = previewKind(board);
  const seen = useSeen(ref);
  const dark = useUi((s) => s.theme === 'dark');
  const { data } = useQuery({
    queryKey: previewQueryKey(board),
    queryFn: ({ signal }) => api.get(`/boards/${encodeURIComponent(board.id)}/snapshot`, { signal }),
    enabled: seen && kind === 'content',
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
  const elements = data?.elements;
  const src = useMemo(() => {
    try {
      return previewSrc(elements, { dark });
    } catch (err) {
      console.warn('[boards] preview failed', err);
      return null;
    }
  }, [elements, dark]);
  return (
    <span ref={ref} className="board-preview" data-preview={src ? 'drawn' : kind} aria-hidden="true">
      {src ? (
        <img className="board-preview__img" src={src} alt="" draggable="false" />
      ) : kind === 'empty' ? (
        <span className="board-preview__note">{T.previewEmpty}</span>
      ) : kind === 'large' ? (
        <span className="board-preview__note">{T.previewCount(board.elementCount)}</span>
      ) : null}
    </span>
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
        { onSuccess: () => toast.success(T.renamed), onError: (e) => toast.error(errorMessage(e, T.renameFailed)) },
      );
    },
    [board.title, draft, updateBoard],
  );

  const claim = useCallback(() => {
    claimBoard.mutate(
      { id: board.id, owner: nickname },
      { onSuccess: () => toast.success(T.claimed(nickname)), onError: (e) => toast.error(errorMessage(e, T.claimFailed)) },
    );
  }, [board.id, claimBoard, nickname]);

  const duplicate = useCallback(() => {
    setBusy(true);
    createBoard.mutate(
      { title: T.copyTitle(title), ownerId: nickname },
      {
        onSuccess: async (created) => {
          try {
            // Posted to the COPY's endpoint (ui/boardOps.js): the server puts
            // a batch on the board in the URL, whatever `op.boardId` says.
            const res = await copyBoardElements(board.id, created.id);
            if (res.ok) toast.success(T.duplicated(created.title, res.count));
            else toast.error(T.duplicateEmpty(created.title));
            qc.invalidateQueries({ queryKey: queryKeys.allBoards });
            qc.invalidateQueries({ queryKey: queryKeys.board(created.id) });
            onOpen?.(created.id);
          } catch (e) {
            toast.error(errorMessage(e, T.duplicateFailed));
          } finally {
            setBusy(false);
          }
        },
        onError: (e) => {
          setBusy(false);
          toast.error(errorMessage(e, T.duplicateFailed));
        },
      },
    );
  }, [board.id, title, createBoard, nickname, onOpen, qc]);

  const remove = useCallback(() => {
    deleteBoard.mutate(board.id, {
      onSuccess: () => toast.success(T.deleted),
      onError: (e) => toast.error(errorMessage(e, T.deleteFailed)),
    });
  }, [board.id, deleteBoard]);

  const disabled = busy || createBoard.isPending || deleteBoard.isPending;

  return (
    <li className="board-row" data-board-id={board.id} onClick={() => !renaming && onOpen(board.id)}>
      <BoardPreview board={board} />
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

/**
 * The list, one server page at a time (`limit`/`offset`), plus an optional
 * title search. The server pages by creation date, so without paging a board
 * that is old but still in use fell off the only page ever requested, and
 * nothing in the UI could reach it.
 *
 * The key sits under the shared `['boards']` prefix, so every create, rename,
 * claim and delete that invalidates the lists refreshes this one too. The
 * trailing object keeps it apart from `useBoards`' string-keyed entries.
 */
function useBoardPages(nickname, search) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.allBoards, nickname ?? '', { paged: true, search }],
    queryFn: ({ pageParam, signal }) => api.get(boardListQuery({ owner: nickname, search, offset: pageParam }), { signal }),
    initialPageParam: 0,
    getNextPageParam: nextPageOffset,
    enabled: Boolean(nickname),
    staleTime: 5000,
    // While a new search loads, keep showing the last result rather than
    // flashing skeletons on every keystroke — but never another nickname's list.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey?.[1] === (nickname ?? '') ? prev : undefined),
  });
}

const SEARCH_DEBOUNCE_MS = 250;

export function BoardList({ onOpen }) {
  const createBoard = useCreateBoard();
  const nickname = useNickname();
  const [tick, setTick] = useState(0);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setSearch(searchText.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchText]);

  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage, isPlaceholderData } = useBoardPages(
    nickname,
    search,
  );
  const pages = data?.pages;
  const boards = useMemo(() => mergeBoardPages(pages), [pages]);
  // The server's count for the whole list (not just the pages in hand).
  const total = pages?.length ? pageTotal(pages[pages.length - 1]) ?? boards.length : 0;

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const list = useMemo(
    () => boards.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    // `tick` is a dependency on purpose: it re-renders the relative times.
    [boards, tick],
  );
  const counts = useMemo(() => {
    const mine = list.filter((b) => b.ownerId && b.ownerId === nickname).length;
    return { mine, unclaimed: list.filter((b) => !b.ownerId).length, loaded: list.length };
  }, [list, nickname]);
  // Mine / unclaimed can only be told apart for rows in hand: say the split
  // when everything is loaded, and "N of TOTAL" otherwise — never a split of
  // one page presented as the whole.
  const complete = !hasNextPage && counts.loaded >= total;
  const subtitle = isPlaceholderData
    ? T.searching
    : search
      ? T.searchCount(total, search)
      : total === 0
        ? T.subtitleEmpty
        : complete
          ? T.subtitle(counts.mine, counts.unclaimed)
          : T.subtitlePartial(counts.loaded, total);

  const create = useCallback(() => {
    createBoard.mutate(
      { title: T.defaultTitle, ownerId: nickname },
      {
        onSuccess: (b) => {
          toast.success(T.created);
          onOpen?.(b.id);
        },
        // A 404 here is a misrouted API, not a missing board.
        onError: (e) => toast.error(errorMessage(e, T.createFailed, { notFound: null })),
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
            <p className="board-list__subtitle" data-testid="board-count" data-total={total}>
              {subtitle}
            </p>
          </div>
          <div className="board-list__tools">
            <label className="board-search">
              <IconSearch size={16} className="board-search__icon" />
              <input
                type="search"
                className="field board-search__input"
                data-testid="board-search"
                placeholder={T.searchPlaceholder}
                aria-label={T.searchLabel}
                value={searchText}
                maxLength={120}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && searchText) {
                    e.preventDefault();
                    setSearchText('');
                  }
                }}
              />
            </label>
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
              <p>{errorSentence(error, { notFound: null }) || T.loadErrorText}</p>
              <button type="button" className="btn btn--primary" onClick={() => refetch()}>
                {T.retry}
              </button>
            </div>
          ) : list.length === 0 && search ? (
            <div className="island board-list__state" data-board-list-state="no-match">
              <span className="board-list__state-icon">
                <IconSearch size={24} />
              </span>
              <h2>{T.searchEmpty(search)}</h2>
              <p>{T.searchEmptyText}</p>
              <button type="button" className="btn" onClick={() => setSearchText('')}>
                {T.searchClear}
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
            <>
              <ul className="board-rows" data-board-list-state="ready">
                {list.map((b) => (
                  <BoardCard key={b.id} board={b} onOpen={onOpen} nickname={nickname} />
                ))}
              </ul>
              {hasNextPage ? (
                <div className="board-list__more">
                  <button
                    type="button"
                    className="btn"
                    data-testid="load-more-boards"
                    disabled={isFetchingNextPage}
                    onClick={() => void fetchNextPage()}
                  >
                    {isFetchingNextPage ? T.loadingMore : T.loadMore(Math.max(0, total - counts.loaded))}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default BoardList;
