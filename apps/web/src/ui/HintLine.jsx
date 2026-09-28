/**
 * HintLine.jsx — the one-line hint under the tool island describing the
 * current gesture (Excalidraw's hint viewer): what the active tool does, or
 * what can be done with the current selection.
 */

import React from 'react';
import { useBoardStore } from '../store/index.js';
import { isContainer, isLinear, isText } from '../editor/elements.js';
import { t } from './strings.js';

/**
 * What kind of selection this is, as a primitive (so the hook re-renders only
 * when it changes): '' none, 'linear', 'text' (text or a labelled container),
 * 'other' (one element of another type), 'many'.
 */
function selectionKind(s) {
  if (s.selection.size === 0) return '';
  if (s.selection.size > 1) return 'many';
  const id = s.selection.values().next().value;
  const el = s.elements.find((e) => e.id === id);
  if (!el) return '';
  if (isLinear(el)) return 'linear';
  if (isText(el) || isContainer(el)) return 'text';
  return 'other';
}

/** The hint for a state, or '' for none. Pure. */
export function hintFor({ tool, toolLocked, selection, editing }) {
  if (editing) return '';
  switch (tool) {
    case 'rect':
    case 'diamond':
    case 'ellipse':
    case 'cylinder':
      return toolLocked ? `${t.hints.shape} ${t.hints.locked}` : t.hints.shape;
    case 'sticky':
      return t.hints.sticky;
    case 'arrow':
    case 'line':
      return t.hints.linear;
    case 'pen':
      return t.hints.pen;
    case 'text':
      return t.hints.text;
    case 'eraser':
      return t.hints.eraser;
    case 'hand':
      return t.hints.hand;
    case 'image':
      return t.hints.image;
    default:
      break;
  }
  if (selection === 'linear') return t.hints.editPoints;
  if (selection === 'text') return t.hints.editText;
  if (selection) return t.hints.selection;
  return '';
}

export function HintLine() {
  const tool = useBoardStore((s) => s.tool);
  const toolLocked = useBoardStore((s) => s.toolLocked);
  const editing = useBoardStore((s) => Boolean(s.editingId));
  const selection = useBoardStore(selectionKind);
  const hint = hintFor({ tool, toolLocked, selection, editing });
  if (!hint) return null;
  return (
    <div className="hint-line" role="status" aria-live="polite" data-testid="hint-line">
      {hint}
    </div>
  );
}

export default HintLine;
