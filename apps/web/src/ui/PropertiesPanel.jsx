/**
 * PropertiesPanel.jsx — Excalidraw's left-hand style panel.
 *
 * Visible while a drawing tool is active (keys from `styleKeysForTool`) or
 * while something is selected (union of `styleKeysForElement` over the selected
 * elements). A row shows the selection's common value, or nothing highlighted
 * when the selection disagrees. Every edit goes through
 * `actions.applyStyle(patch)`, which updates the default style AND patches the
 * selection (only the keys each type uses) as one undo step per control.
 *
 * On phones (≤ 640px) the panel is a bottom sheet behind a "Estilo" toggle.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  STROKE_COLORS,
  BACKGROUND_COLORS,
  COLOR_GRID,
  STICKY_COLORS,
  STROKE_WIDTHS,
  ROUGHNESS,
  FILL_STYLES,
  STROKE_STYLES,
  ROUNDNESS,
  ARROWHEADS,
  FONT_SIZES,
  TEXT_ALIGNS,
} from '../editor/constants.js';
import { styleKeysForElement, styleKeysForTool } from '../editor/elements.js';
import { actions, groupAvailability } from '../editor/actions.js';
import { useBoardStore, useStyle, useTool } from '../store/index.js';
import { useUi } from './uiStore.js';
import { IconButton, Island, useOutsideClose } from './common.jsx';
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconArrowheadArrow,
  IconArrowheadBar,
  IconArrowheadDot,
  IconArrowheadNone,
  IconArrowheadTriangle,
  IconBringForward,
  IconBringToFront,
  IconDuplicate,
  IconEdgeRound,
  IconEdgeSharp,
  IconFillCrossHatch,
  IconFillHachure,
  IconFillSolid,
  IconFillZigzag,
  IconFontCode,
  IconFontHand,
  IconFontNormal,
  IconGroup,
  IconLock,
  IconPalette,
  IconSendBackward,
  IconSendToBack,
  IconSloppyArchitect,
  IconSloppyArtist,
  IconSloppyCartoonist,
  IconStrokeDashed,
  IconStrokeDotted,
  IconStrokeSolid,
  IconTrash,
  IconUngroup,
  IconUnlock,
  IconWidthBold,
  IconWidthExtraBold,
  IconWidthThin,
  IconClose,
} from './Icons.jsx';
import { shortcutHint } from './shortcuts.js';
import { hexFieldValue, hexToApply } from './colorHex.js';
import { t } from './strings.js';

const MIXED = Symbol('mixed');
const EMPTY = [];

/** Value an element paints with when the field is absent (legacy boards). */
function effective(el, key) {
  const v = el[key];
  if (v !== undefined) return v;
  switch (key) {
    case 'roughness':
      return 1;
    case 'fillStyle':
      return 'solid';
    case 'roundness':
      return 'sharp';
    case 'fontFamily':
      return 'hand';
    case 'fontSize':
      return FONT_SIZES.M;
    case 'opacity':
      return 1;
    case 'strokeStyle':
      return 'solid';
    case 'fill':
      return 'none';
    case 'align':
      return el.type === 'text' || el.type === 'sticky' ? 'left' : 'center';
    case 'startArrowhead':
      return 'none';
    case 'endArrowhead':
      return el.type === 'arrow' ? 'arrow' : 'none';
    default:
      return undefined;
  }
}

/** The value shared by every element that uses `key`, or MIXED. */
function commonValue(elements, key) {
  let out;
  let seen = false;
  for (const el of elements) {
    if (!styleKeysForElement(el).includes(key)) continue;
    const v = effective(el, key);
    if (!seen) {
      out = v;
      seen = true;
    } else if (v !== out) return MIXED;
  }
  return seen ? out : undefined;
}

const isPaint = (c) => typeof c === 'string' && c !== 'none' && c !== 'transparent';

/* --- rows ------------------------------------------------------------------------ */

function Section({ title, children }) {
  return (
    <fieldset className="props-section">
      <legend className="props-section__title">{title}</legend>
      {children}
    </fieldset>
  );
}

