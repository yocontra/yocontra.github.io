/**
 * The Bounty Hunt match intro: both wanted posters slam in, then READY once the cock beat opens
 * (10 s, or you dodge). A ghost's poster is sepia and labelled, and against a ghost or the Town
 * Outlaw there is no READY at all: nobody is stood up, so you're cocked when the posters are up.
 */
import type { Poster } from '../contract/duel.ts'
import { button, el, swallow } from './sheet.ts'
import { posterEl } from './wanted.ts'

export interface IntroHandlers {
  ready: () => void
  flee: () => void
}

/** The match intro: your poster, his poster, and READY once the cock beat opens. */
export class MatchIntro {
  readonly root: HTMLElement
  private readonly status: HTMLElement
  private readonly readyBtn: HTMLButtonElement
  private sent = false as boolean
  /** A ghost or the Town Outlaw: no READY deadline, no dodge. */
  private readonly ai: boolean
  private readonly onReady: () => void

  constructor(parent: HTMLElement, you: Poster, them: Poster, h: IntroHandlers) {
    this.ai = them.kind !== 'human'
    this.onReady = h.ready
    this.root = el('div', 'ow-match', parent)
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', `Bounty Hunt against ${them.name}`)
    swallow(this.root)
    const label = them.kind === 'human' ? 'Bounty Hunt' : 'Ghost duel'
    el('div', `ow-match-mode${them.kind === 'human' ? '' : ' ghost'}`, this.root, label)
    const row = el('div', 'ow-match-posters', this.root)
    row.append(posterEl(you, 'you'))
    el('div', 'ow-match-vs', row, 'vs')
    row.append(posterEl(them, 'them'))
    this.status = el(
      'div',
      'ow-match-status',
      this.root,
      // against a ghost nobody needs telling there's no READY: the button just isn't there
      this.ai ? '' : 'Sizing each other up…',
    )
    this.status.setAttribute('aria-live', 'polite')
    const btns = el('div', 'ow-hub-row', this.root)
    button(btns, 'Flee', h.flee)
    this.readyBtn = button(
      btns,
      'Ready',
      () => {
        if (!this.sent) {
          this.sent = true
          this.readyBtn.disabled = true
          this.readyBtn.textContent = 'Cocked'
          h.ready()
        }
      },
      true,
    )
    this.readyBtn.disabled = true
    this.readyBtn.hidden = this.ai
    requestAnimationFrame(() => this.root.classList.add('on'))
  }

  /** The cock beat: READY is live for 10 s. */
  cock(deadline: number | null, serverOffset: number): void {
    if (this.ai) {
      // the room cocks you itself; sending it too covers an older room that still asks
      if (!this.sent) {
        this.sent = true
        this.onReady()
      }
      this.status.textContent = 'Walk out when you’re ready.'
      return
    }
    if (!this.sent) {
      this.readyBtn.disabled = false
      this.readyBtn.focus()
    }
    this.countdown(deadline, serverOffset)
  }

  private timer: ReturnType<typeof setInterval> | undefined = undefined

  private countdown(deadline: number | null, offset: number): void {
    clearInterval(this.timer)
    if (deadline === null) {
      return
    }
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((deadline - (Date.now() + offset)) / 1000))
      if (!this.sent) {
        this.status.textContent = `Cock your gun: ${left}s or you dodge`
      }
    }
    tick()
    this.timer = globalThis.setInterval(tick, 250)
  }

  say(text: string): void {
    this.status.textContent = text
  }

  get readySent(): boolean {
    return this.sent
  }

  close(): void {
    clearInterval(this.timer)
    this.root.classList.remove('on')
    setTimeout(() => this.root.remove(), 300)
  }
}
