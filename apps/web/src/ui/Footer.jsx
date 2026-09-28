/**
 * Footer.jsx — bottom-left zoom (− NN% +) and undo/redo islands, and the
 * bottom-right help button, as in Excalidraw. The percentage resets to 100%
 * about the viewport centre (not a jump back to the board origin).
 */

import React from 'react';
import { actions } from '../editor/actions.js';
import { useActions, useCanRedo, useCanUndo, useView } from '../store/index.js';
import { useUi } from './uiStore.js';
import { IconButton, Island } from './common.jsx';
import { IconHelp, IconRedo, IconUndo, IconZoomIn, IconZoomOut } from './Icons.jsx';
import { shortcutHint } from './shortcuts.js';
import { t } from './strings.js';

export function ZoomControls() {
  const view = useView();
  const pct = Math.round((view.zoom || 1) * 100);
  return (
    <Island className="zoom-island" role="group" aria-label={t.footer.zoom}>
      <IconButton label={t.actions.zoomOut} shortcut={shortcutHint('view.zoomOut')} onClick={() => actions.zoomOut()}>
        <IconZoomOut size={18} />
      </IconButton>
      <button
        type="button"
        className="zoom-value"
        title={t.footer.zoomReset(pct)}
        aria-label={t.footer.zoomReset(pct)}
        data-testid="zoom-value"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => actions.resetZoom()}
      >
        {pct}%
      </button>
      <IconButton label={t.actions.zoomIn} shortcut={shortcutHint('view.zoomIn')} onClick={() => actions.zoomIn()}>
        <IconZoomIn size={18} />
      </IconButton>
    </Island>
  );
}

export function UndoRedo() {
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const store = useActions();
  return (
    <Island className="history-island" role="group" aria-label={t.footer.history}>
      <IconButton label={t.actions.undo} shortcut={shortcutHint('edit.undo')} disabled={!canUndo} onClick={() => store.undo()} data-testid="undo">
        <IconUndo size={18} />
      </IconButton>
      <IconButton label={t.actions.redo} shortcut={shortcutHint('edit.redo')} disabled={!canRedo} onClick={() => store.redo()} data-testid="redo">
        <IconRedo size={18} />
      </IconButton>
    </Island>
  );
}

export function Footer() {
  return (
    <div className="footer-left">
      <ZoomControls />
      <UndoRedo />
    </div>
  );
}

export function HelpButton() {
  return (
    <Island className="island--button help-button">
      <IconButton label={t.actions.help} shortcut="?" onClick={() => useUi.getState().open('helpOpen')} data-testid="help-button">
        <IconHelp />
      </IconButton>
    </Island>
  );
}

export default Footer;
