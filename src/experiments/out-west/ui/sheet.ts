/**
 * Small DOM helpers shared by the hub, the Outfitter, the queue and the results screens: an
 * element builder, a money formatter, and an in-game confirmation sheet (never `confirm()`).
 */
import { money } from '../data/economy.ts'

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
}

/** A modal sheet with two buttons. Resolves true for yes, false for no, Escape or a tap outside. */
export function confirmSheet(root: HTMLElement, o: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const back = el('div', 'ow-sheet on', root)
    back.setAttribute('role', 'alertdialog')
    back.setAttribute('aria-label', o.title)
    swallow(back)
    const panel = el('div', 'ow-hub-panel ow-sheet-panel', back)
    el('h2', 'ow-hub-h', panel, o.title)
    el('p', 'ow-hub-note', panel, o.body)
    const row = el('div', 'ow-hub-row', panel)
    const done = (v: boolean): void => {
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
    button(row, o.no ?? 'Not now', () => done(false))
    const yes = button(row, o.yes, () => done(true), true)
    if (o.danger) {
      yes.classList.add('ow-btn-danger')
    }
    back.addEventListener('click', (e) => {
      if (e.target === back) {
        done(false)
      }
    })
    yes.focus()
  })
}
