/**
 * TopRight.jsx — the top-right cluster: the board title (click to rename),
 * the people on the board, the Share button (connection dot + peer count)
 * and the Library button.
 *
 * Renaming goes through `useUpdateBoard(boardId).mutate({title})` — PATCH
 * /boards/<id> with {title} — and the store's `board` is updated on success;
 * collaborators get the server's `{type:'board'}` broadcast.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { colorForPeer } from '@whiteboard/shared';
import { useUpdateBoard } from '../api/queries.js';
import { useBoard, useBoardId, useConnection, useMyPeerId, usePeers } from '../store/index.js';
import { useUi } from './uiStore.js';
import { copyShareLink } from './share.js';
import { toast } from './toast.js';
import { IconButton, Island } from './common.jsx';
import { IconLibrary, IconShare } from './Icons.jsx';
import { t } from './strings.js';

const MAX_AVATARS = 4;

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export function BoardTitle() {
  const board = useBoard();
  const boardId = useBoardId();
  const update = useUpdateBoard(boardId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);
  // One edit ends exactly once: Enter/Escape unmount the input, and a blur
  // that follows must neither save a cancelled edit nor save twice.
  const doneRef = useRef(false);
  const title = board?.title || t.board.untitled;

  useEffect(() => {
    if (editing) {
      doneRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const finish = (save) => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
    const next = draft.trim();
    if (!save || !next || next === board?.title || !boardId) return;
    update.mutate(
      { title: next },
      {
        onSuccess: () => toast.success(t.toast.renamed),
        onError: (e) => toast.error(e?.message || t.toast.renameFailed),
      },
    );
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="board-title board-title--input"
        value={draft}
        maxLength={120}
        aria-label={t.board.renameLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="board-title"
      title={`${title} — ${t.board.renameHint}`}
      data-testid="board-title"
      onClick={() => {
        setDraft(board?.title || '');
        setEditing(true);
      }}
    >
      {title}
    </button>
  );
}

export function PeerAvatars() {
  const peers = usePeers();
  const me = useMyPeerId();
  const ordered = useMemo(() => {
    const list = [...(peers ?? [])];
    list.sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : String(a.name || '').localeCompare(String(b.name || ''))));
    return list;
  }, [peers, me]);
  if (ordered.length <= 1) return null;
  const visible = ordered.slice(0, MAX_AVATARS);
  const hidden = ordered.length - visible.length;
  return (
    <div className="avatars" role="group" aria-label={t.board.peers(ordered.length)}>
      {visible.map((p) => {
        const self = p.id === me;
        const name = `${p.name || '?'}${self ? ` (${t.board.you})` : ''}`;
        const tool = p.tool && t.tools[p.tool] ? ` · ${t.tools[p.tool]}` : '';
        return (
          <span
            key={p.id}
            className={`avatar ${self ? 'avatar--self' : ''}`}
            style={{ '--peer-color': p.color || colorForPeer(p.id) }}
            title={`${name}${tool}`}
          >
            {initials(p.name)}
          </span>
        );
      })}
      {hidden > 0 ? (
        <span className="avatar avatar--more" title={ordered.slice(MAX_AVATARS).map((p) => p.name).join(', ')}>
          {t.board.more(hidden)}
        </span>
      ) : null}
    </div>
  );
}

export function ShareButton() {
  const boardId = useBoardId();
  const connection = useConnection();
  const peers = usePeers();
  const count = peers?.length ?? 0;
  const status = t.board.connection[connection] ?? connection;
  const people = count > 1 ? t.board.peers(count) : t.board.alone;
  return (
    <button
      type="button"
      className="share-btn"
      data-connection={connection}
      data-testid="share-button"
      title={`${status}\n${people}`}
      aria-label={`${t.board.share} — ${status}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void copyShareLink(boardId)}
    >
      <span className={`conn-dot conn-dot--${connection}`} aria-hidden="true" />
      <IconShare size={17} />
      <span className="share-btn__label">{t.board.share}</span>
      {count > 1 ? <span className="share-btn__count">{count}</span> : null}
    </button>
  );
}

export function LibraryButton() {
  const open = useUi((s) => s.libraryOpen);
  return (
    <Island className="island--button">
      <IconButton
        label={t.toolIsland.library}
        active={open}
        pressed={open}
        data-testid="library-button"
        onClick={() => useUi.getState().toggle('libraryOpen')}
      >
        <IconLibrary />
      </IconButton>
    </Island>
  );
}

export function TopRight() {
  return (
    <div className="top-right">
      <div className="top-right__title">
        <BoardTitle />
      </div>
      <PeerAvatars />
      <ShareButton />
      <LibraryButton />
    </div>
  );
}

export default TopRight;
