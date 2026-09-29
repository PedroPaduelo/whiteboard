/**
 * App.jsx — page composition and the few things that belong to the page:
 *
 *   - resolve a board id from the URL (`?board=<id>`, `/b/:id` or a bare
 *     `/:id`) and write it back — a hand-rolled resolver (ui/routing.js), not
 *     a router: two routes do not need a dependency. Moving between the list
 *     and a board pushes a history entry, so Back/Forward work;
 *   - a board id the server does not know (bad link, deleted board, even one
 *     deleted while open) shows ui/BoardNotFound.jsx INSTEAD of the editor:
 *     nothing drawn there could ever be saved;
 *   - the nickname gate BEFORE routing (no name, no list, no board);
 *   - the board list at the root URL (it never auto-creates a board);
 *   - per board: mount `useRealtime` with the NICKNAME as the presence name,
 *     seed the store from the HTTP snapshot exactly once (inside `withRemote`,
 *     so hydration is not echoed back as create ops), apply the board's theme
 *     only as a default (ui/theme.js);
 *   - per board: put back the view this browser last had on it
 *     (ui/viewMemory.js); a board opened for the first time whose content is
 *     all off-screen scrolls to it, rather than showing an empty canvas;
 *   - install the global keyboard handler and the copy/cut/paste listeners
 *     exactly once; they call the shared shortcut table and editor actions,
 *     and leave the board alone while a modal dialog is open;
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
import { actions, anyElementVisible, screenToBoardPoint, viewportSize } from './editor/actions.js';

import { BoardList } from './ui/BoardList.jsx';
import { EditorUI } from './ui/EditorUI.jsx';
import { ErrorBoundary } from './ui/ErrorBoundary.jsx';
import { NicknameGate } from './ui/NicknameGate.jsx';
import { Toaster } from './ui/Toaster.jsx';
import { resetToasts, toast } from './ui/toast.js';
import { useUi } from './ui/uiStore.js';
import { applyTheme, boardDefaultTheme, hasStoredTheme, initialTheme } from './ui/theme.js';
import { isTypingTarget, runShortcut } from './ui/shortcuts.js';
import { isModalOpen } from './ui/modal.js';
import { loadView, saveView } from './ui/viewMemory.js';
import { openBoardFile } from './ui/commands.js';
import { boardUrl as boardUrlFor, navigateTo, resolveBoardId as resolveBoardIdFrom } from './ui/routing.js';
import { BoardNotFound } from './ui/BoardNotFound.jsx';
import { t } from './ui/strings.js';

/* --- routing ---------------------------------------------------------------- */

/** Board id out of the current URL (see ui/routing.js); null for the list. */
export function resolveBoardId(href = window.location.href) {
  return resolveBoardIdFrom(href, window.location.origin);
}

/** The address-bar URL for a board (or '/' for the list). */
export function boardUrl(boardId) {
  return boardUrlFor(boardId, window.location.href, window.location.origin);
}

/* --- the keyboard / clipboard bridge ------------------------------------------ */

