/**
 * ErrorBoundary.jsx — a class boundary that turns a render crash into a
 * readable screen instead of a blank page.
 *
 * Two boundaries are mounted by App.jsx: one around the whole app and one
 * around just the canvas region, because a renderer bug (a malformed
 * element, a bad style) should cost the canvas and the status readout, not
 * the toolbar the user is still using.
 *
 * In development the component stack is printed under the message; in
 * production it is left out of the UI but still logged, because a board
 * holds hours of work and a silent failure is the expensive kind.
 */

import React from 'react';
import { IconAlert } from './Icons.jsx';

const DEV = Boolean(import.meta.env?.DEV);

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
    this.handleReload = this.handleReload.bind(this);
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    // The one console.error in the app: a crash report, not debug output.
    console.error('[whiteboard] render error:', error, info);
    this.props.onError?.(error, info);
  }

  handleReload() {
    window.location.reload();
  }

  handleRetry() {
    this.setState({ error: null, info: null });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const { title, message, showStack } = this.props;
    const detail = String(error?.message || error);

    return (
      <div
        className="app-shell"
        style={{ display: 'grid', placeItems: 'center', padding: 'var(--sp-5)' }}
      >
        <div
          className="panel"
          role="alert"
          style={{ maxWidth: 520, padding: 'var(--sp-5)', width: '100%' }}
        >
          <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--color-danger)', flex: 'none', marginTop: 2 }}>
              <IconAlert size={20} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h2
                className="panel__title"
                style={{ fontSize: 'var(--fs-lg)', lineHeight: 'var(--lh-lg)' }}
              >
                {title || 'Something went wrong'}
              </h2>
              <p
                style={{
                  color: 'var(--color-text-muted)',
                  fontSize: 'var(--fs-sm)',
                  lineHeight: 'var(--lh-sm)',
                  marginTop: 'var(--sp-2)',
                }}
              >
                {message ||
                  'This part of the board could not be displayed. Your changes are saved on the server — reloading should bring everything back.'}
              </p>
            </div>
          </div>

          <pre
            className="mono"
            style={{
              maxHeight: 132,
              overflow: 'auto',
              margin: 'var(--sp-4) 0 0',
              padding: 'var(--sp-3)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-surface-sunken)',
              color: 'var(--color-danger)',
              fontSize: 'var(--fs-xs)',
              lineHeight: 'var(--lh-xs)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {detail}
          </pre>

          {(showStack ?? DEV) && info?.componentStack ? (
            <details
              style={{
                marginTop: 'var(--sp-3)',
                fontSize: 'var(--fs-xs)',
                color: 'var(--color-text-muted)',
              }}
            >
              <summary style={{ cursor: 'pointer' }}>Component stack</summary>
              <pre
                className="mono"
                style={{
                  maxHeight: 180,
                  overflow: 'auto',
                  margin: 'var(--sp-2) 0 0',
                  whiteSpace: 'pre-wrap',
                  fontSize: 'var(--fs-xs)',
                  lineHeight: 'var(--lh-xs)',
                }}
              >
                {info.componentStack}
              </pre>
            </details>
          ) : null}

          <div
            style={{
              display: 'flex',
              gap: 'var(--sp-2)',
              justifyContent: 'flex-end',
              marginTop: 'var(--sp-4)',
            }}
          >
            <button type="button" className="btn btn--ghost" onClick={this.handleReload}>
              Reload
            </button>
            <button type="button" className="btn btn--primary" onClick={this.handleRetry}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
