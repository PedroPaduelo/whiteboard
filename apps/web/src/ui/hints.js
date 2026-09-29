/**
 * hints.js — what the hint line under the tool island says (Excalidraw's
 * hint viewer), as pure functions: the text for a state, and the gesture
 * kind the canvas publishes for it.
 *
 * Two states live only inside the canvas' interaction reducer: a connector
 * being made click by click, and a connector in point editing. The canvas
 * publishes them as `useUi` `gestureHint` ('linearMulti' | 'pointEditing' |
 * null, computed with `gestureHintOf`) so the hint can explain how to finish
 * or what point editing does — before, it kept repeating the step the user
 * had just taken.
 *
 * Plain JS (no JSX) so node tests can import it; ui/HintLine.jsx renders it.
 */

import { isContainer, isLinear, isText } from '../editor/elements.js';
import { t } from './strings.js';

/** Gesture kinds the canvas may publish (`useUi.getState().setGestureHint`). */
export const GESTURE_HINTS = Object.freeze(['linearMulti', 'pointEditing']);

/**
 * The gesture kind for an interaction state (editor/interaction.js), or
 * null: a connector placed click by click, or point editing of one.
 */
export function gestureHintOf(state) {
  if (!state) return null;
  const g = state.g;
  if (g && g.kind === 'linear' && g.phase === 'clicking') return 'linearMulti';
  if (state.linearEdit?.editing) return 'pointEditing';
  return null;
}

/**
 * What kind of selection a board state has, as a primitive (so the hint
 * line's hook re-renders only when it changes): '' none, 'locked' (one
 * element, locked), 'lockedMany' (several, all locked), 'linear', 'text'
 * (text or a labelled container), 'other' (one element of another type),
 * 'many'. A locked selection is its own kind: it can be neither edited nor
 * moved, so offering "Enter to edit the text" there promised an action
 * that is refused.
 */
export function selectionKindOf(state) {
  const sel = state?.selection;
  if (!sel || sel.size === 0) return '';
  let count = 0;
  let locked = 0;
  let only = null;
  for (const el of state.elements ?? []) {
    if (!sel.has(el.id)) continue;
    count += 1;
    if (el.locked) locked += 1;
    only = el;
  }
  if (count === 0) return '';
  if (locked === count) return count > 1 ? 'lockedMany' : 'locked';
  if (count > 1) return 'many';
  if (isLinear(only)) return 'linear';
  if (isText(only) || isContainer(only)) return 'text';
  return 'other';
}

/**
 * The hint for a state, or '' for none.
 *
 * @param {{tool: string, toolLocked?: boolean, selection?: string,
 *   editing?: boolean, gesture?: string|null, lockKeys?: string}} s
 *   `selection`: see selectionKindOf; `gesture`: see gestureHintOf;
 *   `lockKeys`: the lock shortcut as shown to the user ('Ctrl+Shift+L').
 */
export function hintFor({ tool, toolLocked = false, selection = '', editing = false, gesture = null, lockKeys = 'Ctrl+Shift+L' }) {
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
      return gesture === 'linearMulti' ? t.hints.linearMulti : t.hints.linear;
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
  if (selection === 'locked') return t.hints.lockedElement(lockKeys);
  if (selection === 'lockedMany') return t.hints.lockedElements(lockKeys);
  // Point editing only means something for the lone connector it belongs to.
  if (selection === 'linear') return gesture === 'pointEditing' ? t.hints.pointEditing : t.hints.editPoints;
  if (selection === 'text') return t.hints.editText;
  if (selection) return t.hints.selection;
  return '';
}
