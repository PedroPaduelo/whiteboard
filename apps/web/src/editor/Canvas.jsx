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
 * pan — unless a dialog is open or a control has keyboard focus, where Space
 * activates it), Escape/Enter (finish a multi-point connector), Shift/Alt
 * (re-evaluate a drag), Delete/Backspace (remove the active point in
 * connector point editing), and arrow keys, Delete and undo/redo are
 * swallowed WHILE a drag is active. Everything else is the global shortcut
 * handler's (ui/shortcuts.js).
 *
 * Also here: the collaborator cursor broadcast (realtime.sendCursor in board
 * units), touch pinch-zoom and the touch long-press context menu, the guard
 * that keeps Ctrl/⌘+wheel and pinch from zooming the whole page, and files
 * dropped on or pasted into the board (images via editor/image.js; a saved
 * board file opens it).
 */

import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LIMITS, tryValidateElement } from '@whiteboard/shared';
import { useBoardStore } from '../store/index.js';
import { realtime } from '../realtime/realtime.js';
import { DARK_MODE_FILTER } from './constants.js';
import { reduce, initialInteraction } from './interaction.js';
import { renderStatic, renderInteractive } from './render/renderScene.js';
import { loadFonts, onFontsLoaded } from './fonts.js';
import { fitTextElement, labelKeyOf } from './text.js';
import { styleKeysFor } from './elements.js';
import { applyPatches, growContainerForLabel, resolveBindingPatches } from './scene.js';
import { insertImageFiles, isImageFile, openImagePicker } from './image.js';
import { actions } from './actions.js';
import { isControlTarget } from '../ui/shortcuts.js';
import { useUi } from '../ui/uiStore.js';
import { toast } from '../ui/toast.js';
import { t } from '../ui/strings.js';
import TextEditor from './TextEditor.jsx';

const clampDpr = (d) => Math.min(3, Math.max(1, Number.isFinite(d) && d > 0 ? d : 1));

/** Keys the Canvas forwards to the reducer (all others belong to the global shortcuts). */
const GESTURE_KEYS = new Set(['Escape', 'Enter', 'Shift', 'Alt', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace']);

/** Mod+Z / Mod+Shift+Z / Mod+Y, by physical key too (any keyboard layout); null when not one. */
function undoRedoKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.code === 'KeyZ' || e.code === 'KeyY') return e.code === 'KeyZ' ? 'z' : 'y';
  const k = String(e.key || '').toLowerCase();
  return k === 'z' || k === 'y' ? k : null;
}

/** Excalidraw's TOUCH_CTX_MENU_TIMEOUT: a finger held this long (ms) opens the context menu. */
const LONG_PRESS_MS = 500;
/** How far (CSS px) a held finger may wander and still count as a long-press. */
const LONG_PRESS_SLOP = 10;
/** Tools where a long-press opens the menu (elsewhere a held finger is drawing). */
const LONG_PRESS_TOOLS = new Set(['select', 'hand']);

/**
 * The canvas host clips its overflow — the text editor grows past the board
 * edge while typing near it. `hidden` would still let the browser SCROLL the
 * host to keep the caret visible, shifting both canvases under the pointer;
 * `clip` makes it no scroll container at all. (Browsers without `clip` get
 * `hidden` plus the scroll reset in the render effect.)
 */
const HOST_OVERFLOW = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('overflow', 'clip') ? 'clip' : 'hidden';

/** Is this dropped file a saved board (what "Salvar em arquivo" writes)? */
function isBoardFile(file) {
  if (!file) return false;
  const name = String(file.name || '').toLowerCase();
  return name.endsWith('.json') || name.endsWith('.whiteboard') || file.type === 'application/json';
}

/** An image that could not be inserted (undecodable, too big): say so, like the image picker does. */
function reportImageFailure(err) {
  console.warn('[canvas] image insert failed', err);
  toast.error(t.toast.imageFailed);
}

/** Open a board file dropped on the board: replaces the board, confirming first when it is not empty. */
async function openDroppedBoardFile(file) {
  if (useBoardStore.getState().elements.length > 0) {
    const ok = await useUi.getState().askConfirm({
      title: t.confirm.openTitle,
      message: t.confirm.openMessage,
      confirmLabel: t.confirm.openConfirm,
    });
    if (!ok) return;
  }
  await actions.importFile(file);
}

