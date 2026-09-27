/**
 * App.jsx — page composition and nothing else.
 *
 * The responsibilities that genuinely belong here, and nowhere else:
 *   - resolve a board id out of the URL (`?board=<id>` or `/b/:id`) and write
 *     it back on change. A hand-rolled resolver, not a router: this app has
 *     exactly two routes and a router dependency would be ~15KB for a regex.
 *   - mount `useRealtime` once per board, and seed the store from the HTTP
 *     snapshot so the first paint has something to draw before the socket's
 *     `ready` lands
 *   - install the global keyboard handler from `shortcuts.js` exactly once,
 *     and provide the `ui` intents its handlers call
 *   - apply `data-theme` on <html>
 *   - keep an error boundary around the canvas region only
 *
 * Everything else lives in a component.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBoardSnapshot } from './api/queries.js';
import { useRealtime } from './realtime/useRealtime.js';
import { withRemote } from './realtime/sync.js';
import { useBoardStore, useStoreHandle } from './store/index.js';
import PenUnderlay from './canvas/PenUnderlay.jsx';
import FlowLayer from './flow/FlowLayer.jsx';
import { DndProvider } from './dnd/DndProvider.jsx';
import PresetPalette from './dnd/PresetPalette.jsx';
import { useDropOnCanvas } from './dnd/useDropOnCanvas.js';

import { BoardList } from './ui/BoardList.jsx';
import { ErrorBoundary } from './ui/ErrorBoundary.jsx';
import { ExportDialog } from './ui/ExportDialog.jsx';
import { HelpOverlay } from './ui/HelpOverlay.jsx';
import { StatusBar } from './ui/StatusBar.jsx';
import { Toaster, toast, resetToasts } from './ui/Toasts.jsx';
import { Toolbar } from './ui/Toolbar.jsx';
import { TopBar, applyTheme, readStoredTheme } from './ui/TopBar.jsx';
import { isTypingTarget, matchesEvent, runShortcut } from './ui/shortcuts.js';

/* --- routing ---------------------------------------------------------------- */

/**
 * Board id out of the URL, in priority order:
 *   ?board=<id>   the canonical form we write
 *   /b/<id>        the share-link form (what the Share button copies)
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

/** Write the board id into the address bar without adding a history entry. */
export function boardUrl(boardId) {
  if (!boardId) return `${window.location.pathname}`;
  const url = new URL(window.location.href);
  url.pathname = `/b/${boardId}`;
  url.searchParams.set('board', boardId);
  return `${url.pathname}${url.search}`;
}

function navigateTo(boardId) {
  window.history.replaceState({}, '', boardUrl(boardId));
}

/* --- clipboard, shared by the shortcuts and the Share button ---------------- */

let clipboard = [];

function cloneElements(list) {
  return list.map((el) => ({ ...el }));
}

/* --- the board view --------------------------------------------------------- */

