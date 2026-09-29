/* ==========================================================================
   main.jsx — application entry point.

   Order matters:
     1. tokens.css first, so every other stylesheet resolves its custom
        properties; then the app's own styles.
     2. The hand-drawn fonts (Virgil, Cascadia Code) start loading right away
        through editor/fonts.js. The canvas re-measures text when they land.
     3. React, wrapped in the app-level error boundary and the query client.
   ========================================================================== */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';

import './styles/tokens.css';
import './styles/global.css';
import './styles/editor.css';
import './styles/dialogs.css';
import './styles/screens.css';

import { queryClient } from './api/client.js';
import { loadFonts } from './editor/fonts.js';
import { getState as getBoardState, subscribe as subscribeBoard } from './store/boardStore.js';
import { ErrorBoundary } from './ui/ErrorBoundary.jsx';
import { applyTheme } from './ui/theme.js';
import { useUi } from './ui/uiStore.js';
import { installModalClipboardGuard } from './ui/modal.js';
import App from './App.jsx';

// Before the first paint, so a dark-mode user never sees a white flash.
applyTheme(useUi.getState().theme);

// Before React mounts, so it runs ahead of every clipboard listener the board
// installs: while a modal dialog is open, Ctrl+C/X/V never reach the board.
installModalClipboardGuard(window);

// Never rejects: a font that fails falls back to the system stack.
loadFonts();

/**
 * A debug handle on the store, in development builds only — how browser
 * checks read selection, undo depth and element counts. Absent from
 * production, where it would be a way to edit a board without a gesture.
 */
if (import.meta.env.DEV) {
  window.__wb = { getState: getBoardState, subscribe: subscribeBoard };
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
