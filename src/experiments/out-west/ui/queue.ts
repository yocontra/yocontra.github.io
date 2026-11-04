/**
 * The Bounty Hunt queue sheet: searching, the widening level and draw-speed windows, the
 * "Duel a ghost now" button at 8 s, and the ghost fallback at 18 s, always labelled as a ghost.
 */
import { GHOST_FALLBACK_MS } from '../contract/duel.ts'
import { type QueueMatch, QueueSearch, type QueueStatus } from '../net/queue.ts'
import { icon } from './icons.ts'
import { uiSound } from './sfx.ts'
import { button, el, setBar, swallow } from './sheet.ts'

export interface QueueSheetOpts {
  /** A fresh Turnstile token, or null when the check failed. */
  token: () => Promise<string | null>
  matched: (m: QueueMatch) => void
  closed: () => void
  /** Leave the queue for a ranked gauntlet run (the way to earn the licence). */
  rideRanked: () => void
}

export class QueueSheet {
  private readonly root: HTMLElement
  private readonly line: HTMLElement
  private readonly detail: HTMLElement
  private readonly ghostBtn: HTMLButtonElement
  private readonly rankedBtn: HTMLButtonElement
  private readonly leaveBtn: HTMLButtonElement
  private readonly bar: HTMLElement
  private readonly search: QueueSearch
  private readonly o: QueueSheetOpts
  private done = false as boolean

  constructor(parent: HTMLElement, o: QueueSheetOpts) {
    this.o = o
    this.root = el('div', 'ow-sheet on ow-queue', parent)
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', 'Bounty Hunt queue')
    swallow(this.root)
    const panel = el('div', 'ow-hub-panel ow-sheet-panel', this.root)
    el('h2', 'ow-hub-h', panel).append(icon('bounty'), 'Bounty Hunt')
    this.line = el('p', 'ow-queue-line', panel, 'Checking you’re no bot…')
    this.line.setAttribute('aria-live', 'polite')
    const track = el('div', 'ow-xp ow-queue-track', panel)
    this.bar = el('div', 'ow-xp-fill', track)
    this.detail = el('p', 'ow-hub-note', panel, '')
    const row = el('div', 'ow-hub-row', panel)
    this.leaveBtn = button(row, 'Leave queue', () => this.cancel())
    this.ghostBtn = button(row, 'Duel a ghost now', () => this.search.ghost(), true)
    this.ghostBtn.hidden = true
    this.rankedBtn = button(
      row,
      'Ride the ranked gauntlet',
      () => {
        this.cancel()
        o.rideRanked()
      },
      true,
    )
    this.rankedBtn.hidden = true
    this.search = new QueueSearch({
      queued: (m) => {
        this.line.textContent = m.ghostsOnly
          ? 'Your connection is rough today. Ghosts only.'
          : 'Looking for a gunslinger…'
      },
      status: (s) => this.status(s),
      matched: (m) => this.matched(m),
      failed: (msg, reason) => this.failed(msg, reason),
    })
    this.begin().catch(() => undefined)
  }

  private async begin(): Promise<void> {
    const token = await this.o.token()
    if (this.done) {
      return
    }
    if (!token) {
      this.failed('The bot check didn’t pass. Try again.')
      return
    }
    this.line.textContent = 'Joining the queue…'
    await this.search.start(token)
  }

  private status(s: QueueStatus): void {
    const secs = Math.floor(s.waitedMs / 1000)
    this.line.textContent = s.ghostsOnly
      ? `Finding you a ghost… ${secs}s`
      : `Looking for a gunslinger… ${secs}s`
    // the matchmaker's windows are its business; only company in the queue is worth a line
    const others = Math.max(0, s.waiting - 1)
    this.detail.textContent =
      others === 0 ? '' : `${others} other${others === 1 ? '' : 's'} waiting`
    setBar(this.bar, s.waitedMs / GHOST_FALLBACK_MS)
    this.ghostBtn.hidden = !s.ghostButton
  }

  private matched(m: QueueMatch): void {
    this.done = true
    this.ghostBtn.hidden = true
    // a ghost is revealed with its own cold breath; a live gun with the found sting
    uiSound(m.mode === 'ghost' ? 'ghost' : 'queueFound')
    const ghostOf =
      m.opponent.kind === 'outlaw' ? 'a Town Outlaw' : `the ghost of ${m.opponent.name}`
    this.line.textContent =
      m.mode === 'ghost'
        ? `Nobody rode in. You’ll duel ${ghostOf}.`
        : `${m.opponent.name} answers the call.`
    setTimeout(() => {
      this.root.remove()
      this.o.matched(m)
    }, 900)
  }

  private failed(msg: string, reason?: string): void {
    this.done = true
    this.line.textContent = msg
    this.detail.textContent = ''
    this.ghostBtn.hidden = true
    this.leaveBtn.textContent = 'Back to the saloon'
    // not a dead end: the licence is three outlaws away
    this.rankedBtn.hidden = reason !== 'unlicensed'
    if (reason === 'unlicensed') {
      this.rankedBtn.focus()
    }
  }

  cancel(): void {
    this.done = true
    this.search.leave()
    this.root.remove()
    this.o.closed()
  }
}
