/**
 * TextEditor.jsx — the in-place <textarea> for free text and shape labels.
 *
 * Why a real textarea: caret movement, IME composition, native undo inside
 * the field, mobile keyboards and screen readers all work for free.
 *
 * The textarea is positioned and styled from the SAME layout the renderer
 * paints with (editor/text.js: fitTextElement for free text, labelBox +
 * wrapText for labels) — same font string, size × zoom, unitless
 * LINE_HEIGHT, alignment, rotation about the element centre, text colour and
 * the dark-mode filter — so the words do not jump when editing starts or ends.
 * The renderer skips painting the edited element's text (`editingId`).
 *
 * Keys (Excalidraw): Enter inserts a newline; Escape, Ctrl/⌘+Enter or
 * leaving the field all COMMIT. Every key is stopped here so the global
 * shortcuts (Delete, tool letters…) never fire while typing.
 *
 * The parent can force a commit through the ref (`ref.current.commit()`):
 * Canvas does this when the user clicks the canvas, so that click both ends
 * the edit and does what it would normally do. Commit runs at most once.
 */

import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { LIMITS } from '@whiteboard/shared';
import { DARK_MODE_FILTER, FONT_SIZES, LINE_HEIGHT } from './constants.js';
import { fitTextElement, fontString, labelBox, lineHeightPx, textColorOf, textOf, wrapText } from './text.js';

/**
 * Screen geometry of the editor for `element` showing `value`.
 * @returns {{left:number, top:number, width:number, height:number, originX:number, originY:number,
 *   rotation:number, font:string, align:string, wrap:boolean}}
 */
export function editorGeometry(element, value, view) {
  const zoom = view?.zoom || 1;
  const panX = view?.panX || 0;
  const panY = view?.panY || 0;
  const fontFamily = element.fontFamily ?? 'hand';
  const fontSize = element.fontSize ?? FONT_SIZES.M;
  const lh = lineHeightPx(fontSize);
  let box;
  let align;
  let wrap;
  let centre;
  if (element.type === 'text') {
    const fit = fitTextElement({ ...element, text: value });
    align = element.align ?? 'left';
    wrap = false;
    // A little slack so the caret after the last glyph is never clipped; it
    // goes on the side the text grows toward, so the glyphs stay put.
    const slack = Math.max(4, fontSize * 0.5);
    const extraLeft = align === 'right' ? slack : align === 'center' ? slack / 2 : 0;
    box = { x: fit.x - extraLeft, y: fit.y, w: fit.w + slack, h: Math.max(fit.h, lh) };
    centre = { x: fit.x + fit.w / 2, y: fit.y + fit.h / 2 };
  } else {
    const lb = labelBox(element);
    const lines = wrapText(value || ' ', lb.w, fontFamily, fontSize);
    const total = Math.max(1, lines.length) * lh;
    const sticky = element.type === 'sticky';
    align = sticky ? element.align ?? 'left' : element.align ?? 'center';
    wrap = true;
    const top = sticky ? lb.y : element.y + (element.h - total) / 2;
    box = { x: lb.x, y: top, w: lb.w, h: sticky ? Math.max(total, lb.h) : total };
    centre = { x: element.x + element.w / 2, y: element.y + element.h / 2 };
  }
  return {
    left: box.x * zoom + panX,
    top: box.y * zoom + panY,
    width: Math.max(1, box.w * zoom),
    height: Math.max(1, box.h * zoom),
    originX: (centre.x - box.x) * zoom,
    originY: (centre.y - box.y) * zoom,
    rotation: element.rotation || 0,
    font: fontString(fontFamily, fontSize * zoom),
    align,
    wrap,
  };
}

/**
 * @param {object} props
 * @param {object} props.element   the text/container being edited (a NEW text is not in the store)
 * @param {boolean} [props.isNew]
 * @param {{zoom,panX,panY}} props.view
 * @param {'light'|'dark'} [props.theme]
 * @param {(text: string) => void} props.onCommit
 * @param {() => void} [props.onCancel]
 */
function TextEditor({ element, isNew = false, view, theme = 'light', onCommit, onCancel }, ref) {
  const [value, setValue] = useState(() => textOf(element));
  const taRef = useRef(null);
  const doneRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const cbRef = useRef({ onCommit, onCancel });
  cbRef.current = { onCommit, onCancel };

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    cbRef.current.onCommit?.(valueRef.current);
  }, []);

  useImperativeHandle(ref, () => ({ commit: finish, cancel: () => {
    if (doneRef.current) return;
    doneRef.current = true;
    cbRef.current.onCancel?.();
  } }), [finish]);

  // Focus once per edited element, caret at the end (select-all would make
  // the first keystroke wipe the text, which surprises more than it helps).
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    const end = ta.value.length;
    try {
      ta.setSelectionRange(end, end);
    } catch {
      /* some input types refuse; a textarea never does */
    }
  }, [element.id]);

  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.nativeEvent?.isComposing) return;
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      finish();
      return;
    }
    if (e.key === 'Tab') {
      // Indent instead of leaving the field (Excalidraw does the same).
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: a, selectionEnd: b } = ta;
      const next = ta.value.slice(0, a) + '    ' + ta.value.slice(b);
      setValue(next);
      requestAnimationFrame(() => {
        try {
          ta.setSelectionRange(a + 4, a + 4);
        } catch {
          /* unmounted */
        }
      });
    }
  };

  const max = element.type === 'text' ? LIMITS.MAX_TEXT : LIMITS.MAX_LABEL;
  const g = editorGeometry(element, value, view);
  const style = {
    position: 'absolute',
    left: `${g.left}px`,
    top: `${g.top}px`,
    width: `${g.width}px`,
    height: `${g.height}px`,
    margin: 0,
    padding: 0,
    border: 0,
    outline: 'none',
    resize: 'none',
    overflow: 'hidden',
    background: 'transparent',
    font: g.font,
    lineHeight: LINE_HEIGHT,
    textAlign: g.align,
    whiteSpace: g.wrap ? 'pre-wrap' : 'pre',
    overflowWrap: g.wrap ? 'break-word' : 'normal',
    wordBreak: g.wrap ? 'break-word' : 'normal',
    color: textColorOf(element),
    caretColor: textColorOf(element),
    opacity: element.opacity ?? 1,
    transform: g.rotation ? `rotate(${g.rotation}rad)` : undefined,
    transformOrigin: `${g.originX}px ${g.originY}px`,
    filter: theme === 'dark' ? DARK_MODE_FILTER : undefined,
    zIndex: 2,
    boxSizing: 'content-box',
    // The canvas host disables selection; a text field must opt back in
    // (iOS Safari will not even type into it otherwise).
    userSelect: 'text',
    WebkitUserSelect: 'text',
    tabSize: 4,
  };

  return (
    <textarea
      ref={taRef}
      className="wb-text-editor"
      data-testid="text-editor"
      data-new={isNew ? 'true' : undefined}
      value={value}
      maxLength={max}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      wrap={g.wrap ? 'soft' : 'off'}
      style={style}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.stopPropagation()}
      onBlur={finish}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
      onCopy={(e) => e.stopPropagation()}
      onCut={(e) => e.stopPropagation()}
    />
  );
}

export default forwardRef(TextEditor);