/**
 * Does Space on `target` belong to the page instead of the Space-pan?
 *  - anything inside a dialog or an open menu, and any Space while a modal
 *    dialog is open (the board is not reachable then anyway);
 *  - a control focused from the KEYBOARD (`:focus-visible`): Space activates
 *    a button, toggles a checkbox, picks a radio (ui/shortcuts.js
 *    isControlTarget hands Space to such controls too).
 * A control that merely kept the focus after a mouse click does not: holding
 * Space over the board to pan right after clicking a zoom button is common.
 */
function spaceBelongsToPage(target) {
  if (typeof document !== 'undefined' && document.querySelector('[aria-modal="true"], dialog[open]')) return true;
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest('[role="dialog"], [role="alertdialog"], dialog, [role="menu"], [role="listbox"]')) return true;
  if (!isControlTarget(target)) return false;
  try {
    return target.matches(':focus-visible');
  } catch {
    return true; // no :focus-visible support: keyboard use wins
  }
}

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
 * Publish whether a NEW text is being typed (`useUi` `textDraftOpen`). That
 * draft lives only in this component until it is committed — the store has
 * no element and no editingId for it — so this is how the shell learns of
 * it: the welcome screen of an empty board gets out of the way the moment
 * text creation starts, as it does for any element (Excalidraw).
 */