function Swatch({ color, checked, onPick, label }) {
  const transparent = !isPaint(color);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={`swatch ${transparent ? 'swatch--transparent' : ''}`}
      style={transparent ? undefined : { '--swatch': color }}
      title={label ?? (transparent ? t.props.transparent : t.props.colorName(color))}
      aria-label={label ?? (transparent ? t.props.transparent : t.props.colorName(color))}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(color)}
    />
  );
}

/**
 * Where the popover goes: beside the trigger (the panel scrolls, which would
 * clip an absolutely positioned popover, so it is `fixed`), above it when
 * there is no room beside, clamped to the window. Null when the trigger is
 * not on screen any more (scrolled out of the panel, or the panel hidden):
 * the popover then has nothing to point at and closes.
 */
function popoverPosition(trigger, pop) {
  if (!trigger || !pop || !trigger.getClientRects().length) return null;
  const r = trigger.getBoundingClientRect();
  const scroller = trigger.closest('.props-panel');
  if (scroller) {
    const b = scroller.getBoundingClientRect();
    if (r.bottom <= b.top || r.top >= b.bottom) return null;
  }
  const p = pop.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = r.right + 14;
  if (left + p.width > vw - 8) left = Math.max(8, Math.min(r.left, vw - p.width - 8));
  let top = r.top - 10;
  if (left < r.right && left + p.width > r.left) top = r.top - p.height - 10; // no room beside: go above
  top = Math.max(8, Math.min(top, vh - p.height - 8));
  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * Quick swatches + the current colour, which opens the full picker.
 *
 * The popover is an overlay of the UI store (`colorPicker` = this row), so
 * Escape closes just the picker — from the page or from the hex field — and
 * keeps the selection, as in Excalidraw. It follows its trigger while the
 * panel scrolls or the window resizes, and closes once the trigger is gone.
 */
function ColorRow({ row, value, quick, onPick }) {
  const open = useUi((s) => s.colorPicker === row);
  const [hex, setHex] = useState('');
  // The user typed in the hex field since it last showed the current colour.
  // Only then does leaving it (or Enter) apply anything.
  const hexEditedRef = useRef(false);
  // Opened from the keyboard (the trigger had focus): focus goes back to it on close.
  const restoreFocusRef = useRef(false);
  const [pos, setPos] = useState(null);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const popRef = useRef(null);
  const close = useCallback(() => useUi.getState().closeColorPicker(row), [row]);
  useOutsideClose(ref, open, close);

  // Never leave the store pointing at a popover that is gone (the panel
  // unmounts when the selection is deleted or cleared from the keyboard).
  useEffect(() => close, [close]);

  const place = useCallback(() => {
    const next = popoverPosition(triggerRef.current, popRef.current);
    if (!next) {
      close();
      return;
    }
    setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
  }, [close]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place]);

  // Follow the trigger: the panel scrolls (capture catches scrolls of any
  // container) and the window resizes; once per frame at most.
  useEffect(() => {
    if (!open) return undefined;
    let frame = 0;
    const onChange = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          place();
        });
      }
    };
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
    };
  }, [open, place]);

  // Closed with focus inside the popover (Escape in the hex field): the
  // focused field is gone, so a keyboard user gets the trigger back.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open && restoreFocusRef.current) {
      const active = document.activeElement;
      if (!active || active === document.body) triggerRef.current?.focus({ preventScroll: true });
    }
    if (!open) restoreFocusRef.current = false;
    wasOpen.current = open;
  }, [open]);
  const current = value === MIXED ? null : value;

  // The field follows the colour while it is not being edited: a swatch pick,
  // an undo or a collaborator's change all show up in it. (It used to keep the
  // colour from when the popover opened, and its blur re-applied that.)
  useEffect(() => {
    if (open && !hexEditedRef.current) setHex(hexFieldValue(current));
  }, [open, current]);

  /** A swatch or the native picker: discards a half-typed hex. */
  const pick = (c) => {
    hexEditedRef.current = false;
    onPick(c);
  };
  const submitHex = () => {
    const next = hexToApply(hex, hexEditedRef.current, current);
    hexEditedRef.current = false;
    if (next) onPick(next);
    // Invalid or unchanged text goes back to showing the colour in use.
    setHex(hexFieldValue(next ?? current));
  };
  return (
    <div className="color-row" ref={ref}>
      <div className="swatches" role="radiogroup">
        {quick.map((c) => (
          <Swatch key={c} color={c} checked={current === c} onPick={pick} />
        ))}
      </div>
      <span className="props-divider" aria-hidden="true" />
      <button
        ref={triggerRef}
        type="button"
        className={`swatch swatch--current ${!isPaint(current) ? 'swatch--transparent' : ''}`}
        style={isPaint(current) ? { '--swatch': current } : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t.props.customColor}
        aria-label={t.props.customColor}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          hexEditedRef.current = false;
          setHex(hexFieldValue(current));
          if (open) {
            close();
            return;
          }
          restoreFocusRef.current = document.activeElement === triggerRef.current;
          useUi.getState().openColorPicker(row);
        }}
      />
      {open ? (
        <Island
          ref={popRef}
          className="color-popover"
          role="dialog"
          aria-label={t.props.customColor}
          style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
        >
          <div className="color-grid" role="radiogroup">
            {COLOR_GRID.map((c) => (
              <Swatch key={c} color={c} checked={current === c} onPick={pick} />
            ))}
          </div>
          <form
            className="color-hex"
            onSubmit={(e) => {
              e.preventDefault();
              submitHex();
            }}
          >
            <span className="color-hex__hash">#</span>
            <input
              className="color-hex__input"
              value={hex.replace(/^#/, '')}
              maxLength={7}
              spellCheck={false}
              aria-label={t.props.customColor}
              onChange={(e) => {
                hexEditedRef.current = true;
                setHex(e.target.value);
              }}
              onKeyDown={(e) => {
                // Escape discards what was typed; the keyboard map then
                // closes the popover (it is the top overlay).
                if (e.key === 'Escape') hexEditedRef.current = false;
              }}
              onBlur={submitHex}
            />
            <input
              type="color"
              className="color-hex__native"
              value={isPaint(current) && /^#[0-9a-f]{6}$/i.test(current) ? current : '#000000'}
              aria-label={t.props.customColor}
              onChange={(e) => pick(e.target.value)}
            />
          </form>
        </Island>
      ) : null}
    </div>
  );
}

/** A row of icon options (radio group). */
function Options({ value, options, onPick, flip = false }) {
  return (
    <div className="options" role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className="option"
          title={o.label}
          aria-label={o.label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(o.value)}
        >
          {o.icon ? <o.icon size={18} style={flip ? { transform: 'scaleX(-1)' } : undefined} /> : <span className="option__text">{o.text}</span>}
        </button>
      ))}
    </div>
  );
}

