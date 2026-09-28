/**
 * App.jsx — page composition and the few things that belong to the page:
 *
 *   - resolve a board id from the URL (`?board=<id>`, `/b/:id` or a bare
 *     `/:id`) and write it back — a hand-rolled resolver, not a router: two
 *     routes do not need a dependency;
 *   - the nickname gate BEFORE routing (no name, no list, no board);
 *   - the board list at the root URL (it never auto-creates a board);
 *   - per board: mount `useRealtime` with the NICKNAME as the presence name,
 *     seed the store from the HTTP snapshot exactly once (inside `withRemote`,
 *     so hydration is not echoed back as create ops), apply the board's theme
 *     only as a default;
 *   - install the global keyboard handler and the copy/cut/paste listeners
 *     exactly once; they call the shared shortcut table and editor actions;
 *   - keep an error boundary around the canvas only.
 *
 * The drawing surface is editor/Canvas.jsx; every island over it is
 * ui/EditorUI.jsx.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useBoardSnapshot, useNickname } from './api/queries.js';
import { useRealtime } from './realtime/useRealtime.js';
import { withRemote } from './realtime/sync.js';
import { useBoardStore, useStoreHandle } from './store/index.js';
import Canvas from './editor/Canvas.jsx';
import { actions, screenToBoardPoint } from './editor/actions.js';

import { BoardList } from './ui/BoardList.jsx';
import { EditorUI } from './ui/EditorUI.jsx';
import { ErrorBoundary } from './ui/ErrorBoundary.jsx';
import { NicknameGate } from './ui/NicknameGate.jsx';
import { Toaster } from './ui/Toaster.jsx';
import { resetToasts, toast } from './ui/toast.js';
import { useUi } from './ui/uiStore.js';
import { applyTheme, hasStoredTheme } from './ui/theme.js';
import { isTypingTarget, runShortcut } from './ui/shortcuts.js';
import { openBoardFile } from './ui/commands.js';
import { t } from './ui/strings.js';

/* --- routing ---------------------------------------------------------------- */

/**
 * Board id out of the URL, in priority order:
 *   ?board=<id>   the canonical form we write
 *   /b/<id>       the share-link form (what the Share button copies)
 *   /<id>         tolerated, so a bare pasted id still opens
 * Returns null for the board list.
 */
export function resolveBoardId(href = window.location.href) {
  let url;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return null;
  }

  const q = url.searchParams.get('board');
  if (q) return q;

  const path = url.pathname.replace(/\/+$/, '');
  const byPath = path.match(/^\/b\/([^/]+)/);
  if (byPath) return decodeURIComponent(byPath[1]);

  // Tolerate a bare `/<id>` so a pasted id still opens, but not a file path.
  const bare = path.replace(/^\//, '');
  if (bare && !bare.includes('/') && !bare.includes('.') && !bare.startsWith('api')) {
    return decodeURIComponent(bare);
  }
  return null;
}

/**
 * The address-bar URL for a board: `/b/<id>?board=<id>` (other query params
 * kept). For null, the root — the list — so a reload does not reopen the
 * board that was just left.
 */
export function boardUrl(boardId) {
  if (!boardId) return '/';
  const url = new URL(window.location.href);
  url.pathname = `/b/${boardId}`;
  url.searchParams.set('board', boardId);
  return `${url.pathname}${url.search}`;
}

function navigateTo(boardId) {
  window.history.replaceState({}, '', boardUrl(boardId));
}

/* --- the keyboard / clipboard bridge ------------------------------------------ */

/** What shortcut handlers get as `ui`: always-live calls into the UI store. */
const uiHandle = {
  closeTopOverlay: () => useUi.getState().closeTopOverlay(),
  open: (key) => useUi.getState().open(key),
  toggle: (key) => useUi.getState().toggle(key),
  toggleTheme: () => useUi.getState().toggleTheme(),
  openFile: () => void openBoardFile(),
};

/** Is there a text selection on the page (help dialog, title…) the user means to copy? */
function hasPageSelection() {
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
  return Boolean(sel && !sel.isCollapsed && sel.toString());
}

/**
 * Global keydown + copy/cut/paste, installed once per board view. Letters,
 * digits and chords all resolve through ui/shortcuts.js; a key no binding
 * handled keeps its browser default.
 */