function publishTextDraft(open) {
  if (Boolean(useUi.getState().textDraftOpen) !== open) useUi.setState({ textDraftOpen: open });
}

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
  // The label edit in progress: {id, minH, label, committed} — the height the
  // container had when editing started (it never shrinks below it) and
  // whether this edit already took its one undo snapshot (a label that grows
  // its shape while typing is still ONE undo step with the text).
  const labelEditRef = useRef(null);

  // Before paint, so the welcome screen never shows through the new editor.
  const drafting = newText !== null;
  useLayoutEffect(() => publishTextDraft(drafting), [drafting]);
  useEffect(() => () => publishTextDraft(false), []);

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
            labelEditRef.current = null;
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
              .catch(reportImageFailure);
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
      // The element being created (it.draft) is painted on the INTERACTIVE
      // layer: it changes on every pointer move, and repainting every shape
      // of a big board each time would make drawing crawl.
      const sIn = [s.elements, s.view, w, h, dpr, s.snapEnabled, s.gridSize, s.editingId, it.erasingIds];
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
            draft: it.draft,
            onImageLoad,
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
    //
    // They also END an open text edit, and that must COMMIT what was typed,
    // exactly like a blur: the tool island's buttons keep the focus in the
    // textarea (so it never blurs) and store.setTool clears editingId, which
    // would unmount the editor with the text in it. This listener runs
    // synchronously inside the store update, before React re-renders, so the
    // editor is still mounted and holds the typed value. Commit runs once, so
    // the changes the commit itself makes (a text tool returning to select)
    // come back here harmlessly.
    let prevTool = useBoardStore.getState().tool;
    let prevSel = useBoardStore.getState().selection;
    let prevEditing = useBoardStore.getState().editingId;
    const unsub = useBoardStore.subscribe((st) => {
      const toolChanged = st.tool !== prevTool;
      const editClosed = prevEditing !== null && st.editingId !== prevEditing;
      prevTool = st.tool;
      prevEditing = st.editingId;
      if (toolChanged || editClosed) editorRef.current?.commit({ external: true });
      if (toolChanged) {
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

    // The host must never scroll (see HOST_OVERFLOW): where `overflow: clip`
    // is missing, undo any scroll the browser does to show the caret.
    const host = hostRef.current;
    const onHostScroll = () => {
      if (host.scrollLeft || host.scrollTop) {
        host.scrollLeft = 0;
        host.scrollTop = 0;
      }
    };
    host.addEventListener('scroll', onHostScroll);
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
      host.removeEventListener('scroll', onHostScroll);
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
    // A finger held still opens the context menu (iOS never fires
    // `contextmenu` for a long-press, and Android's arrives while the press
    // holds a gesture, which the reducer ignores): {pointerId, x, y, timer, fired}.
    let longPress = null;
    let longPressAt = 0; // when the last long-press opened the menu (a late native one must not reopen it)

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

    const cancelLongPress = () => {
      if (longPress?.timer) clearTimeout(longPress.timer);
      longPress = null;
    };

    /** The long-press is due: the press becomes the context menu. */
    const fireLongPress = () => {
      const lp = longPress;
      if (!lp || lp.fired) return;
      if (lp.timer) clearTimeout(lp.timer);
      lp.timer = 0;
      lp.fired = true;
      longPressAt = Date.now();
      const g = itRef.current.g;
      if (g && g.started) return; // it became a drag after all
      // Drop the gesture the press started (nothing was written yet; what it
      // selected stays selected, so the menu is about it), then open the menu.
      if (g && g.held) dispatch({ type: 'pointercancel', x: lp.x, y: lp.y, pointerId: lp.pointerId });
      dispatch({ type: 'contextmenu', x: lp.x, y: lp.y, button: 2, shiftKey: false, altKey: false, mod: false });
    };

    const startLongPress = (e) => {
      cancelLongPress();
      if (!LONG_PRESS_TOOLS.has(useBoardStore.getState().tool)) return;
      const pt = localPoint(e);
      longPress = { pointerId: e.pointerId, x: pt.x, y: pt.y, timer: setTimeout(fireLongPress, LONG_PRESS_MS), fired: false };
    };

    /** The pointer holding the active gesture, or null. */
    const gestureOwner = () => {
      const g = itRef.current.g;
      return g && g.held && g.pointerId !== undefined ? g.pointerId : null;
    };

    const onPointerDown = (e) => {
      // A pointer pressing while ANOTHER one holds a gesture — a palm or a
      // finger during a pen or mouse drag — is ignored outright: no commit of
      // the text editor, no capture, no reducer event (which would ignore it
      // too). A second FINGER while a finger drags is the pinch below.
      const owner = gestureOwner();
      if (owner !== null && owner !== e.pointerId && !(e.pointerType === 'touch' && touches.has(owner))) return;
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, localPoint(e));
        if (touches.size >= 2) {
          cancelLongPress();
          // The pinch takes over: cancel the first finger's gesture (by ITS
          // pointer id — the reducer ignores a cancel from any other pointer).
          if (!touchLock && owner !== null) dispatch({ type: 'pointercancel', x: 0, y: 0, pointerId: owner });
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
      if (e.pointerType === 'touch') startLongPress(e);
    };

    const onPointerMove = (e) => {
      if (e.pointerType === 'touch') {
        if (touches.has(e.pointerId)) touches.set(e.pointerId, localPoint(e));
        if (touchLock) {
          if (touches.size >= 2) pinchStep();
          return;
        }
        if (longPress && longPress.pointerId === e.pointerId && !longPress.fired) {
          const pt = localPoint(e);
          if (Math.hypot(pt.x - longPress.x, pt.y - longPress.y) > LONG_PRESS_SLOP) cancelLongPress();
        }
      }
      // A stray pointer during another pointer's gesture: not the gesture's,
      // and not where this user's cursor is either.
      const owner = gestureOwner();
      if (owner !== null && owner !== e.pointerId) return;
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
      if (longPress && longPress.pointerId === e.pointerId) cancelLongPress();
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
      if (longPress && longPress.pointerId === e.pointerId) cancelLongPress();
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

    // Right click, Ctrl+click on macOS, the menu key — and Android's own
    // long-press, which is the long-press timer's (it opens the menu once).
    const onContextMenuNative = (e) => {
      e.preventDefault();
      if (longPress && !longPress.fired) {
        fireLongPress();
        return;
      }
      if (longPress || Date.now() - longPressAt < 1000) return; // the timer already opened it
      if (touches.size > 0) return; // a finger held while drawing (pen, shape…)
      const pt = localPoint(e);
      dispatch({ type: 'contextmenu', x: pt.x, y: pt.y, button: 2, shiftKey: e.shiftKey, altKey: e.altKey, mod: e.ctrlKey || e.metaKey });
    };

    const wheelEvent = (e) => {
      const pt = localPoint(e);
      return { type: 'wheel', x: pt.x, y: pt.y, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, mod: e.ctrlKey || e.metaKey, shiftKey: e.shiftKey };
    };

    const onWheel = (e) => {
      if (e.target !== canvas) return;
      e.preventDefault();
      dispatch(wheelEvent(e));
    };

    // Ctrl/⌘+wheel — and a trackpad pinch, which browsers send as one — must
    // never zoom the whole PAGE (Excalidraw's handleWheel): over the text
    // editor it zooms/pans the board like the canvas under it; over the
    // islands, dialogs and the welcome screen it is just cancelled. Capture
    // phase: the text editor stops the event's propagation.
    const onWindowWheel = (e) => {
      if (e.target === canvas) return; // onWheel
      const host = hostRef.current;
      if (host && e.target instanceof Node && host.contains(e.target)) {
        e.preventDefault();
        dispatch(wheelEvent(e));
        return;
      }
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    // Safari's pinch (gesture events) over anything but the canvas: no page zoom.
    const onWindowGesture = (e) => {
      if (e.target !== canvas) e.preventDefault();
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
        // Space on a dialog or a keyboard-focused control is theirs (activate
        // the button, toggle the checkbox) — not the start of a pan.
        if (!spaceRef.current && spaceBelongsToPage(e.target)) return;
        e.preventDefault();
        if (!spaceRef.current) {
          spaceRef.current = true;
          dispatch({ type: 'keydown', key: ' ' });
        }
        return;
      }
      const undoKey = undoRedoKey(e);
      if (!undoKey && !GESTURE_KEYS.has(e.key)) return;
      const handled = dispatch({ type: 'keydown', key: undoKey ?? e.key, shiftKey: e.shiftKey, altKey: e.altKey, mod: e.ctrlKey || e.metaKey });
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
      insertImageFiles(files, toBoardPoint(pt)).catch(reportImageFailure);
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
    window.addEventListener('wheel', onWindowWheel, { passive: false, capture: true });
    window.addEventListener('gesturestart', onWindowGesture, true);
    window.addEventListener('gesturechange', onWindowGesture, true);
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
      window.removeEventListener('wheel', onWindowWheel, { capture: true });
      window.removeEventListener('gesturestart', onWindowGesture, true);
      window.removeEventListener('gesturechange', onWindowGesture, true);
      cancelLongPress();
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

  // Every file drop is cancelled — onDragOver accepted it, and a drop left to
  // the browser OPENS the file, leaving the board. Images are inserted where
  // they land; a saved board file opens (Excalidraw); anything else says why
  // nothing happened.
  const onDrop = (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    const all = [...(e.dataTransfer.files ?? [])];
    const images = all.filter(isImageFile);
    if (images.length) {
      const pt = localPoint(e);
      insertImageFiles(images, toBoardPoint(pt)).catch(reportImageFailure);
      return;
    }
    const board = all.find(isBoardFile);
    if (board) {
      openDroppedBoardFile(board).catch((err) => {
        console.warn('[canvas] board file drop failed', err);
        toast.error(t.toast.openFailed);
      });
      return;
    }
    if (all.length) toast.error(t.toast.openFailed);
  };

  /* ---------------------------------------------------------- text edit */

  /**
   * Commit a NEW text. `external`: the edit was closed from outside (a tool
   * picked while typing) — the text is kept, but the tool the user just
   * picked stays and nothing gets selected under it.
   */
  const finishNewText = useCallback((el, text, { external = false } = {}) => {
    setNewText(null);
    const s = useBoardStore.getState();
    const value = String(text ?? '').slice(0, LIMITS.MAX_TEXT);
    if (value.trim() !== '') {
      const next = { ...el, text: value, updatedAt: Date.now() };
      const res = tryValidateElement({ ...next, ...fitTextElement(next) });
      if (res.valid) {
        s.commit(`text:${el.id}`);
        s.addElements([res.element]);
        if (!external || s.tool === 'select' || s.tool === 'hand') s.select([el.id]);
      } else {
        console.warn('[canvas] text rejected', res.error);
      }
    }
    if (external) return;
    const after = useBoardStore.getState();
    if (after.tool === 'text' && !after.toolLocked) after.setTool('select');
  }, []);

  /** The label edit record for container `el` (started on its first use). */
  const labelEditFor = useCallback((el) => {
    let rec = labelEditRef.current;
    if (!rec || rec.id !== el.id) {
      rec = { id: el.id, minH: el.h, label: `text:${el.id}:${Date.now()}`, committed: false };
      labelEditRef.current = rec;
    }
    return rec;
  }, []);

  /**
   * While a label is typed, its container grows (height only, top edge
   * fixed) so the wrapped text always fits inside it, and shrinks back when
   * text is deleted — never below the height it had when editing started
   * (Excalidraw). Peers see it grow live; bound arrows follow in the same
   * batch; the first growth takes the edit's one undo snapshot.
   */
  const growLabel = useCallback(
    (id, text) => {
      const s = useBoardStore.getState();
      const el = s.elements.find((e) => e.id === id);
      if (!el || !labelKeyOf(el) || el.locked) return;
      const rec = labelEditFor(el);
      const fit = growContainerForLabel(el, String(text ?? '').slice(0, LIMITS.MAX_LABEL), { minH: rec.minH });
      if (!fit) return;
      if (!rec.committed) {
        s.commit(rec.label);
        rec.committed = true;
      }
      const patches = [{ id, patch: { ...fit, updatedAt: Date.now() } }];
      s.updateElements([...patches, ...resolveBindingPatches(applyPatches(s.elements, patches), [id])]);
    },
    [labelEditFor],
  );

  /**
   * Commit an edit of an existing text or label. `external`: closed from
   * outside (see finishNewText) — the tool the user picked stays.
   */
  const finishExisting = useCallback(
    (id, text, { external = false } = {}) => {
      const s = useBoardStore.getState();
      const el = s.elements.find((e) => e.id === id);
      const rec = labelEditRef.current && labelEditRef.current.id === id ? labelEditRef.current : null;
      labelEditRef.current = null;
      if (s.editingId === id) s.setEditing(null);
      // Editing started from the text tool returns to select, like a new text.
      if (!external && s.tool === 'text' && !s.toolLocked) s.setTool('select');
      if (!el) return;
      const label = rec?.label ?? `text:${id}:${Date.now()}`;
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
        const changed = value !== (el.label ?? '');
        // The container ends exactly as tall as its label needs (a paste or a
        // font change may not have gone through growLabel).
        const fit = el.locked ? null : growContainerForLabel(el, value, { minH: rec?.minH ?? el.h });
        if (!changed && !fit) return;
        const patch = { ...(fit ?? {}), updatedAt: Date.now() };
        if (changed) patch.label = el.type === 'sticky' ? value : value.trim() === '' ? null : value;
        const patches = [{ id, patch }];
        // One undo step per edit: growing while typing already took it.
        if (!rec?.committed) s.commit(label);
        s.updateElements(fit ? [...patches, ...resolveBindingPatches(applyPatches(s.elements, patches), [id])] : patches);
      }
    },
    [],
  );

  const cancelEdit = useCallback(() => {
    setNewText(null);
    labelEditRef.current = null;
    const s = useBoardStore.getState();
    if (s.editingId) s.setEditing(null);
  }, []);

  const layer = { ...LAYER_STYLE, filter: theme === 'dark' ? DARK_MODE_FILTER : undefined };

  return (
    <div
      ref={hostRef}
      className="wb-canvas"
      data-testid="canvas"
      style={{ position: 'absolute', inset: 0, overflow: HOST_OVERFLOW, touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
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
        onLabelChange={growLabel}
        onCancel={cancelEdit}
      />
    </div>
  );
}

/** The text style keys a new text takes from the style panel. */
const TEXT_STYLE_KEYS = styleKeysFor('text');

/**
 * A NEW text draft with the panel's current text style on top: the draft is
 * not in the store (nor in the selection), so actions.applyStyle only changes
 * `store.style` while it is typed — this is how those changes still reach it,
 * live in the editor and in what is committed (Excalidraw).
 */
function styledDraft(draft, style) {
  if (!draft || !style) return draft;
  let out = draft;
  for (const k of TEXT_STYLE_KEYS) {
    if (style[k] !== undefined && style[k] !== out[k]) {
      if (out === draft) out = { ...draft };
      out[k] = style[k];
    }
  }
  return out;
}

/**
 * Renders the TextEditor for the element being edited (store.editingId) or
 * the new text draft. Its own component so only IT re-renders on view changes
 * while an edit is open — the Canvas itself never does.
 */
const EditorHost = forwardRef(function EditorHost({ newText, theme, onFinishNew, onFinishExisting, onLabelChange, onCancel }, ref) {
  const editing = useBoardStore((s) => (s.editingId ? s.elements.find((e) => e.id === s.editingId) ?? null : null));
  const style = useBoardStore((s) => (newText ? s.style : null));
  const draft = useMemo(() => styledDraft(newText, style), [newText, style]);
  const active = draft ?? editing;
  const view = useBoardStore((s) => (active ? s.view : null));
  if (!active || !view) return null;
  const isNew = Boolean(newText);
  const isLabel = !isNew && Boolean(labelKeyOf(active));
  return (
    <TextEditor
      ref={ref}
      key={active.id}
      element={active}
      isNew={isNew}
      view={view}
      theme={theme}
      onCommit={(text, opts) => (isNew ? onFinishNew(active, text, opts) : onFinishExisting(active.id, text, opts))}
      onChange={isLabel ? (text) => onLabelChange(active.id, text) : undefined}
      onCancel={onCancel}
    />
  );
});
