/**
 * HintLine.jsx — the one-line hint under the tool island describing the
 * current gesture (Excalidraw's hint viewer): what the active tool does,
 * how to finish a connector placed click by click, what point editing does,
 * or what can be done with the current selection. The text is chosen by
 * ui/hints.js (pure, unit-tested).
 */

import React from 'react';
import { useBoardStore } from '../store/index.js';
import { useUi } from './uiStore.js';
import { hintFor, selectionKindOf } from './hints.js';
import { shortcutHint } from './shortcuts.js';

export function HintLine() {
  const tool = useBoardStore((s) => s.tool);
  const toolLocked = useBoardStore((s) => s.toolLocked);
  const editing = useBoardStore((s) => Boolean(s.editingId));
  const selection = useBoardStore(selectionKindOf);
  const gesture = useUi((s) => s.gestureHint);
  const hint = hintFor({ tool, toolLocked, selection, editing, gesture, lockKeys: shortcutHint('edit.lock') });
  if (!hint) return null;
  return (
    <div className="hint-line" role="status" aria-live="polite" data-testid="hint-line">
      {hint}
    </div>
  );
}

export default HintLine;
