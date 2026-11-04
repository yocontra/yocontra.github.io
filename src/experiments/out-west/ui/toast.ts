/**
 * Toasts for the meta-game (meta-game stream): medals, challenges, achievements and the guest
 * purse, as small brass-edged slips that drop in at the top and leave on their own. Never during
 * the standoff: a toast that arrives while the street waits for the bell is held until it's over.
 */
import type { Toast } from '../meta/progress.ts'
import { el } from './sheet.ts'

const SHOW_MS = 4200
const GAP_MS = 350
const MAX_QUEUED = 6

export class Toaster {
  private readonly root: HTMLElement
  private readonly queue: Toast[] = []
  private busy = false as boolean
  /** True while a toast must wait (the standoff). */
  private readonly hold: () => boolean

  constructor(parent: HTMLElement, hold: () => boolean = () => false) {
    this.root = el('div', 'ow-toasts', parent)
    this.root.setAttribute('role', 'status')
    this.root.setAttribute('aria-live', 'polite')
    this.hold = hold
  }

  push(t: Toast): void {
    if (this.queue.length >= MAX_QUEUED) {
      this.queue.shift()
    }
    this.queue.push(t)
    this.next()
  }

  private next(): void {
    if (this.busy) {
      return
    }
    if (this.hold()) {
      setTimeout(() => this.next(), 500)
      return
    }
    const t = this.queue.shift()
    if (!t) {
      return
    }
    this.busy = true
    const slip = el('div', `ow-toast ow-toast-${t.kind}`, this.root)
    if (t.tier) {
      slip.dataset.tier = String(t.tier)
    }
    el('span', 'ow-toast-seal', slip).setAttribute('aria-hidden', 'true')
    const text = el('span', 'ow-toast-text', slip)
    el('span', 'ow-toast-kicker', text, t.kicker)
    el('b', 'ow-toast-title', text, t.title)
    el('span', 'ow-toast-line', text, t.line)
    requestAnimationFrame(() => slip.classList.add('on'))
    setTimeout(() => {
      slip.classList.remove('on')
      slip.classList.add('off')
      setTimeout(() => {
        slip.remove()
        this.busy = false
        setTimeout(() => this.next(), GAP_MS)
      }, 400)
    }, SHOW_MS)
  }
}
