/**
 * ErrorBoundary.jsx — turns a render crash into a readable message instead of
 * a blank page.
 *
 * Two are mounted: one around the whole app (main.jsx) and one around the
 * canvas only (App.jsx), so a renderer bug costs the drawing surface, not the
 * menus the user still needs to save their work. The component stack shows in
 * development; the error is always logged, never swallowed.
 */

import React from 'react';
import { IconAlert } from './Icons.jsx';
import { t } from './strings.js';

const DEV = (() => {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
})();

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    console.error('[whiteboard] render error:', error, info);
    this.props.onError?.(error, info);
  }

  retry() {
    this.setState({ error: null, info: null });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    const { title, message, showStack } = this.props;
    return (
      <div className="screen screen--center error-screen">
        <div className="island error-card" role="alert">
          <div className="error-card__head">
            <span className="error-card__icon">
              <IconAlert size={22} />
            </span>
            <div>
              <h2 className="error-card__title">{title || t.errors.title}</h2>
              <p className="error-card__text">{message || t.errors.message}</p>
            </div>
          </div>
          <pre className="error-card__detail">{String(error?.message || error)}</pre>
          {(showStack ?? DEV) && info?.componentStack ? (
            <details className="error-card__stack">
              <summary>{t.errors.stack}</summary>
              <pre>{info.componentStack}</pre>
            </details>
          ) : null}
          <div className="form-actions">
            <button type="button" className="btn" onClick={this.retry}>
              {t.errors.retry}
            </button>
            <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
              {t.errors.reload}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
