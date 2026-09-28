/**
 * Canvas.jsx — the drawing surface: two stacked canvases, every pointer
 * gesture, and the in-place text editor.
 *
 *  - static canvas: background, grid and every element (renderStatic);
 *  - interactive canvas on top: selection, handles, marquee, bind highlight,
 *    eraser trail, remote cursors (renderInteractive). It also receives all
 *    pointer input.
 *
 * Nothing here re-renders React per pointer move. Input goes through the pure
 * reducer in interaction.js (state kept in a ref), its effects are applied to
 * the zustand store in order, and a single requestAnimationFrame loop — woken
 * by `useBoardStore.subscribe` and by the reducer — repaints whatever layer's
 * inputs changed (compared by identity, so a hover repaints only the cheap
 * interactive layer). React renders only when a text edit starts or ends.
 *
 * Both canvases are sized in DEVICE px (CSS size × devicePixelRatio, clamped
 * to 1..3); a ResizeObserver keeps them in step and reports the CSS size to
 * `store.setViewportSize` (zoom-to-fit and the action buttons use it). Dark
 * mode is Excalidraw's trick: the renderer always paints light colours and
 * this component puts DARK_MODE_FILTER on both canvases (and the textarea).
 *
 * Keyboard handled here is only what belongs to a gesture: Space (hold to
 * pan), Escape/Enter (finish a multi-point connector), Shift/Alt (re-evaluate
 * a drag), and arrow keys are swallowed WHILE a drag is active. Everything
 * else is the global shortcut handler's (ui/shortcuts.js).
 *
 * Also here: the collaborator cursor broadcast (realtime.sendCursor in board
 * units), touch pinch-zoom, and image files dropped on or pasted into the
 * board (editor/image.js).
 */

import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { LIMITS, tryValidateElement } from '@whiteboard/shared';
import { useBoardStore } from '../store/index.js';
import { realtime } from '../realtime/realtime.js';
import { DARK_MODE_FILTER } from './constants.js';
import { reduce, initialInteraction } from './interaction.js';
import { renderStatic, renderInteractive } from './render/renderScene.js';
import { loadFonts, onFontsLoaded } from './fonts.js';
import { fitTextElement, labelKeyOf } from './text.js';
import { applyPatches, resolveBindingPatches } from './scene.js';
import { insertImageFiles, isImageFile, openImagePicker } from './image.js';
import TextEditor from './TextEditor.jsx';

const clampDpr = (d) => Math.min(3, Math.max(1, Number.isFinite(d) && d > 0 ? d : 1));