/** What shortcut handlers get as `ui`: always-live calls into the UI store. */
const uiHandle = {
  closeTopOverlay: () => useUi.getState().closeTopOverlay(),
  isOpen: (key) => Boolean(useUi.getState()[key]),
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

/** Does this native copy / cut put text from a text field on the clipboard (not a bare caret)? */
function fieldHasSelection(target) {
  if (typeof target?.selectionStart === 'number') return target.selectionStart !== target.selectionEnd;
  return hasPageSelection(); // contenteditable
}

/**
 * Global keydown + copy/cut/paste, installed once per board view. Letters,
 * digits and chords all resolve through ui/shortcuts.js; a key no binding
 * handled keeps its browser default.
 */
function useGlobalInput(store, enabled = true) {
  const pointer = useRef(null); // last pointer over the canvas, client px

  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      // A modal dialog owns the keyboard (Tab, Enter, typing): only the
      // bindings marked `inModal` run — Escape, which closes it, and '?',
      // which closes the help sheet it opened.
      const id = runShortcut(event, { store, ui: uiHandle, actions }, { modal: isModalOpen() });
      if (id) event.preventDefault();
    };

    const onPointerMove = (e) => {
      const canvas = e.target instanceof Element ? e.target.closest('[data-testid="canvas"]') : null;
      pointer.current = canvas ? { x: e.clientX, y: e.clientY, canvas } : null;
    };

    // Pressing the drawing surface ends any text selection left on the page
    // (a panel label or a toast double-clicked by accident). Chromium never
    // collapses one when a <canvas> is clicked, and while it lasts Ctrl+C/X
    // belong to it (see hasPageSelection): the clipboard got "Traço" instead
    // of the selected elements, and a cut did nothing.
    const onPointerDown = (e) => {
      if (!(e.target instanceof Element) || e.target.tagName !== 'CANVAS') return;
      if (!e.target.closest('[data-testid="canvas"]')) return;
      const sel = window.getSelection?.();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    };

    /** Board point under the pointer, when it is over the canvas. */
    const pastePoint = () => {
      const p = pointer.current;
      if (!p || !p.canvas.isConnected) return null;
      const r = p.canvas.getBoundingClientRect();
      return screenToBoardPoint({ x: p.x - r.left, y: p.y - r.top }, useBoardStore.getState().view);
    };

    // The clipboard handlers leave the board alone while a modal is open (the
    // guard main.jsx installs normally stops the event before it gets here).
    // A copy / cut of page text (a text field, a selection in a panel) is
    // left to the browser, and what it puts on the system clipboard is then
    // newer than any in-memory-only copy of elements (actions.copy's last
    // resort): the next Ctrl+V must paste it.
    const onCopy = (e) => {
      if (isModalOpen()) return;
      if (isTypingTarget(e.target) || hasPageSelection()) {
        if (hasPageSelection() || fieldHasSelection(e.target)) actions.noteSystemClipboardWrite();
        return;
      }
      const text = actions.selectionClipboardText();
      if (!text || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
      actions.noteSystemClipboardWrite();
    };

    const onCut = (e) => {
      if (isModalOpen()) return;
      if (isTypingTarget(e.target) || hasPageSelection()) {
        if (hasPageSelection() || fieldHasSelection(e.target)) actions.noteSystemClipboardWrite();
        return;
      }
      if (!e.clipboardData) return;
      const text = actions.cutSelection();
      if (!text) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
      actions.noteSystemClipboardWrite();
    };

    const onPaste = (e) => {
      // The Canvas takes image files first (capture phase) and prevents default.
      if (e.defaultPrevented || isModalOpen() || isTypingTarget(e.target)) return;
      // The system text — unless a menu Copy could only keep its elements in
      // memory (no async clipboard, execCommand refused): those are newer.
      const text = actions.clipboardTextForPaste(e.clipboardData?.getData('text/plain') ?? '');
      if (!text) return;
      e.preventDefault();
      void actions.paste(text, pastePoint());
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointermove', onPointerMove, { capture: true });
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, [store, enabled]);
}

/* --- the board view --------------------------------------------------------- */

/** Rejected edits are rolled back by the realtime layer; say so, but not in a burst. */
let lastRejectToast = 0;
function onRealtimeError(message, info) {
  // A missing board is not a rejected edit (and nothing is rolled back): the
  // board view shows the not-found screen for it instead.
  if (info?.code === 'BOARD_NOT_FOUND') return;
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
  // so the sync bridge does not ship the wipe as deletes. The view is the one
  // this browser last had on the board, else the origin.
  const restoredView = useRef(false);
  useLayoutEffect(() => {
    const s = useBoardStore.getState();
    const saved = loadView(boardId);
    restoredView.current = Boolean(saved);
    if (s.boardId !== boardId) {
      withRemote(() => {
        s.setSnapshot({ elements: [], rev: 0 }, { force: true });
        s.setBoard(null);
        s.setBoardId(boardId);
      });
      s.setView(saved ?? { zoom: 1, panX: 0, panY: 0 });
    } else if (saved) {
      s.setView(saved);
    }
  }, [boardId]);

  // Remember the view as it changes (throttled: a pan changes it every frame),
  // and once more on the way out.
  useEffect(() => {
    let timer = null;
    const flush = () => {
      clearTimeout(timer);
      timer = null;
      const s = useBoardStore.getState();
      if (s.boardId === boardId) saveView(boardId, s.view);
    };
    const unsubscribe = useBoardStore.subscribe((s, prev) => {
      if (s.view === prev.view || s.boardId !== boardId) return;
      if (timer === null) timer = setTimeout(flush, 400);
    });
    window.addEventListener('pagehide', flush);
    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', flush);
      if (timer !== null) flush();
    };
  }, [boardId]);

  // The server said this board does not exist: over the socket (unknown id
  // on join, or an op / resync after someone deleted it while it was open).
  const [gone, setGone] = useState(false);
  const onError = useCallback((message, info) => {
    if (info?.code === 'BOARD_NOT_FOUND') {
      setGone(true);
      return;
    }
    onRealtimeError(message, info);
  }, []);

  /* --- seed from HTTP before the socket says `ready`, once per board ------ */
  const { data: snapshot, error: snapshotError } = useBoardSnapshot(boardId, { enabled: !gone });
  // 404, or a 400 for an id the server cannot even look up: no such board.
  const snapshotMissing = snapshotError?.status === 404 || snapshotError?.status === 400;
  const notFound = gone || snapshotMissing;

  useRealtime(boardId, { name: nickname, onError, enabled: !notFound });

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
    // First visit, and nothing on screen: the content is elsewhere on the
    // board (Excalidraw scrolls to it), not "an empty board". A remembered
    // view is kept as it is; the "Voltar ao conteúdo" pill covers that case.
    const s = useBoardStore.getState();
    if (!restoredView.current && s.elements.length && !anyElementVisible(s.elements, s.view, viewportSize(s))) {
      actions.scrollToContent();
    }
  }, [snapshot, boardId]);

  // The board's theme is a default for THIS board only: a stored user choice
  // always wins, and leaving the board goes back to the start value (the OS
  // preference) — it used to stick, list included.
  const boardTheme = boardDefaultTheme(snapshot?.board?.theme);
  useEffect(() => {
    if (!boardTheme || hasStoredTheme()) return undefined;
    useUi.getState().setTheme(boardTheme);
    return () => {
      if (!hasStoredTheme()) useUi.getState().setTheme(initialTheme());
    };
  }, [boardTheme]);

  // No editing on a board that does not exist: no shortcuts, no paste.
  useGlobalInput(store, !notFound);

  // Leaving an open board that turned out missing: drop what is left of it
  // (menus, dialogs) so nothing edits it from behind the not-found screen.
  useEffect(() => {
    if (!notFound) return;
    useUi.getState().closeAll();
    const s = useBoardStore.getState();
    if (s.editingId) s.setEditing(null);
  }, [notFound]);

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

  if (notFound) {
    // `deleted`: it loaded fine here earlier, so someone removed it meanwhile.
    return (
      <BoardNotFound
        boardId={boardId}
        deleted={Boolean(seededRef.current === boardId && !snapshotMissing)}
        onBoards={() => useUi.getState().navigate?.(null)}
      />
    );
  }

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
    // Back/Forward between the list and a board (entries pushed by navigateTo).
    const onPop = () => {
      useUi.getState().closeAll();
      setBoardId(resolveBoardId());
    };
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