function useGlobalInput(store) {
  const pointer = useRef(null); // last pointer over the canvas, client px

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      // A modal dialog owns the keyboard (Tab, Enter, typing); only Escape,
      // which closes it, goes through the map.
      const ui = useUi.getState();
      if ((ui.helpOpen || ui.exportOpen || ui.confirm || ui.nicknameOpen) && event.key !== 'Escape') return;
      const id = runShortcut(event, { store, ui: uiHandle, actions });
      if (id) event.preventDefault();
    };

    const onPointerMove = (e) => {
      const canvas = e.target instanceof Element ? e.target.closest('[data-testid="canvas"]') : null;
      pointer.current = canvas ? { x: e.clientX, y: e.clientY, canvas } : null;
    };

    /** Board point under the pointer, when it is over the canvas. */
    const pastePoint = () => {
      const p = pointer.current;
      if (!p || !p.canvas.isConnected) return null;
      const r = p.canvas.getBoundingClientRect();
      return screenToBoardPoint({ x: p.x - r.left, y: p.y - r.top }, useBoardStore.getState().view);
    };

    const onCopy = (e) => {
      if (isTypingTarget(e.target) || hasPageSelection()) return;
      const text = actions.selectionClipboardText();
      if (!text || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };

    const onCut = (e) => {
      if (isTypingTarget(e.target) || hasPageSelection() || !e.clipboardData) return;
      const text = actions.cutSelection();
      if (!text) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };

    const onPaste = (e) => {
      // The Canvas takes image files first (capture phase) and prevents default.
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      e.preventDefault();
      void actions.paste(text, pastePoint());
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointermove', onPointerMove, { capture: true });
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, [store]);
}

/* --- the board view --------------------------------------------------------- */

/** Rejected edits are rolled back by the realtime layer; say so, but not in a burst. */
let lastRejectToast = 0;
function onRealtimeError(message, info) {
  if (info?.kind !== 'ops' || info?.code === 'REV_CONFLICT') return;
  const now = Date.now();
  if (now - lastRejectToast < 5000) return;
  lastRejectToast = now;
  toast.error(t.toast.rejected);
}

function BoardView({ boardId, nickname, theme }) {
  const store = useStoreHandle();

  // A different board than the store holds: start empty rather than drawing
  // the previous board's elements until the snapshot lands. Under withRemote,
  // so the sync bridge does not ship the wipe as deletes.
  useLayoutEffect(() => {
    const s = useBoardStore.getState();
    if (s.boardId !== boardId) {
      withRemote(() => {
        s.setSnapshot({ elements: [], rev: 0 }, { force: true });
        s.setBoard(null);
        s.setBoardId(boardId);
      });
      s.setView({ zoom: 1, panX: 0, panY: 0 });
    }
  }, [boardId]);

  useRealtime(boardId, { name: nickname, onError: onRealtimeError });

  /* --- seed from HTTP before the socket says `ready`, once per board ------ */
  const { data: snapshot } = useBoardSnapshot(boardId);
  const seededRef = useRef(null);
  useEffect(() => {
    if (!snapshot?.board || !Array.isArray(snapshot.elements)) return;
    if (seededRef.current === boardId) return;
    seededRef.current = boardId;
    // Hydration is NOT a local edit: without withRemote the sync bridge would
    // ship the whole board back as creates the server rejects.
    withRemote(() => {
      useBoardStore.getState().setSnapshot({ board: snapshot.board, elements: snapshot.elements, rev: snapshot.rev });
    });
    // The board's theme is a default: a stored user choice always wins.
    if (snapshot.board.theme && !hasStoredTheme()) useUi.getState().setTheme(snapshot.board.theme);
  }, [snapshot, boardId]);

  useGlobalInput(store);

  const onContextMenu = useCallback((info) => {
    if (!info) return;
    // Client px place the menu; the canvas fills the window, so its own
    // x/y are the fallback if a Canvas build does not report client px.
    useUi.getState().openContextMenu({
      x: info.clientX ?? info.x,
      y: info.clientY ?? info.y,
      targetId: info.targetId ?? null,
      at: screenToBoardPoint({ x: info.x, y: info.y }, useBoardStore.getState().view),
    });
  }, []);

  const onRequestImage = useCallback((at) => {
    void actions.insertImage(at);
  }, []);

  return (
    <div className="app-shell">
      <div className="canvas-host">
        <ErrorBoundary title={t.errors.canvasTitle} message={t.errors.canvasMessage}>
          <Canvas theme={theme} onContextMenu={onContextMenu} onRequestImage={onRequestImage} />
        </ErrorBoundary>
      </div>
      <EditorUI />
    </div>
  );
}

/* --- the app ---------------------------------------------------------------- */

export default function App() {
  const nickname = useNickname();
  const theme = useUi((s) => s.theme);
  const [boardId, setBoardId] = useState(() => resolveBoardId());

  // <html data-theme>: applied on every change, persisted only by a user toggle.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const onPop = () => setBoardId(resolveBoardId());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const onNavigate = useCallback((next) => {
    resetToasts();
    useUi.getState().closeAll();
    navigateTo(next ?? null);
    setBoardId(next ?? null);
  }, []);

  useEffect(() => {
    useUi.setState({ navigate: onNavigate });
  }, [onNavigate]);

  // The gate comes before routing and REPLACES the page: nothing below is
  // mounted, fetched or reachable without a name.
  if (!nickname) {
    return (
      <>
        <NicknameGate />
        <Toaster />
      </>
    );
  }

  if (!boardId) {
    return (
      <>
        <BoardList onOpen={onNavigate} />
        <Toaster />
      </>
    );
  }

  return (
    <>
      <BoardView key={boardId} boardId={boardId} nickname={nickname} theme={theme} />
      <Toaster />
    </>
  );
}