/* --- option tables ------------------------------------------------------------------- */

const WIDTH_OPTIONS = [
  { value: STROKE_WIDTHS.thin, label: t.props.widths.thin, icon: IconWidthThin },
  { value: STROKE_WIDTHS.bold, label: t.props.widths.bold, icon: IconWidthBold },
  { value: STROKE_WIDTHS.extraBold, label: t.props.widths.extraBold, icon: IconWidthExtraBold },
];
const STROKE_STYLE_ICONS = { solid: IconStrokeSolid, dashed: IconStrokeDashed, dotted: IconStrokeDotted };
const STROKE_STYLE_OPTIONS = STROKE_STYLES.map((v) => ({ value: v, label: t.props.strokeStyles[v], icon: STROKE_STYLE_ICONS[v] }));
const FILL_ICONS = { hachure: IconFillHachure, 'cross-hatch': IconFillCrossHatch, solid: IconFillSolid, zigzag: IconFillZigzag };
const FILL_OPTIONS = FILL_STYLES.map((v) => ({ value: v, label: t.props.fillStyles[v] ?? v, icon: FILL_ICONS[v] }));
const ROUGHNESS_OPTIONS = [
  { value: ROUGHNESS.architect, label: t.props.roughnessNames.architect, icon: IconSloppyArchitect },
  { value: ROUGHNESS.artist, label: t.props.roughnessNames.artist, icon: IconSloppyArtist },
  { value: ROUGHNESS.cartoonist, label: t.props.roughnessNames.cartoonist, icon: IconSloppyCartoonist },
];
const EDGE_ICONS = { sharp: IconEdgeSharp, round: IconEdgeRound };
const ROUNDNESS_OPTIONS = ROUNDNESS.map((v) => ({ value: v, label: t.props.roundnessNames[v], icon: EDGE_ICONS[v] }));
const HEAD_ICONS = { none: IconArrowheadNone, arrow: IconArrowheadArrow, triangle: IconArrowheadTriangle, bar: IconArrowheadBar, dot: IconArrowheadDot };
const HEAD_OPTIONS = ARROWHEADS.map((v) => ({ value: v, label: t.props.arrowheadNames[v], icon: HEAD_ICONS[v] }));
const FONT_OPTIONS = [
  { value: 'hand', label: t.props.fontNames.hand, icon: IconFontHand },
  { value: 'normal', label: t.props.fontNames.normal, icon: IconFontNormal },
  { value: 'code', label: t.props.fontNames.code, icon: IconFontCode },
];
const SIZE_OPTIONS = Object.entries(FONT_SIZES).map(([k, v]) => ({ value: v, label: t.props.sizeNames[k], text: k }));
const ALIGN_ICONS = { left: IconAlignLeft, center: IconAlignCenter, right: IconAlignRight };
const ALIGN_OPTIONS = TEXT_ALIGNS.map((v) => ({ value: v, label: t.props.alignNames[v], icon: ALIGN_ICONS[v] }));

