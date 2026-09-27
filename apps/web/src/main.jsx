/* ==========================================================================
   main.jsx — application entry point.

   Order matters here:
     1. tokens.css FIRST, so every other stylesheet can resolve the custom
        properties it references.
     2. reactflow/dist/style.css — React Flow ships its stylesheet as a side
        effect of using the library. Without it the structural layer renders
        completely unstyled (no node boxes, no edges) and it looks like the
        component is broken.
     3. The app's own styles.

   Ownership: this file is owned by the scaffold agent. The QueryClient is
   imported from the store agent's ./api/client.js; App comes from the ui
   agent's ./App.jsx.
   ========================================================================== */

import { StrictMode, Component } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';

import './styles/tokens.css';
import 'reactflow/dist/style.css';
import './styles/global.css';
import './styles/toolbar.css';
import './styles/panels.css';

import { queryClient } from './api/client.js';
import App from './App.jsx';
import { getState as getBoardState, subscribe as subscribeBoard } from './store/boardStore.js';

/* -------------------------------------------------------------------------
   Error boundary

   Without this, a render crash unmounts the whole tree and the user stares at
   a blank white page with a red console message they cannot see. A board
   usually holds hours of work that is still on the server, so the message
   tells them the board is safe and offers a reload.
   ---------------------------------------------------------------------- */

/**
 * A debug handle on the store, in development builds only.
 *
 * It is how the browser checks read state to assert on behaviour that has no
 * unit test — selection, undo depth, element count — and how the manual QA
 * pass during the React Flow rewrite inspected a gesture that had just run.
 * Deliberately absent from a production build: there, the store's mutations
 * would be a way to edit a board from the console without ever going through a
 * real gesture, and the undo stack would stop meaning what it says.
 */
if (import.meta.env.DEV) {
  window.__wb = { getState: getBoardState, subscribe: subscribeBoard };
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleReload = this.handleReload.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept deliberately: this is the one console.error in the app and it is
    // a crash report, not leftover debug output.
    console.error('[whiteboard] render error:', error, info);
  }

  handleReload() {
    window.location.reload();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app-shell" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="panel" style={{ maxWidth: 480, padding: 24 }} role="alert">
          <h1 className="panel__title" style={{ fontSize: 'var(--fs-lg)', marginBottom: 8 }}>
            Something went wrong
          </h1>
          <p
            style={{
              color: 'var(--color-text-muted)',
              fontSize: 'var(--fs-sm)',
              lineHeight: 'var(--lh-sm)',
              marginBottom: 16,
            }}
          >
            The board could not be displayed. Your changes are saved on the server — reloading
            should bring everything back.
          </p>
          <pre
            className="mono"
            style={{
              maxHeight: 140,
              overflow: 'auto',
              margin: '0 0 16px',
              padding: 12,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-surface-sunken)',
              color: 'var(--color-danger)',
              fontSize: 'var(--fs-xs)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {String(error?.message || error)}
          </pre>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn--ghost" onClick={this.handleReload}>
              Reload
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/* ------------------------------------------------------------------------- */

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
