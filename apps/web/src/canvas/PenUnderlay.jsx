/**
 * PenUnderlay.jsx — the freehand pen, and nothing else.
 *
 * This replaces a 695-line Canvas that handled drawing, selection, dragging,
 * resizing, rotating, marquee, panning, zooming and the keyboard: every one of
 * those now belongs to React Flow, and having them in two places is what made
 * the app feel broken. What is left here is the one thing React Flow's model
 * cannot express — a freehand stroke, which has no fixed box to lay out and no
 * handles to grab.
 *
 * It sits UNDER the flow layer and only takes pointer events while the pen or
 * eraser tool is active, so the board is React Flow's to receive everything
 * else. It reads its strokes from the same store as everything else, so a pen
 * stroke syncs, undoes and re-renders like any other element.
 *
 * ## Two rules worth stating
 *
 * 1. It never calls `preventDefault` on events it does not own. Swallowing a
 *    wheel event that React Flow is about to pan with is how a scroll gesture
 *    turns into a dead zone.
 * 2. The theme comes from the store's `theme`, never from `board.theme`. The
 *    old canvas read the BOARD's theme while the app's theme lived on
 *    `document.documentElement`, so the two disagreed and dark mode painted a
 *    light rectangle over a dark surface.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useBoardStore } from '../store/index.js';
import { drawScene } from './renderer.js';
import { reducePen, idleState } from './penInteraction.js';
import './penUnderlay.css';

const store = () => useBoardStore.getState();

/** Colours for the two themes, matching `tokens.css`. Kept here rather than
 *  read from CSS because the 2D context needs real colour strings, and
 *  `getComputedStyle` on every frame is a forced reflow. */
const PALETTE = {
  light: { bg: '#f8f9fb', ink: '#1f2937' },
  dark: { bg: '#14161b', ink: '#e5e7eb' },
};

export default function PenUnderlay() {
  const tool = useBoardStore((s) => s.tool);
  const theme = useBoardStore((s) => s.theme);
  const elements = useBoardStore((s) => s.elements);

  const canvasRef = useRef(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const draftRef = useRef(null);
  const rafRef = useRef(0);
  const phaseRef = useRef(idleState());

  // The pen and the eraser are the only two tools that need this layer.
  const active = tool === 'pen' || tool === 'eraser';

  const paint = useCallback(() => {
    rafRef.current = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const s = store();
    const palette = PALETTE[s.theme] || PALETTE.light;
    drawScene(ctx, {
      elements: s.elements,
      // The underlay is transparent: the flow layer paints the background, and
      // a filled rect here would cover the grid and the minimap.
      background: null,
      view: s.view,
      theme: s.theme,
      ink: palette.ink,
      selection: s.selection,
      draft: draftRef.current,
      width: sizeRef.current.w,
      height: sizeRef.current.h,
    });
  }, []);

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(paint);
  }, [paint]);

  // Re-paint when anything that changes the picture changes.
  useEffect(() => {
    schedule();
  }, [elements, theme, tool, schedule]);

  // Size the backing store to the container, once observed.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      sizeRef.current = { w: r.width, h: r.height };
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      schedule();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [schedule]);

  const applyEffects = useCallback(
    (effects) => {
      const s = store();
      for (const fx of effects) {
        switch (fx.type) {
          case 'commit':
            s.commit(fx.label);
            break;
          case 'addElement':
            s.addElement(fx.element);
            break;
          case 'removeElements':
            s.removeElements(fx.ids);
            break;
          case 'setDraft':
            draftRef.current = fx.element;
            break;
          case 'setView':
            s.setView(fx.view);
            break;
          default:
            // Unknown effects are ignored rather than thrown on: this file
            // and the reducer evolve together, and one stray effect must
            // never take the board down mid-stroke.
            break;
        }
      }
      schedule();
    },
    [schedule],
  );

  const toBoard = useCallback((e) => {
    const s = store();
    const r = canvasRef.current?.getBoundingClientRect();
    const x = e.clientX - (r?.left ?? 0);
    const y = e.clientY - (r?.top ?? 0);
    return { x: (x - s.view.panX) / (s.view.zoom || 1), y: (y - s.view.panY) / (s.view.zoom || 1) };
  }, []);

  const onPointerDown = useCallback(
    (e) => {
      if (!active || e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const ctx = { tool, elements: store().elements, style: store().style, view: store().view, now: Date.now() };
      const r = reducePen(phaseRef.current, { type: 'pointerdown', boardPt: toBoard(e) }, ctx);
      phaseRef.current = r.state;
      applyEffects(r.effects);
    },
    [active, tool, toBoard, applyEffects],
  );

  const onPointerMove = useCallback(
    (e) => {
      if (!active || phaseRef.current.phase === 'idle') return;
      const ctx = { tool, elements: store().elements, style: store().style, view: store().view, now: Date.now() };
      const r = reducePen(phaseRef.current, { type: 'pointermove', boardPt: toBoard(e) }, ctx);
      phaseRef.current = r.state;
      applyEffects(r.effects);
    },
    [active, tool, toBoard, applyEffects],
  );

  const onPointerUp = useCallback(
    (e) => {
      if (!active || phaseRef.current.phase === 'idle') return;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      const ctx = { tool, elements: store().elements, style: store().style, view: store().view, now: Date.now() };
      const r = reducePen(phaseRef.current, { type: 'pointerup', boardPt: toBoard(e) }, ctx);
      phaseRef.current = r.state;
      applyEffects(r.effects);
    },
    [active, tool, toBoard, applyEffects],
  );

  // Leaving the pen tool mid-stroke has to abandon the draft, or a stroke the
  // user started and abandoned survives as a half-finished element.
  useEffect(() => {
    if (!active) phaseRef.current = idleState();
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      className="pen-underlay"
      data-active={active ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