/** Types whose `roundness` actually changes the drawing. */
const ROUNDABLE = new Set(['rect', 'diamond', 'arrow', 'line']);

/* --- the panel ----------------------------------------------------------------------- */

function useSelectedElements() {
  return useBoardStore(useShallow((s) => (s.selection.size ? s.elements.filter((el) => s.selection.has(el.id)) : EMPTY)));
}

/**
 * Which group buttons the selection gets, as a bit mask (a primitive, so the
 * panel re-renders only when it changes): 1 = Agrupar would do something (not
 * for a selection that already is exactly one group), 2 = Desagrupar.
 */
function groupButtons(state) {
  if (!state.selection.size) return 0;
  const { canGroup, canUngroup } = groupAvailability(state);
  return (canGroup ? 1 : 0) | (canUngroup ? 2 : 0);
}

export function PropertiesPanel() {
  const tool = useTool();
  const style = useStyle();
  const selected = useSelectedElements();
  const groupMask = useBoardStore(groupButtons);
  const sheetOpen = useUi((s) => s.propsOpen);
  const editingId = useBoardStore((s) => s.editingId);

  const model = useMemo(() => {
    const hasSel = selected.length > 0;
    const types = hasSel ? [...new Set(selected.map((el) => el.type))] : [tool];
    // Per element, not per type: an unlabelled shape has no font controls,
    // unless its first label is being typed right now.
    const keys = new Set(
      hasSel
        ? selected.flatMap((el) => styleKeysForElement(el, { editing: el.id === editingId }))
        : styleKeysForTool(tool),
    );
    const onlySticky = types.every((ty) => ty === 'sticky');
    const value = (k) => {
      if (hasSel) return commonValue(selected, k);
      if (k === 'fill' && tool === 'sticky') return style.stickyFill;
      if (k === 'roundness' && (tool === 'ellipse' || tool === 'cylinder')) return 'sharp';
      return style[k];
    };
    return { hasSel, types, keys, onlySticky, value };
  }, [selected, tool, style, editingId]);

  const { hasSel, types, keys, onlySticky, value } = model;
  if (!hasSel && keys.size === 0) return null;

  const set = (k) => (v) => actions.applyStyle({ [k]: v });
  const fill = value('fill');
  const showFillStyle = keys.has('fillStyle') && (fill === MIXED || isPaint(fill));
  const showRoundness = keys.has('roundness') && types.some((ty) => ROUNDABLE.has(ty));
  const locked = hasSel && selected.every((el) => el.locked);

  const body = (
    <>
      {keys.has('stroke') ? (
        <Section title={t.props.stroke}>
          <ColorRow row="stroke" value={value('stroke')} quick={STROKE_COLORS} onPick={set('stroke')} />
        </Section>
      ) : null}
      {keys.has('fill') ? (
        <Section title={t.props.background}>
          <ColorRow row="fill" value={fill} quick={onlySticky ? STICKY_COLORS : BACKGROUND_COLORS} onPick={set('fill')} />
        </Section>
      ) : null}
      {showFillStyle ? (
        <Section title={t.props.fill}>
          <Options value={value('fillStyle')} options={FILL_OPTIONS} onPick={set('fillStyle')} />
        </Section>
      ) : null}
      {keys.has('strokeWidth') ? (
        <Section title={t.props.strokeWidth}>
          <Options value={value('strokeWidth')} options={WIDTH_OPTIONS} onPick={set('strokeWidth')} />
        </Section>
      ) : null}
      {keys.has('strokeStyle') ? (
        <Section title={t.props.strokeStyle}>
          <Options value={value('strokeStyle')} options={STROKE_STYLE_OPTIONS} onPick={set('strokeStyle')} />
        </Section>
      ) : null}
      {keys.has('roughness') ? (
        <Section title={t.props.roughness}>
          <Options value={value('roughness')} options={ROUGHNESS_OPTIONS} onPick={set('roughness')} />
        </Section>
      ) : null}
      {showRoundness ? (
        <Section title={t.props.roundness}>
          <Options value={value('roundness')} options={ROUNDNESS_OPTIONS} onPick={set('roundness')} />
        </Section>
      ) : null}
      {keys.has('startArrowhead') || keys.has('endArrowhead') ? (
        <Section title={t.props.arrowheads}>
          <div className="arrowhead-row">
            <span className="arrowhead-row__label">{t.props.arrowStart}</span>
            <Options value={value('startArrowhead')} options={HEAD_OPTIONS} onPick={set('startArrowhead')} flip />
          </div>
          <div className="arrowhead-row">
            <span className="arrowhead-row__label">{t.props.arrowEnd}</span>
            <Options value={value('endArrowhead')} options={HEAD_OPTIONS} onPick={set('endArrowhead')} />
          </div>
        </Section>
      ) : null}
      {keys.has('fontFamily') ? (
        <Section title={t.props.font}>
          <Options value={value('fontFamily')} options={FONT_OPTIONS} onPick={set('fontFamily')} />
        </Section>
      ) : null}
      {keys.has('fontSize') ? (
        <Section title={t.props.fontSize}>
          <Options value={value('fontSize')} options={SIZE_OPTIONS} onPick={set('fontSize')} />
        </Section>
      ) : null}
      {keys.has('align') ? (
        <Section title={t.props.align}>
          <Options value={value('align')} options={ALIGN_OPTIONS} onPick={set('align')} />
        </Section>
      ) : null}
      {keys.has('opacity') ? <OpacityRow value={value('opacity')} /> : null}
      {hasSel ? (
        <>
          <Section title={t.props.layers}>
            <div className="options">
              <IconButton className="option" label={t.actions.sendToBack} shortcut={shortcutHint('edit.back')} onClick={actions.sendToBack}>
                <IconSendToBack size={18} />
              </IconButton>
              <IconButton className="option" label={t.actions.sendBackward} shortcut={shortcutHint('edit.backward')} onClick={actions.sendBackward}>
                <IconSendBackward size={18} />
              </IconButton>
              <IconButton className="option" label={t.actions.bringForward} shortcut={shortcutHint('edit.forward')} onClick={actions.bringForward}>
                <IconBringForward size={18} />
              </IconButton>
              <IconButton className="option" label={t.actions.bringToFront} shortcut={shortcutHint('edit.front')} onClick={actions.bringToFront}>
                <IconBringToFront size={18} />
              </IconButton>
            </div>
          </Section>
          <Section title={t.props.actions}>
            <div className="options">
              <IconButton className="option" label={t.actions.duplicate} shortcut={shortcutHint('edit.duplicate')} onClick={() => actions.duplicateSelection()}>
                <IconDuplicate size={18} />
              </IconButton>
              {/* Locked elements are protected from deletion: no dead button. */}
              <IconButton
                className="option"
                label={t.actions.delete}
                shortcut={shortcutHint('edit.delete')}
                disabled={locked}
                onClick={() => actions.deleteSelection()}
              >
                <IconTrash size={18} />
              </IconButton>
              {groupMask & 1 ? (
                <IconButton className="option" label={t.actions.group} shortcut={shortcutHint('edit.group')} onClick={() => actions.group()}>
                  <IconGroup size={18} />
                </IconButton>
              ) : null}
              {groupMask & 2 ? (
                <IconButton className="option" label={t.actions.ungroup} shortcut={shortcutHint('edit.ungroup')} onClick={() => actions.ungroup()}>
                  <IconUngroup size={18} />
                </IconButton>
              ) : null}
              <IconButton
                className="option"
                label={locked ? t.actions.unlock : t.actions.lock}
                shortcut={shortcutHint('edit.lock')}
                active={locked}
                onClick={() => actions.toggleLock()}
              >
                {locked ? <IconLock size={18} /> : <IconUnlock size={18} />}
              </IconButton>
            </div>
          </Section>
        </>
      ) : null}
    </>
  );

  return (
    <>
      <button
        type="button"
        className={`props-toggle island ${sheetOpen ? 'is-active' : ''}`}
        aria-expanded={sheetOpen}
        aria-controls="props-panel"
        onClick={() => useUi.getState().toggle('propsOpen')}
      >
        <IconPalette size={18} />
        <span>{t.props.toggle}</span>
      </button>
      <Island
        as="section"
        id="props-panel"
        className="props-panel"
        data-open={sheetOpen ? 'true' : 'false'}
        aria-label={t.props.panel}
        data-testid="properties-panel"
      >
        <div className="props-panel__sheet-head">
          <span>{t.props.panel}</span>
          <IconButton label={t.dialog.close} onClick={() => useUi.getState().close('propsOpen')}>
            <IconClose size={18} />
          </IconButton>
        </div>
        {body}
      </Island>
    </>
  );
}

