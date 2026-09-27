/**
 * textEdit.js — the in-place `<textarea>` overlay for editing `text` and
 * `sticky` on the canvas.
 *
 * Why a real textarea and not a contenteditable div: caret movement, IME
 * composition, native undo, mobile keyboards and screen readers all work for
 * free, and "works like a normal text field" is the entire UX.
 *
 * The three things that are easy to get wrong here:
 *
 *  1. FOCUS MUST SURVIVE A REMOTE UPDATE. A peer moves the element while you
 *     are typing, the store replaces the element object, React re-renders,
 *     and a naive `key={el.id}` + `useEffect(focus)` steals your caret to the
 *     end on every keystroke. So the caret position is saved and restored
 *     around re-renders, and the component is keyed by id only.
 *
 *  2. A CLICK MUST NOT REACH THE CANVAS. Without stopPropagation the
 *     pointerdown that focuses the textarea also starts a marquee drag
 *     behind it. All pointer/keyboard events are stopped.
 *
 *  3. THE ELEMENT CAN DISAPPEAR. A peer deletes it while you are typing;
 *     `onCommit` then patches an id that no longer exists, which the store
 *     treats as a no-op — but the local buffer must still be discarded.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { boardToScreen, zoomAt } from '@whiteboard/shared';
import { FONT_STACK, LINE_HEIGHT, textHeight } from './shapes.js';

const MAX_TEXT = 4000;

/** The font size a text box gets when the user has not chosen one. It used to
 *  live in `interaction.js`, which the React Flow rewrite made obsolete; a
 *  single constant is not worth a 1,400-line module's existence. */
export const DEFAULT_FONT_SIZE = 20;
const MAX_LABEL = 500;

/** Sticky notes get a slightly larger default than a floating text box. */
const STICKY_DEFAULT_SIZE = { w: 160, h: 160 };
const TEXT_DEFAULT_SIZE = { w: 220, h: 48 };
const STICKY_DEFAULT_FONT = 16;

/**
 * @param {object} props
 * @param {object} props.element   the `text` or `sticky` being edited
 * @param {object} props.view      the current view transform
 * @param {string} props.theme     'light' | 'dark'
 * @param {(id:string, text:string) => void} props.onCommit
 * @param {(id:string) => void} props.onCancel
 * @param {() => void} [props.onBlurDone]
 */