function BoardView({ boardId, onNavigate, ui, theme, onToggleTheme }) {
  const store = useBoardStore;

  /* --- the canvas droppable -------------------------------------------
     This is the ONE registrar: `register: true` puts the canvas element into
     dnd-kit's container map under the id `canvas`, and the `setNodeRef` below
     is attached to that element.

     The distinction matters because `PresetPalette` also uses
     `useDropOnCanvas` (for its click-to-place) and does NOT own an element. dnd-kit
     keys droppables by id and the LAST registration wins, so a second
     registration from the palette would overwrite this one with a null node —
     no measurable rect, no collision, and dragging a preset onto the board
     would silently do nothing while clicking it worked. One registrar, one
     node, and both paths provably share this instance's `onDrop` through the
     module singleton.
     -------------------------------------------------------------------- */
  const { setNodeRef: setCanvasRef, isOver: isOverCanvas } = useDropOnCanvas({
    register: true,
  });

  // A stable identity for this browser on this board. The realtime client
  // already persists one per board id; this is only used to name the local
  // peer, so a short stable string is enough.
  const peerName = useMemo(() => {
    const key = 'whiteboard:peer-name';
    try {
      const saved = localStorage.getItem(key);
      if (saved) return saved;
      const generated = `Guest ${Math.floor(Math.random() * 900 + 100)}`;
      localStorage.setItem(key, generated);
      return generated;
    } catch {
      return 'Guest';
    }
  }, []);

  useRealtime(boardId, { name: peerName });

  /* --- seed the store from HTTP before the socket says `ready` ---------- */
  const { data: snapshot } = useBoardSnapshot(boardId);
  const seededRef = useRef(null);
  const onBoardTheme = ui.onBoardTheme;
  useEffect(() => {
    if (!snapshot?.board || !Array.isArray(snapshot.elements)) return;
    // Seed once per board. After that the socket owns the truth; re-seeding
    // on every query refetch would clobber an in-flight local edit.
    if (seededRef.current === boardId) return;
    seededRef.current = boardId;
    const s = store.getState();
    // Hydrating the board is NOT a local edit. Without this the sync bridge
    // sees the store go from empty to "14 elements" and ships the whole board
    // back as 14 `create` ops on every page load — which the server rejects,
    // because those elements already exist. The symptom is a board that looks
    // right and silently never syncs: presence connects, cursors arrive, and
    // no actual change ever reaches anyone else.
    withRemote(() => {
      s.setSnapshot({ board: snapshot.board, elements: snapshot.elements, rev: snapshot.rev });
    });
    // The board's own theme is a DEFAULT: an explicit user choice, persisted
    // in localStorage, always wins. Only surface the board's theme on a first
    // visit with no stored preference.
    if (snapshot.board.theme) {
      let hasChoice = true;
      try {
        hasChoice = Boolean(localStorage.getItem('whiteboard:theme'));
      } catch {
        hasChoice = false;
      }
      if (!hasChoice) onBoardTheme(snapshot.board.theme);
    }
  }, [snapshot, boardId, store, onBoardTheme]);

  /* --- clipboard intent, backed by the board store --------------------- */
  const copySelection = useCallback(() => {
    const s = store.getState();
    const ids = new Set(s.selection);
    const picked = s.elements.filter((e) => ids.has(e.id));
    clipboard = cloneElements(picked);
    if (picked.length) toast.success(`Copied ${picked.length} ${picked.length === 1 ? 'element' : 'elements'}`);
    return clipboard;
  }, [store]);

  const cutSelection = useCallback(() => {
    const s = store.getState();
    const ids = [...s.selection];
    if (!ids.length) return;
    copySelection();
    s.commit('cut');
    s.removeElements(ids);
  }, [store, copySelection]);

  const pasteClipboard = useCallback(() => {
    if (!clipboard.length) {
      toast.info('Nothing to paste');
      return;
    }
    const s = store.getState();
    const stamp = Date.now().toString(36);
    const copies = clipboard.map((el, i) => ({
      ...el,
      id: `${el.id}-p${stamp}${i}`,
      x: el.x + 24,
      y: el.y + 24,
    }));
    s.commit('paste');
    s.addElements(copies);
    s.select(copies.map((e) => e.id));
  }, [store]);

  const duplicateSelection = useCallback(() => {
    const s = store.getState();
    const ids = new Set(s.selection);
    const picked = s.elements.filter((e) => ids.has(e.id));
    if (!picked.length) {
      toast.info('Nothing selected to duplicate');
      return;
    }
    const stamp = Date.now().toString(36);
    const copies = picked.map((el, i) => ({
      ...el,
      id: `${el.id}-d${stamp}${i}`,
      x: el.x + 24,
      y: el.y + 24,
    }));
    s.commit('duplicate');
    s.addElements(copies);
    s.select(copies.map((e) => e.id));
  }, [store]);

  /* --- the intents shortcuts.js calls --------------------------------- */
  const zoomStep = useCallback(
    (dir) => {
      // Zoom about the viewport centre. Zooming about (0,0) throws the board
      // off-screen, which is the single most common way to get lost on a
      // canvas, and the store's zoomAtScreen already clamps to ZOOM_LIMITS.
      const s = store.getState();
      const rect = document.querySelector('.canvas-host')?.getBoundingClientRect();
      s.zoomAtScreen(
        { x: rect ? rect.width / 2 : window.innerWidth / 2, y: rect ? rect.height / 2 : window.innerHeight / 2 },
        dir > 0 ? 1.2 : 1 / 1.2,
      );
    },
    [store],
  );

  const copyShareLink = useCallback(async () => {
    const url = `${location.origin}/b/${boardId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Share link copied');
    } catch {
      window.prompt('Copy this link', url);
    }
  }, [boardId]);

  // The ui facade is rebuilt when any of its members change, but the keyboard
  // effect reads it from a ref so installing the listener never re-binds.
  const uiRef = useRef();
  uiRef.current = {
    ...ui,
    duplicateSelection,
    copySelection,
    cutSelection,
    pasteClipboard,
    zoomStep,
    copyShareLink,
  };

  /* --- hydrate the store's boardId whenever it changes ----------------- */
  useEffect(() => {
    const s = store.getState();
    if (s.boardId !== boardId) s.setBoardId(boardId);
  }, [boardId, store]);

  /* --- pan-cursor state (middle mouse / space) ------------------------- */
  const [panning, setPanning] = useState(false);
  useEffect(() => {
    const down = (e) => {
      if (e.button === 1 || e.getModifierState?.('Space')) setPanning(true);
    };
    const up = () => setPanning(false);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
    };
  }, []);

  return (
    <div className="app-shell" data-panning={panning ? 'true' : 'false'}>
      <div
        className="canvas-host"
        data-tool={store.getState().tool}
        ref={setCanvasRef}
        data-canvas-droppable="canvas"
        data-drop-over={isOverCanvas ? 'true' : 'false'}
      >
        <ErrorBoundary
          title="The canvas hit a problem"
          message="The board surface could not be drawn, but the rest of the app is still working. Reloading usually fixes it; your changes are saved on the server."
        >
          {/* The pen underlay. It is BELOW the flow layer and only takes
              pointer events while the pen tool is active, because a freehand
              stroke is not a node and cannot live in React Flow's model. It
              draws nothing but the strokes. */}
          <PenUnderlay />
          <FlowLayer />
        </ErrorBoundary>
      </div>

      {/* The preset palette. It was written, tested and never imported — which
          is why the feature read as missing rather than broken.

          It sits immediately RIGHT of the toolbar rail, not in the top-right
          corner: `.toast-area` is anchored top-right (360px wide, z-index 70)
          and grows downward, so a panel there is buried by the first four
          toasts — and each toast row takes pointer events, so it would swallow
          the very clicks the palette exists to receive. Left of the toasts and
          clear of the toolbar, it overlaps nothing.

          The wrapper is `pointer-events: none` and the palette sets its own
          `auto`, so only the panel's own tiles and search field intercept
          gestures; the rest of the board stays fully draggable underneath. */}
      <div
        style={{
          position: 'absolute',
          top: 'calc(var(--topbar-height) + var(--sp-4))',
          left: 'calc(var(--sp-3) + var(--toolbar-width) + var(--sp-2))',
          bottom: 'calc(var(--statusbar-height) + var(--sp-4))',
          zIndex: 'var(--z-panels)',
          display: 'flex',
          alignItems: 'flex-start',
          pointerEvents: 'none',
        }}
      >
        <PresetPalette
          onPlaced={(elements) => {
            // Select what was just placed: the user placed it, so it is the
            // thing they want to move, edit or delete next. A multi-element
            // preset lands as one selection, so Delete removes the whole thing
            // in a single step.
            //
            // Deliberately no toast here. The element appearing on the board
            // and the status bar's count ticking up ARE the confirmation, and a
            // toast per placement stacks four deep over the board — the third
            // piece of the UI in this app that covered the thing you are
            // trying to click.
            const s = store.getState();
            s.select(elements.map((e) => e.id));
          }}
        />
      </div>

      <TopBar
        onNavigate={onNavigate}
        onOpenExport={ui.openExport}
        onOpenHelp={ui.openHelp}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />
      <Toolbar />
      <StatusBar />
      <HelpOverlay open={ui.helpOpen} onClose={ui.closeHelp} />
      <ExportDialog open={ui.exportOpen} onClose={ui.closeExport} />
    </div>
  );
}

/* --- the app ---------------------------------------------------------------- */

export default function App() {
  // A facade for the imperative call sites: the global keydown listener, the
  // shortcut table, the dnd drop path. It reads the LIVE state and forwards
  // every action to it, so `store.commit(...)` and `store.removeElements(...)`
  // are real calls.
  //
  // This indirection exists because the actions live INSIDE the state object,
  // not on the hook function — `useBoardStore` only carries `getState`. Code
  // that received the bare hook got `undefined` for every action, and the
  // `try/catch` inside `runShortcut` swallowed the TypeError, so the shortcut
  // matched, ran, and did nothing. That is why Delete appeared dead: the key
  // was reaching the app the whole time.
  const store = useStoreHandle();
  const [boardId, setBoardId] = useState(() => resolveBoardId());
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  /* --- theme --------------------------------------------------------- */
  const [theme, setTheme] = useState(readStoredTheme);
  const themeRef = useRef('stored');
  useEffect(() => {
    // `themeRef` distinguishes "came from a board" (session only) from "the
    // user pressed the toggle" (remembered).
    applyTheme(theme, themeRef.current !== 'board');
  }, [theme]);
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      themeRef.current = 'user';
      applyTheme(next, true);
      return next;
    });
  }, []);

  /* --- the root URL shows the board list; it never creates one --------- */
  //
  // This used to auto-seed "My first board" and navigate into it whenever the
  // URL carried no board id. That made the root URL unusable: you landed in a
  // brand-new EMPTY board instead of the list of boards you already had, and
  // every reload made another one — the demo server collected 15 of them. It
  // also raced the real user, creating boards for people who only wanted to
  // look at the list.
  //
  // Creating a board is a decision a person makes, so it happens when they
  // click "New board" on the list (BoardList.jsx), not as a side effect of
  // loading a page. The root now simply renders that list.
  useEffect(() => {
    // Intentionally empty — see above.
  }, [boardId]);

  /* --- back/forward between boards ---------------------------------- */
  useEffect(() => {
    const onPop = () => setBoardId(resolveBoardId());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const onNavigate = useCallback((next) => {
    resetToasts();
    navigateTo(next);
    setBoardId(next ?? null);
  }, []);

  const openHelp = useCallback(() => setHelpOpen(true), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const openExport = useCallback(() => setExportOpen(true), []);
  const closeExport = useCallback(() => setExportOpen(false), []);
  const toggleExport = useCallback(() => setExportOpen((v) => !v), []);
  const toggleHelp = useCallback(() => setHelpOpen((v) => !v), []);
  const goToBoardList = useCallback(() => onNavigate(null), []);

  /**
   * Dismiss the topmost overlay, or report that nothing is open. Ordered by
   * what is visually on top: the export dialog is z-60, the help sheet the
   * same, but the user opened whichever is later, so the LAST opened wins.
   */
  const closeTopOverlay = useCallback(() => {
    if (exportOpenRef.current) {
      setExportOpen(false);
      return true;
    }
    if (helpOpenRef.current) {
      setHelpOpen(false);
      return true;
    }
    return false;
  }, []);
  const exportOpenRef = useRef(exportOpen);
  const helpOpenRef = useRef(helpOpen);
  exportOpenRef.current = exportOpen;
  helpOpenRef.current = helpOpen;

  /* --- the global keyboard handler, installed exactly once ------------ */
  const uiRef = useRef();
  uiRef.current = {
    closeTopOverlay,
    toggleHelp,
    toggleExport,
    goToBoardList,
    toggleTheme,
    copyShareLink: () => {
      const id = store.getState().boardId;
      if (!id) return;
      const url = `${location.origin}/b/${id}`;
      navigator.clipboard?.writeText(url).then(
        () => toast.success('Share link copied'),
        () => window.prompt('Copy this link', url),
      );
    },
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      // Space is a pan modifier, not a command: it must not scroll the page
      // and must not be swallowed while someone is typing a sticky note.
      if (isTypingTarget(event.target) && event.key !== 'Escape') {
        // Still let Escape through — the text editor and the dialogs both
        // rely on it — but nothing else fires from inside a text field.
        if (!matchesEvent(event, ['Escape'], { allowInInput: true })) return;
      }
      if (event.key === ' ' && !isTypingTarget(event.target)) {
        // Held-space pan: block the page scroll without consuming the event,
        // so the canvas's own handler still sees it.
        event.preventDefault();
      }
      const id = runShortcut(event, { store, ui: uiRef.current });
      if (id) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store]);

  /* --- keep the store's boardId in step with the URL ------------------ */
  useEffect(() => {
    const s = store.getState();
    if (s.boardId !== boardId) s.setBoardId(boardId ?? null);
  }, [boardId, store]);

  // The board's own theme seeds App's theme only when the user has never
  // chosen one; see BoardView's snapshot effect.
  const onBoardTheme = useCallback((boardTheme) => {
    // Not persisted: a board's theme is a default, not a user decision.
    if (boardTheme !== 'light' && boardTheme !== 'dark') return;
    themeRef.current = 'board';
    setTheme((current) => (current === boardTheme ? current : boardTheme));
  }, []);
  const ui = { openHelp, closeHelp, openExport, closeExport, onBoardTheme };

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
      {/* `DndProvider` places a released preset itself: it reads the shared
          canvas drop handle and calls `resolveCanvasDrop`, which ignores
          anything that is not a drop on the canvas. This `onDragEnd` is only
          for callers that want to observe the outcome, and it receives the
          elements that were actually placed (null when nothing was). */}
      <DndProvider
        onDragEnd={(_event, placed) => {
          if (!placed?.length) return;
          const s = store.getState();
          s.select(placed.map((e) => e.id));
        }}
      >
        <BoardView
          boardId={boardId}
          onNavigate={onNavigate}
          ui={ui}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      </DndProvider>
      <Toaster />
    </>
  );
}