/** Keys the Canvas forwards to the reducer (all others belong to the global shortcuts). */
const GESTURE_KEYS = new Set(['Escape', 'Enter', 'Shift', 'Alt', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Is `el` a field the user is typing into (keys and pastes are theirs)? */
function isTypingTarget(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file', 'image'].includes(type);
  }
  return false;
}

function sameInputs(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const LAYER_STYLE = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', display: 'block' };

/**
 * @param {object} props
 * @param {'light'|'dark'} [props.theme]
 * @param {(info: {x:number, y:number, clientX:number, clientY:number, targetId:string|null}) => void} [props.onContextMenu]
 *   right click on the board; x/y are canvas-relative CSS px, clientX/Y viewport px
 * @param {(at: {x:number, y:number}) => void} [props.onRequestImage]
 *   the image tool was clicked at a BOARD point; without it the Canvas opens
 *   the file picker itself and inserts the image there
 */
export default function Canvas({ theme = 'light', onContextMenu, onRequestImage }) {
  const hostRef = useRef(null);
  const staticRef = useRef(null);
  const interRef = useRef(null);
  const editorRef = useRef(null);
  const itRef = useRef(initialInteraction());
  const spaceRef = useRef(false);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const lastRef = useRef({ s: null, i: null, dirty: true });
  const scheduleRef = useRef(() => {});
  const lastPointerRef = useRef(null); // canvas-relative CSS px of the last pointer
  const propsRef = useRef({ onContextMenu, onRequestImage });
  propsRef.current = { onContextMenu, onRequestImage };
  const [newText, setNewText] = useState(null);

  /* ------------------------------------------------------------ helpers */

  const localPoint = useCallback((e) => {
    const r = interRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const toBoardPoint = useCallback((pt) => {
    const v = useBoardStore.getState().view;
    return { x: (pt.x - v.panX) / (v.zoom || 1), y: (pt.y - v.panY) / (v.zoom || 1) };
  }, []);

  const applyEffects = useCallback((effects) => {
    for (const fx of effects) {
      const s = useBoardStore.getState();
      switch (fx.type) {
        case 'commit':
          s.commit(fx.label);
          break;
        case 'addElements':
          s.addElements(fx.elements);
          break;
        case 'updateElements':
          s.updateElements(fx.patches);
          break;
        case 'removeElements':
          s.removeElements(fx.ids);
          break;
        case 'select':
          s.select(fx.ids);
          break;
        case 'setTool':
          s.setTool(fx.tool);
          break;
        case 'panBy':
          s.panBy(fx.dx, fx.dy);
          break;
        case 'zoomAt':
          s.zoomAtScreen({ x: fx.x, y: fx.y }, fx.factor);
          break;
        case 'setHovered':
          s.setHovered(fx.id);
          break;
        case 'startTextEdit':
          if (fx.element) {
            s.setEditing(null);
            if (s.selection.size) s.select([]);
            setNewText(fx.element);
          } else {
            setNewText(null);
            s.select([fx.id]);
            s.setEditing(fx.id);
          }
          break;
        case 'contextMenu': {
          const o = interRef.current ? interRef.current.getBoundingClientRect() : { left: 0, top: 0 };
          propsRef.current.onContextMenu?.({ x: fx.x, y: fx.y, clientX: fx.x + o.left, clientY: fx.y + o.top, targetId: fx.targetId });
          break;
        }
        case 'requestImage': {
          const at = { x: fx.x, y: fx.y };
          if (propsRef.current.onRequestImage) propsRef.current.onRequestImage(at);
          else {
            openImagePicker()
              .then((file) => (file ? insertImageFiles([file], at) : null))
              .catch((err) => console.warn('[canvas] image insert failed', err));
          }
          break;
        }
        default:
          break;
      }
    }
  }, []);

  /** Run one event through the reducer and apply its effects. Returns `handled`. */
  const dispatch = useCallback(
    (ev) => {
      const s = useBoardStore.getState();
      const ctx = {
        elements: s.elements,
        selection: s.selection,
        tool: s.tool,
        toolLocked: s.toolLocked,
        style: s.style,
        view: s.view,
        gridSize: s.gridSize,
        snapEnabled: s.snapEnabled,
        editingId: s.editingId,
        now: Date.now(),
        spaceDown: spaceRef.current,
      };
      let r;
      try {
        r = reduce(itRef.current, ev, ctx);
      } catch (err) {
        // A bug in one gesture must not wedge the editor: log, reset, carry on.
        console.error('[canvas] interaction failed', err);
        itRef.current = initialInteraction();
        scheduleRef.current();
        return false;
      }
      itRef.current = r.state;
      const canvas = interRef.current;
      applyEffects(r.effects);
      if (canvas && canvas.style.cursor !== r.state.cursor) canvas.style.cursor = r.state.cursor;
      scheduleRef.current();
      return r.handled;
    },
    [applyEffects],
  );

  /* ---------------------------------------------------- render loop + size */

  useEffect(() => {
    const sc = staticRef.current;
    const ic = interRef.current;
    const sctx = sc.getContext('2d');
    const ictx = ic.getContext('2d');
    let raf = 0;
    let alive = true;

    const resize = (w, h) => {
      const dpr = clampDpr(window.devicePixelRatio);
      sizeRef.current = { w, h, dpr };
      for (const c of [sc, ic]) {
        c.width = Math.max(1, Math.round(w * dpr));
        c.height = Math.max(1, Math.round(h * dpr));
      }
      lastRef.current = { s: null, i: null, dirty: true };
      useBoardStore.getState().setViewportSize({ w, h });
      schedule();
    };

    const onImageLoad = () => {
      lastRef.current.dirty = true;
      schedule();
    };

    const frame = () => {
      raf = 0;
      if (!alive) return;
      const { w, h } = sizeRef.current;
      if (clampDpr(window.devicePixelRatio) !== sizeRef.current.dpr && w && h) {
        resize(w, h); // moved to another monitor / browser zoom changed
        return;
      }
      if (!w || !h) return;
      const dpr = sizeRef.current.dpr;
      const s = useBoardStore.getState();
      const it = itRef.current;
      const last = lastRef.current;
      const sIn = [s.elements, s.view, w, h, dpr, s.snapEnabled, s.gridSize, s.editingId, it.erasingIds, it.draft];
      if (last.dirty || !sameInputs(sIn, last.s)) {
        last.dirty = false;
        last.s = sIn;
        try {
          renderStatic(sctx, {
            elements: s.elements,
            view: s.view,
            width: w,
            height: h,
            dpr,
            showGrid: s.snapEnabled,
            gridSize: s.gridSize,
            editingId: s.editingId,
            erasingIds: it.erasingIds,
            draft: it.draft,
            onImageLoad,
          });
        } catch (err) {
          console.error('[canvas] renderStatic failed', err);
        }
      }
      const iIn = [s.elements, s.selection, s.view, w, h, dpr, it, s.remoteCursors, s.myPeerId, s.hoveredId, s.editingId];
      if (!sameInputs(iIn, last.i)) {
        last.i = iIn;
        try {
          renderInteractive(ictx, {
            elements: s.elements,
            selection: s.selection,
            view: s.view,
            width: w,
            height: h,
            dpr,
            interaction: it,
            remoteCursors: s.remoteCursors,
            myPeerId: s.myPeerId,
            hoveredId: s.hoveredId,
            editingId: s.editingId,
          });
        } catch (err) {
          console.error('[canvas] renderInteractive failed', err);
        }
      }
    };

    function schedule() {
      if (!raf && alive) raf = requestAnimationFrame(frame);
    }
    scheduleRef.current = schedule;

    // Tool and selection changes from outside (toolbar, shortcuts) must reach
    // the reducer: a tool switch finishes/drops a gesture in progress, and
    // the connector point-edit state follows the selection.
    let prevTool = useBoardStore.getState().tool;
    let prevSel = useBoardStore.getState().selection;
    const unsub = useBoardStore.subscribe((st) => {
      if (st.tool !== prevTool) {
        prevTool = st.tool;
        queueMicrotask(() => alive && dispatch({ type: 'toolchange' }));
      } else if (st.selection !== prevSel) {
        prevSel = st.selection;
        queueMicrotask(() => alive && dispatch({ type: 'sync' }));
      }
      schedule();
    });

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) resize(Math.round(r.width), Math.round(r.height));
    });
    ro.observe(hostRef.current);
    const r0 = hostRef.current.getBoundingClientRect();
    resize(Math.round(r0.width), Math.round(r0.height));

    loadFonts();
    const unfont = onFontsLoaded(() => {
      lastRef.current = { s: null, i: null, dirty: true };
      schedule();
    });

    return () => {
      alive = false;
      unsub();
      unfont();
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      scheduleRef.current = () => {};
    };
  }, [dispatch]);

  /* -------------------------------------------------------------- input */

  useEffect(() => {
    const canvas = interRef.current;
    const touches = new Map();
    let pinch = null; // {mid, dist}
    let touchLock = false; // a pinch happened: ignore touch input until all fingers lift

    const norm = (type, e) => {
      const pt = localPoint(e);
      return {
        type,
        x: pt.x,
        y: pt.y,
        button: e.button,
        buttons: e.buttons,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        mod: e.ctrlKey || e.metaKey,
        pointerType: e.pointerType,
        pointerId: e.pointerId,
        pressure: e.pressure,
      };
    };

    const pinchStep = () => {
      const [a, b] = [...touches.values()];
      if (!a || !b) return;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      if (pinch) {
        const s = useBoardStore.getState();
        s.panBy(mid.x - pinch.mid.x, mid.y - pinch.mid.y);
        const f = dist / pinch.dist;
        if (Math.abs(f - 1) > 1e-3) s.zoomAtScreen(mid, f);
      }
      pinch = { mid, dist };
    };

    const onPointerDown = (e) => {
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, localPoint(e));
        if (touches.size >= 2) {
          if (!touchLock) dispatch({ type: 'pointercancel', x: 0, y: 0, pointerId: e.pointerId });
          touchLock = true;
          pinch = null;
          pinchStep();
          return;
        }
        if (touchLock) return;
      }
      // Clicking the board ends an open text edit first; the click then does
      // what it normally would (select, marquee, draw…).
      editorRef.current?.commit();
      const active = document.activeElement;
      if (active && active !== document.body && isTypingTarget(active)) active.blur();
      if (e.button === 1) e.preventDefault(); // no middle-click autoscroll
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
      dispatch(norm('pointerdown', e));
    };

    const onPointerMove = (e) => {
      if (e.pointerType === 'touch') {
        if (touches.has(e.pointerId)) touches.set(e.pointerId, localPoint(e));
        if (touchLock) {
          if (touches.size >= 2) pinchStep();
          return;
        }
      }
      const it = itRef.current;
      if (it.mode === 'freedraw' && typeof e.getCoalescedEvents === 'function') {
        const list = e.getCoalescedEvents();
        if (list.length > 1) for (const ce of list) dispatch(norm('pointermove', ce));
        else dispatch(norm('pointermove', e));
      } else {
        dispatch(norm('pointermove', e));
      }
      const pt = localPoint(e);
      lastPointerRef.current = pt;
      realtime.sendCursor(toBoardPoint(pt));
    };

    const onPointerUp = (e) => {
      if (e.pointerType === 'touch') {
        touches.delete(e.pointerId);
        if (touchLock) {
          if (touches.size < 2) pinch = null;
          if (touches.size === 0) touchLock = false;
          return;
        }
      }
      dispatch(norm('pointerup', e));
      try {
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    const onPointerCancel = (e) => {
      if (e.pointerType === 'touch') {
        touches.delete(e.pointerId);
        if (touches.size === 0) touchLock = false;
        if (touches.size < 2) pinch = null;
      }
      dispatch({ ...norm('pointercancel', e) });
    };

    // Capture stolen mid-gesture (not the normal release after pointerup).
    const onLostCapture = (e) => {
      const g = itRef.current.g;
      if (g && g.held && g.pointerId === e.pointerId) dispatch({ ...norm('pointercancel', e) });
    };

    const onDoubleClick = (e) => {
      const pt = localPoint(e);
      if (dispatch({ type: 'dblclick', x: pt.x, y: pt.y, button: 0, shiftKey: e.shiftKey, altKey: e.altKey, mod: e.ctrlKey || e.metaKey })) {
        e.preventDefault();
      }
    };

    // Right click, Ctrl+click on macOS, touch long-press, the menu key.
    const onContextMenuNative = (e) => {
      e.preventDefault();
      const pt = localPoint(e);
      dispatch({ type: 'contextmenu', x: pt.x, y: pt.y, button: 2, shiftKey: e.shiftKey, altKey: e.altKey, mod: e.ctrlKey || e.metaKey });
    };

    const onWheel = (e) => {
      if (e.target !== canvas) return;
      e.preventDefault();
      const pt = localPoint(e);
      dispatch({ type: 'wheel', x: pt.x, y: pt.y, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, mod: e.ctrlKey || e.metaKey, shiftKey: e.shiftKey });
    };

    // Safari trackpad pinch arrives as non-standard gesture events.
    let gestureScale = 1;
    const onGestureStart = (e) => {
      e.preventDefault();
      gestureScale = e.scale || 1;
    };
    const onGestureChange = (e) => {
      e.preventDefault();
      const scale = e.scale || 1;
      const pt = lastPointerRef.current ?? { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 };
      useBoardStore.getState().zoomAtScreen(pt, scale / gestureScale);
      gestureScale = scale;
    };

    const onKeyDown = (e) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === ' ' || e.code === 'Space') {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        if (!spaceRef.current) {
          spaceRef.current = true;
          dispatch({ type: 'keydown', key: ' ' });
        }
        return;
      }
      if (!GESTURE_KEYS.has(e.key)) return;
      const handled = dispatch({ type: 'keydown', key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, mod: e.ctrlKey || e.metaKey });
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onKeyUp = (e) => {
      if (e.key === ' ' || e.code === 'Space') {
        if (spaceRef.current) {
          spaceRef.current = false;
          dispatch({ type: 'keyup', key: ' ' });
        }
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (e.key === 'Shift' || e.key === 'Alt') {
        if (dispatch({ type: 'keyup', key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, mod: e.ctrlKey || e.metaKey })) e.preventDefault();
      }
    };

    const onBlur = () => {
      spaceRef.current = false;
      dispatch({ type: 'blur' });
    };

    const onPaste = (e) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])].filter(isImageFile);
      if (files.length === 0) return;
      const text = e.clipboardData.getData?.('text/plain') ?? '';
      if (text.includes('whiteboard/clipboard')) return; // our own elements: the global paste handles them
      e.preventDefault();
      e.stopPropagation();
      const pt = lastPointerRef.current ?? { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 };
      insertImageFiles(files, toBoardPoint(pt)).catch((err) => console.warn('[canvas] image paste failed', err));
    };

    const onPointerLeave = (e) => {
      if (e.pointerType !== 'touch') dispatch({ ...norm('pointerleave', e) });
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('lostpointercapture', onLostCapture);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('contextmenu', onContextMenuNative);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('gesturestart', onGestureStart);
    canvas.addEventListener('gesturechange', onGestureChange);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('paste', onPaste, true);
    canvas.style.cursor = itRef.current.cursor;
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('lostpointercapture', onLostCapture);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('contextmenu', onContextMenuNative);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('gesturestart', onGestureStart);
      canvas.removeEventListener('gesturechange', onGestureChange);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('paste', onPaste, true);
    };
  }, [dispatch, localPoint, toBoardPoint]);

  /* -------------------------------------------------------- drop images */

  const onDragOver = (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (e) => {
    const files = [...(e.dataTransfer?.files ?? [])].filter(isImageFile);
    if (files.length === 0) return;
    e.preventDefault();
    const pt = localPoint(e);
    insertImageFiles(files, toBoardPoint(pt)).catch((err) => console.warn('[canvas] image drop failed', err));
  };

  /* ---------------------------------------------------------- text edit */

  const finishNewText = useCallback((el, text) => {
    setNewText(null);
    const s = useBoardStore.getState();
    const value = String(text ?? '').slice(0, LIMITS.MAX_TEXT);
    if (value.trim() !== '') {
      const next = { ...el, text: value, updatedAt: Date.now() };
      const res = tryValidateElement({ ...next, ...fitTextElement(next) });
      if (res.valid) {
        s.commit(`text:${el.id}`);
        s.addElements([res.element]);
        s.select([el.id]);
      } else {
        console.warn('[canvas] text rejected', res.error);
      }
    }
    const after = useBoardStore.getState();
    if (after.tool === 'text' && !after.toolLocked) after.setTool('select');
  }, []);

  const finishExisting = useCallback((id, text) => {
    const s = useBoardStore.getState();
    const el = s.elements.find((e) => e.id === id);
    if (s.editingId === id) s.setEditing(null);
    // Editing started from the text tool returns to select, like a new text.
    if (s.tool === 'text' && !s.toolLocked) s.setTool('select');
    if (!el) return;
    const label = `text:${id}:${Date.now()}`;
    if (el.type === 'text') {
      const value = String(text ?? '').slice(0, LIMITS.MAX_TEXT);
      if (value.trim() === '') {
        s.commit(label);
        s.removeElements([id]);
        return;
      }
      if (value === el.text) return;
      const patches = [{ id, patch: { text: value, ...fitTextElement({ ...el, text: value }), updatedAt: Date.now() } }];
      const next = applyPatches(s.elements, patches);
      s.commit(label);
      s.updateElements([...patches, ...resolveBindingPatches(next, [id])]);
      return;
    }
    if (labelKeyOf(el)) {
      const value = String(text ?? '').slice(0, LIMITS.MAX_LABEL);
      if (value === (el.label ?? '')) return;
      const patch = el.type === 'sticky' ? { label: value } : { label: value.trim() === '' ? null : value };
      s.commit(label);
      s.updateElements([{ id, patch: { ...patch, updatedAt: Date.now() } }]);
    }
  }, []);

  const cancelEdit = useCallback(() => {
    setNewText(null);
    const s = useBoardStore.getState();
    if (s.editingId) s.setEditing(null);
  }, []);

  const layer = { ...LAYER_STYLE, filter: theme === 'dark' ? DARK_MODE_FILTER : undefined };

  return (
    <div
      ref={hostRef}
      className="wb-canvas"
      data-testid="canvas"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <canvas ref={staticRef} style={layer} aria-hidden="true" />
      <canvas ref={interRef} style={{ ...layer, touchAction: 'none' }} data-testid="canvas-interactive" role="img" aria-label="Área de desenho" />
      <EditorHost
        ref={editorRef}
        newText={newText}
        theme={theme}
        onFinishNew={finishNewText}
        onFinishExisting={finishExisting}
        onCancel={cancelEdit}
      />
    </div>
  );
}

/**
 * Renders the TextEditor for the element being edited (store.editingId) or
 * the new text draft. Its own component so only IT re-renders on view changes
 * while an edit is open — the Canvas itself never does.
 */
const EditorHost = forwardRef(function EditorHost({ newText, theme, onFinishNew, onFinishExisting, onCancel }, ref) {
  const editing = useBoardStore((s) => (s.editingId ? s.elements.find((e) => e.id === s.editingId) ?? null : null));
  const active = newText ?? editing;
  const view = useBoardStore((s) => (active ? s.view : null));
  if (!active || !view) return null;
  const isNew = Boolean(newText);
  return (
    <TextEditor
      ref={ref}
      key={active.id}
      element={active}
      isNew={isNew}
      view={view}
      theme={theme}
      onCommit={(text) => (isNew ? onFinishNew(active, text) : onFinishExisting(active.id, text))}
      onCancel={onCancel}
    />
  );
});