export function TextEditor({ element, view, theme = 'light', onCommit, onCancel, onBlurDone }) {
  const isSticky = element.type === 'sticky';
  const initial = isSticky ? element.label || '' : element.text || '';
  const [value, setValue] = useState(initial);

  const taRef = useRef(null);
  const caretRef = useRef({ start: 0, end: 0 });
  // Tracks whether focus was already inside, so a re-render does not re-focus
  // (which would jump the caret to the end on every remote update).
  const hasFocusRef = useRef(false);
  const committedRef = useRef(false);

  /* ---- The element changed identity (a different element is being edited).
   * Reset the buffer. Depend on the id, NOT the object: the object is replaced
   * on every store write, including our own. */
  useEffect(() => {
    setValue(isSticky ? element.label || '' : element.text || '');
    committedRef.current = false;
    hasFocusRef.current = false;
  }, [element.id, isSticky]);

  /* ---- Commit exactly once, whichever way the editor closes. */
  const finish = useCallback(
    (text, cancelled) => {
      if (committedRef.current) return;
      committedRef.current = true;
      const limit = isSticky ? MAX_LABEL : MAX_TEXT;
      const clipped = text.length > limit ? text.slice(0, limit) : text;
      if (cancelled) {
        onCancel?.(element.id);
      } else if (clipped !== initial) {
        onCommit?.(element.id, clipped);
      }
      onBlurDone?.();
    },
    [committedRef, element.id, initial, isSticky, onBlurDone, onCancel, onCommit],
  );

  const commit = useCallback(() => finish(valueRef.current, false), [finish]);
  const cancel = useCallback(() => finish(originalRef.current, true), [finish]);

  // Refs so the keydown handler (which React re-creates on every keystroke via
  // its closure over `value`) always sees the current buffer and the ORIGINAL
  // text, with no re-subscription.
  const valueRef = useRef(value);
  valueRef.current = value;
  const originalRef = useRef(initial);
  originalRef.current = initial;

  /* ---- Auto-size. The textarea grows with the content so you never edit
   * inside a 3-line window. Runs in a layout effect so there is no visible
   * jump between the paint and the resize. */
  const resize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.width = '100%';
    ta.style.height = 'auto';
    const next = ta.scrollHeight;
    ta.style.height = `${next}px`;
  }, []);

  useLayoutEffect(() => {
    if (!taRef.current) return;
    taRef.current.focus({ preventScroll: true });
    const len = valueRef.current.length;
    const pos = Math.min(caretRef.current.end, len);
    const el = taRef.current;
    el.setSelectionRange(pos, pos);
    hasFocusRef.current = true;
    resize();
  }, [element.id, resize]);

  useEffect(() => {
    resize();
  }, [value, resize]);

  /* ---- Save the caret on every change, restore it after a re-render. A peer
   * moving the element re-renders us; without this the caret jumps to the end
   * mid-word. */
  const rememberCaret = useCallback(() => {
    const ta = taRef.current;
    if (ta) caretRef.current = { start: ta.selectionStart, end: ta.selectionEnd };
  }, []);

  const handleKeyDown = useCallback(
    (e) => {
      // Never let a keystroke reach the canvas's global shortcuts.
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commit();
      }
    },
    [cancel, commit],
  );

  const handleBlur = useCallback(() => {
    if (!hasFocusRef.current) return;
    hasFocusRef.current = false;
    // A blur is a commit, not a cancel: losing focus to another part of the UI
    // should keep what you typed.
    commit();
  }, [commit]);

  /* ---- Position. The editor sits exactly over the element's box, in SCREEN
   * coordinates, and inherits the view's zoom so the text you are editing is
   * the size you see. */
  const geom = editorGeometry(element, view, isSticky);
  const topLeft = boardToScreen({ x: geom.x, y: geom.y }, view);
  const screenW = Math.max(40, geom.w * (view.zoom || 1));
  const screenH = Math.max(28, geom.h * (view.zoom || 1));

  const fontSize = isSticky
    ? Math.max(9, Math.min(18, (geom.h / Math.max(2, String(value).split('\n').length)) * 0.8))
    : element.fontSize || DEFAULT_FONT_SIZE;

  const style = {
    position: 'absolute',
    left: `${topLeft.x}px`,
    top: `${topLeft.y}px`,
    width: `${screenW}px`,
    minHeight: `${screenH}px`,
    font: `400 ${fontSize * (view.zoom || 1)}px/1.25 ${FONT_STACK}`,
    color: isSticky
      ? theme === 'dark'
        ? '#e7e9ee'
        : readableFor(element.fill || '#fde68a')
      : element.stroke || (theme === 'dark' ? '#e7e9ee' : '#1f2937'),
    background: isSticky ? 'transparent' : theme === 'dark' ? 'rgba(21,23,28,0.92)' : 'rgba(255,255,255,0.94)',
    border: isSticky ? 'none' : '1px solid var(--color-border-strong, #b9bfca)',
    borderRadius: isSticky ? '6px' : '4px',
    padding: isSticky ? '4px' : '2px 4px',
    textAlign: isSticky ? 'center' : element.align || 'left',
    resize: 'none',
    outline: isSticky ? '2px solid var(--canvas-selection, #2f6df6)' : '2px solid var(--color-accent, #2f6df6)',
    boxSizing: 'border-box',
    overflow: 'hidden',
    zIndex: 40,
    // The whole point: the canvas must not see this.
    touchAction: 'none',
    WebkitUserSelect: 'text',
    userSelect: 'text',
  };

  return (
    <textarea
      ref={taRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onSelect={rememberCaret}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      spellCheck={false}
      aria-label={isSticky ? 'Sticky note text' : 'Text'}
      placeholder={isSticky ? 'Type a note…' : 'Type…'}
      style={style}
    />
  );
}

/**
 * The box the editor occupies. A `text` element's box may be shorter than its
 * content (the renderer lets it overflow), so a minimum is enforced here to
 * give the caret somewhere to go.
 */
function editorGeometry(el, view, isSticky) {
  const def = isSticky ? STICKY_DEFAULT_SIZE : TEXT_DEFAULT_SIZE;
  const minH = isSticky ? 60 : el.fontSize ? el.fontSize * LINE_HEIGHT * 2 : TEXT_DEFAULT_SIZE.h;
  let w = el.w || def.w;
  let h = el.h || def.h;
  if (!isSticky) {
    // Grow the box to fit what is being typed, without moving its top-left,
    // so the text never jumps under the caret.
    const lines = Math.max(1, String(el.text || '').split('\n').length);
    h = Math.max(h, (el.fontSize || DEFAULT_FONT_SIZE) * LINE_HEIGHT * lines);
  }
  h = Math.max(h, minH);
  w = Math.max(w, 40);
  void view;
  return { x: el.x, y: el.y, w, h };
}

/** Black or white, whichever reads on `bg`. Mirrors `readableTextOn`. */
function readableFor(bg) {
  const s = String(bg || '').trim();
  let r = 128;
  let g = 128;
  let b = 128;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const full = hex.length === 3 || hex.length === 4 ? [...hex].map((c) => c + c).join('') : hex;
    r = parseInt(full.slice(0, 2), 16) || 0;
    g = parseInt(full.slice(2, 4), 16) || 0;
    b = parseInt(full.slice(4, 6), 16) || 0;
  } else {
    const m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      r = p[0] || 0;
      g = p[1] || 0;
      b = p[2] || 0;
    }
  }
  const f = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  return lum > 0.45 ? '#111827' : '#ffffff';
}