let sliderGestureSeq = 0;

/**
 * One pointer drag on a slider, as a gesture id for `actions.applyStyle`:
 * set on pointerdown, cleared when the button is released anywhere (the
 * pointer may leave the slider mid-drag). Keyboard changes carry no gesture
 * and coalesce by label as before.
 */
function useSliderGesture() {
  const gesture = useRef(null);
  const end = useRef(null);
  useEffect(() => () => end.current?.(), []);
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    end.current?.();
    sliderGestureSeq += 1;
    gesture.current = `drag${Date.now().toString(36)}${sliderGestureSeq}`;
    const stop = () => {
      gesture.current = null;
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      end.current = null;
    };
    end.current = stop;
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
  };
  return { gesture, onPointerDown };
}

function OpacityRow({ value }) {
  const pct = value === MIXED || value === undefined ? 100 : Math.round(Number(value) * 100);
  // A drag is one undo step even with pauses (EDITOR_CONTRACT §3): the
  // store's 500 ms same-label window alone split a drag held still mid-way.
  const { gesture, onPointerDown } = useSliderGesture();
  return (
    <Section title={t.props.opacity}>
      <div className="opacity-row">
        <input
          type="range"
          className="range"
          min={0}
          max={100}
          step={5}
          value={pct}
          aria-label={t.props.opacity}
          aria-valuetext={`${pct}%`}
          onPointerDown={onPointerDown}
          onChange={(e) => actions.applyStyle({ opacity: Number(e.target.value) / 100 }, { gesture: gesture.current })}
        />
        <span className="opacity-row__value">{value === MIXED ? '—' : `${pct}%`}</span>
      </div>
    </Section>
  );
}

export default PropertiesPanel;
