/**
 * Small DOM helpers shared by the hub, the Outfitter, the queue and the results screens: an
 * element builder, a money formatter, and an in-game confirmation sheet (never `confirm()`).
 */
import { money } from '../data/economy.ts'
import { reducedMotion } from '../settings.ts'

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  parent: HTMLElement | null = null,
  text = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) {
    e.className = cls
  }
  if (text) {
    e.textContent = text
  }
  parent?.append(e)
  return e
}

export function button(
  parent: HTMLElement,
  label: string,
  onClick: () => void,
  primary = false,
): HTMLButtonElement {
  const b = el('button', primary ? 'ow-btn ow-btn-primary' : 'ow-btn', parent, label)
  b.type = 'button'
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  // presses on menus are never presses in the duel
  b.addEventListener('pointerdown', (e) => e.stopPropagation())
  return b
}

/**
 * Label and value rows ("Tries left · 3 of 3") for facts a player scans: rules, rewards, times.
 * A row with an empty value is left out.
 */
export function facts(
  parent: HTMLElement,
  rows: readonly (readonly [label: string, value: string])[],
  cls = '',
): HTMLUListElement {
  const list = el('ul', `ow-results-lines ow-facts${cls ? ` ${cls}` : ''}`, parent)
  for (const [label, value] of rows) {
    if (value) {
      const li = el('li', '', list)
      el('span', '', li, label)
      el('b', '', li, value)
    }
  }
  return list
}

/** Fill a bar (`.ow-xp-fill`) to a fraction, 0..1. Scales on the compositor, never relayouts. */
export function setBar(fill: HTMLElement, fraction: number): void {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  fill.style.transform = `scaleX(${f.toFixed(4)})`
}

/**
 * Count a number up (or down) in an element's text, easing out over `ms`. Text only, so it never
 * relayouts anything but its own line; tabular figures keep the width steady. Reduced motion
 * snaps straight to the end.
 */
export function countUp(
  target: HTMLElement,
  range: { from: number; to: number },
  format: (n: number) => string,
  ms = 900,
): void {
  const { from, to } = range
  if (reducedMotion() || from === to) {
    target.textContent = format(to)
    return
  }
  const t0 = performance.now()
  const step = (now: number): void => {
    const t = Math.min(1, (now - t0) / ms)
    const k = 1 - (1 - t) ** 3
    target.textContent = format(Math.round(from + (to - from) * k))
    if (t < 1 && target.isConnected) {
      requestAnimationFrame(step)
    }
  }
  target.textContent = format(from)
  requestAnimationFrame(step)
}

/** "+$150", "−$40", "$0". */
export function signedMoney(n: number): string {
  if (n > 0) {
    return `+${money(n)}`
  }
  if (n < 0) {
    return `−${money(-n)}`
  }
  return money(0)
}

/** Keep presses on an overlay from reaching the canvas (walking, drawing). */
export function swallow(e: HTMLElement): void {
  for (const t of ['pointerdown', 'pointerup', 'touchstart']) {
    e.addEventListener(t, (ev) => ev.stopPropagation())
  }
}

export interface ConfirmOpts {
  title: string
  body: string
  yes: string
  no?: string
  danger?: boolean
  /** Focus the safe choice (a sheet that can open under a player's key presses). */
  focusNo?: boolean
}

/** A modal sheet with two buttons. Resolves true for yes, false for no, Escape or a tap outside. */
export function confirmSheet(root: HTMLElement, o: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    // everything behind the sheet goes inert: one live Buy button, not two with the same label
    const behind = [...root.children].filter(
      (c): c is HTMLElement => c instanceof HTMLElement && !c.inert,
    )
    for (const c of behind) {
      c.inert = true
    }
    const back = el('div', 'ow-sheet on', root)
    back.setAttribute('role', 'alertdialog')
    back.setAttribute('aria-modal', 'true')
    back.setAttribute('aria-label', o.title)
    swallow(back)
    const panel = el('div', 'ow-hub-panel ow-sheet-panel', back)
    el('h2', 'ow-hub-h', panel, o.title)
    el('p', 'ow-hub-note', panel, o.body)
    const row = el('div', 'ow-hub-row', panel)
    const done = (v: boolean): void => {
      for (const c of behind) {
        c.inert = false
      }
      globalThis.removeEventListener('keydown', onKey, true)
      back.remove()
      resolve(v)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        done(false)
      }
    }
    globalThis.addEventListener('keydown', onKey, true)
    const no = button(row, o.no ?? 'Not now', () => done(false))
    const yes = button(row, o.yes, () => done(true), true)
    if (o.danger) {
      yes.classList.add('ow-btn-danger')
    }
    back.addEventListener('click', (e) => {
      if (e.target === back) {
        done(false)
      }
    })
    ;(o.focusNo ? no : yes).focus()
  })
}

/** Open panel sheets, oldest first: Escape closes the newest only. */
const openSheets: HTMLElement[] = []

export interface PanelSheet {
  /** The sheet's scrolling body. */
  body: HTMLElement
  /** The panel itself (for a footer row under the body). */
  panel: HTMLElement
  close: () => void
}

/**
 * A modal panel with a title and a Close button (the hub's sheet, reusable anywhere): Escape or a
 * tap outside closes it too. `paper` prints it on the receipt stock.
 */
export function panelSheet(
  root: HTMLElement,
  o: { title: string; paper?: boolean; cls?: string; onClose?: () => void },
): PanelSheet {
  const back = el('div', 'ow-sheet on', root)
  back.setAttribute('role', 'dialog')
  back.setAttribute('aria-label', o.title)
  swallow(back)
  const panel = el(
    'div',
    `ow-hub-panel ow-sheet-panel${o.paper ? ' ow-paper-doc' : ''}${o.cls ? ` ${o.cls}` : ''}`,
    back,
  )
  const head = el('div', 'ow-hub-row ow-sheet-head', panel)
  el('h2', 'ow-hub-h', head, o.title)
  let open = true
  const close = (): void => {
    if (!open) {
      return
    }
    open = false
    globalThis.removeEventListener('keydown', onKey, true)
    openSheets.splice(openSheets.indexOf(back), 1)
    back.remove()
    o.onClose?.()
  }
  // Escape closes the newest sheet only (a report sheet over a poster, say)
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && back === openSheets.at(-1)) {
      e.stopImmediatePropagation()
      close()
    }
  }
  openSheets.push(back)
  globalThis.addEventListener('keydown', onKey, true)
  button(head, 'Close', close)
  const body = el('div', 'ow-sheet-body', panel)
  back.addEventListener('click', (e) => {
    if (e.target === back) {
      close()
    }
  })
  return { body, panel, close }
}

/** A one-line status under a form (info, error or ok); returns its setter. */
export function statusLine(
  parent: HTMLElement,
): (text: string, kind?: 'info' | 'error' | 'ok') => void {
  const p = el('p', 'ow-hub-note ow-feat-status', parent)
  p.setAttribute('aria-live', 'polite')
  return (text, kind = 'info') => {
    p.textContent = text
    p.dataset.kind = kind
  }
}