/**
 * A component that renders nothing. The canvas renders remote cursors as DOM
 * (crisper text, no canvas redraw), so this is the label body for one peer.
 *
 * @param {object} props `{x, y, name, color, zoom, panX, panY}`
 */
export function CursorLabel({ x, y, name, color, view }) {
  const p = boardToScreen({ x, y }, view);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transform: `translate(${p.x + 16}px, ${p.y + 18}px)`,
        background: color,
        color: '#fff',
        font: "600 12px/1.4 " + FONT_STACK,
        padding: '3px 7px',
        borderRadius: 6,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
        zIndex: 30,
      }}
    >
      {name}
    </div>
  );
}

/**
 * The pointer triangle for one remote peer, as a DOM element. The canvas
 * renderer also draws cursors; the DOM version is used when `remoteCursorsAsDom`
 * is on, because a text label on a scaled canvas transform renders blurry at
 * high DPR.
 */
export function CursorPointer({ x, y, color, view }) {
  const p = boardToScreen({ x, y }, view);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transform: `translate(${p.x}px, ${p.y}px)`,
        width: 0,
        height: 0,
        borderLeft: '10px solid transparent',
        borderRight: '10px solid transparent',
        borderTop: '18px solid ' + color,
        filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.6))',
        pointerEvents: 'none',
        zIndex: 31,
      }}
    />
  );
}

export { textHeight, zoomAt, STICKY_DEFAULT_FONT };


/* ------------------------------------------------------------------ *
 * The in-node editor
 * ------------------------------------------------------------------ */

/**
 * `TextEditor` for a React Flow node.
 *
 * The screen-positioned original took a `view` and computed where to place
 * itself from the element's board coordinates. A node is already positioned by
 * React Flow's own transform, so all this needs is to fill the node's box —
 * which is why the two share every behaviour that matters: caret preservation
 * across remote updates, stopped propagation so a keystroke never reaches the
 * pane as a drag, and discarding the buffer if a peer deletes the element
 * mid-edit.
 */
export function NodeTextEditor({ element, onCommit, onCancel, onBlurDone }) {
  const isSticky = element.type === 'sticky';
  const [value, setValue] = useState(isSticky ? element.label || '' : element.text || '');
  const taRef = useRef(null);
  const caretRef = useRef({ start: 0, end: 0 });
  const committedRef = useRef(false);

  // Depend on the id, NOT the object: the object is replaced on every store
  // write, including our own, and resetting on identity would discard the
  // buffer on every keystroke.
  useEffect(() => {
    setValue(isSticky ? element.label || '' : element.text || '');
  }, [element.id, isSticky]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    const { start, end } = caretRef.current;
    try {
      ta.setSelectionRange(start, end);
    } catch {
      // setSelectionRange throws on some mobile keyboards mid-composition; the
      // focus is what matters, the caret follows the tap.
    }
  }, []);

  const commit = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit?.(element.id, value);
  }, [element.id, value, onCommit]);

  const cancel = useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel?.(element.id);
  }, [element.id, onCancel]);

  return (
    <textarea
      ref={taRef}
      className="wb-node-editor nodrag nopan"
      value={value}
      maxLength={isSticky ? MAX_LABEL : MAX_TEXT}
      placeholder={isSticky ? 'Note\u2026' : 'Type\u2026'}
      style={{
        width: '100%',
        height: '100%',
        margin: 0,
        padding: isSticky ? 'var(--sp-3)' : 0,
        border: 'none',
        outline: 'none',
        resize: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'inherit',
        // Stop every event from reaching React Flow: without this, typing
        // selects nodes and moving the caret drags the node.
        onPointerDown: (e) => e.stopPropagation(),
        onPointerMove: (e) => e.stopPropagation(),
        onPointerUp: (e) => e.stopPropagation(),
        onMouseDown: (e) => e.stopPropagation(),
        onMouseUp: (e) => e.stopPropagation(),
        onWheel: (e) => e.stopPropagation(),
        onKeyDown: (e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          }
        },
        onKeyUp: (e) => {
          e.stopPropagation();
          const ta = e.currentTarget;
          caretRef.current = { start: ta.selectionStart ?? 0, end: ta.selectionEnd ?? 0 };
        },
        onClick: (e) => e.stopPropagation(),
        onDoubleClick: (e) => e.stopPropagation(),
        onBlur: () => {
          if (!committedRef.current) {
            committedRef.current = true;
            onBlurDone?.(element.id, value);
          }
        },
        onChange: (e) => {
          setValue(e.target.value);
          const ta = e.target;
          caretRef.current = { start: ta.selectionStart ?? 0, end: ta.selectionEnd ?? 0 };
        },
      }}
    />
  );
}
