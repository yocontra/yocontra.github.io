// biome-ignore-all lint/style/noExcessiveLinesPerFile: the HUD card, menu copy and end ledger live together
import { money } from '../data/economy.ts'
import { type Action, keyLabel } from '../engine/input.ts'
import type { Settings } from '../save.ts'
import { type CardTimes, type ConfirmSpec, renderConfirm, renderTimes } from './hud-parts.ts'
import { icon } from './icons.ts'
import { openSettings } from './settings-sheet.ts'
import { uiSound } from './sfx.ts'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  parent: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) {
    e.textContent = text
  }
  parent.appendChild(e)
  return e
}

/** The card's (and DRAW!'s) CSS fade, ms: their text is cleared once it's done. */
const CARD_FADE_MS = 400

export interface LedgerRow {
  name: string
  ms: number | null
  grade: string
  attempts: number
  /** Bounty + bonus collected for him (null if not yet). */
  paid: number | null
}

export interface CardSpec {
  kind: 'win' | 'lose' | 'coward' | 'info'
  title: string
  big: string
  sub: string
  hint: string
}

export interface EndSpec {
  stats: {
    cowardice: number
    avg: number | null
    assist: boolean
    legend: boolean
    legendUnlocked: boolean
    total: number
    best: number
    ranked: boolean
  }
  onAgain: () => void
  onLegend: () => void
  onBoard: () => void
  /** Back to the hub (absent where there's no hub: debug and level-jump loads). */
  onSaloon?: () => void
}

export class Hud {
  readonly root: HTMLElement
  private readonly counter: HTMLElement
  private readonly pips: HTMLElement
  private readonly callCap: HTMLElement
  private readonly fakeCap: HTMLElement
  private readonly lineCap: HTMLElement
  private readonly card: HTMLElement
  private readonly cardTitle: HTMLElement
  private readonly cardSub: HTMLElement
  private readonly cardBig: HTMLElement
  private readonly cardHint: HTMLElement
  private readonly cardPay: HTMLElement
  private readonly cardTimesEl: HTMLElement
  private readonly cardStampEl: HTMLElement
  private readonly glintMark: HTMLElement
  private readonly purse: HTMLElement
  private readonly purseText: HTMLElement
  private purseShown = 0
  private purseFrom = 0
  private purseTo = 0
  private purseT = 1
  private readonly letterTop: HTMLElement
  private readonly letterBot: HTMLElement
  private readonly whip: HTMLElement
  private readonly iris: HTMLElement
  readonly pauseBtn: HTMLButtonElement
  readonly menu: HTMLElement
  readonly end: HTMLElement
  readonly debug: HTMLElement
  private readonly callIndicator: HTMLElement
  private cardClear: ReturnType<typeof setTimeout> | undefined = undefined
  private callCapClear: ReturnType<typeof setTimeout> | undefined = undefined
  private fakeTimer = 0
  private lineTimer = 0
  private callTimer = 0
  captions = true as boolean
  private readonly mode: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root
    const hud = el('div', 'ow-hud', root)
    this.counter = el('div', 'ow-counter', hud)
    this.purse = el('div', 'ow-purse', hud)
    this.purse.setAttribute('aria-label', 'Purse')
    this.purse.append(icon('money'))
    this.purseText = el('span', '', this.purse, money(0))
    this.pauseBtn = el('button', 'ow-pause', hud)
    this.pauseBtn.type = 'button'
    this.pauseBtn.setAttribute('aria-label', 'Pause')
    this.pauseBtn.innerHTML = '<span></span><span></span>'
    this.mode = el('div', 'ow-mode', hud)
    this.pips = el('div', 'ow-pips', hud)
    this.letterTop = el('div', 'ow-letter ow-letter-top', root)
    this.letterBot = el('div', 'ow-letter ow-letter-bot', root)
    this.callIndicator = el('div', 'ow-call-indicator', root)
    this.glintMark = el('div', 'ow-glint-mark', root)
    this.glintMark.setAttribute('aria-hidden', 'true')
    this.callCap = el('div', 'ow-cap-call', root)
    this.callCap.setAttribute('role', 'status')
    this.fakeCap = el('div', 'ow-cap-fake', root)
    this.lineCap = el('div', 'ow-cap-line', root)
    this.card = el('div', 'ow-card', root)
    this.cardTitle = el('div', 'ow-card-title', this.card)
    this.cardBig = el('div', 'ow-card-big', this.card)
    this.cardSub = el('div', 'ow-card-sub', this.card)
    this.cardTimesEl = el('div', 'ow-card-times', this.card)
    this.cardPay = el('div', 'ow-card-pay', this.card)
    this.cardStampEl = el('div', 'ow-card-stamp', this.card)
    this.cardHint = el('div', 'ow-card-hint', this.card)
    this.whip = el('div', 'ow-whip', root)
    this.iris = el('div', 'ow-iris', root)
    this.menu = el('div', 'ow-menu', root)
    this.menu.setAttribute('role', 'dialog')
    this.end = el('div', 'ow-end', root)
    this.debug = el('pre', 'ow-debug', root)
  }

  show(on: boolean): void {
    this.root.classList.toggle('ow-playing', on)
  }

  /** The Daily Outlaw: no gauntlet counter and no run purse (the mode badge says DAILY OUTLAW). */
  setDaily(on: boolean): void {
    this.counter.hidden = on
    this.purse.hidden = on
  }

  setCounter(i: number, total: number, legend: boolean): void {
    this.counter.textContent = `${legend ? 'LEGEND · ' : ''}${i + 1} / ${total}`
  }

  setPips(n: number, visible: boolean): void {
    this.pips.classList.toggle('on', visible)
    while (this.pips.children.length < n) {
      const p = el('span', 'ow-pip', this.pips)
      requestAnimationFrame(() => p.classList.add('in'))
    }
    while (this.pips.children.length > n) {
      this.pips.lastChild?.remove()
    }
  }

  call(text: string, ms: number): void {
    clearTimeout(this.callCapClear)
    this.callCap.textContent = text
    if (this.callCap.classList.contains('on')) {
      // restart the animation; only then is a forced layout worth it (not on the bell's frame)
      this.callCap.classList.remove('on')
      void this.callCap.offsetWidth
    }
    this.callCap.classList.add('on')
    this.callIndicator.classList.add('on')
    this.callTimer = ms
  }

  clearCall(): void {
    this.callCap.classList.remove('on')
    this.callCap.textContent = ''
    this.callIndicator.classList.remove('on')
    this.callTimer = 0
    this.marker(null, null)
  }

  /**
   * The pulsing ring on the rifleman's scope glint, at screen pixels (null hides it). Shown only
   * after the call, so it is never a cue.
   */
  marker(x: number | null, y: number | null): void {
    const on = x !== null && y !== null
    this.glintMark.classList.toggle('on', on)
    if (on) {
      this.glintMark.style.translate = `${Math.round(x)}px ${Math.round(y)}px`
    }
  }

  fake(text: string, ms = 1800): void {
    if (!this.captions) {
      return
    }
    this.fakeCap.textContent = text
    this.fakeCap.classList.add('on')
    this.fakeTimer = ms
  }

  line(who: string, text: string, ms = 2400): void {
    if (!this.captions) {
      return
    }
    this.lineCap.innerHTML = ''
    el('b', '', this.lineCap, `${who}: `)
    el('span', '', this.lineCap, text)
    this.lineCap.classList.add('on')
    this.lineTimer = ms
  }

  clearCaptions(): void {
    this.fakeCap.classList.remove('on')
    this.lineCap.classList.remove('on')
    this.fakeTimer = 0
    this.lineTimer = 0
  }

  showCard(card: CardSpec): void {
    clearTimeout(this.cardClear)
    if (!this.card.classList.contains('on')) {
      uiSound('uiPaper')
    }
    this.card.className = `ow-card ow-card-${card.kind} on`
    this.cardTitle.textContent = card.title
    this.cardBig.textContent = card.big
    this.cardSub.textContent = card.sub
    this.cardHint.textContent = card.hint
    this.cardPay.textContent = ''
    this.cardTimes(null)
    this.cardStamp(null)
  }

  /** "YOU 412 ms · HIM 318 ms" and the verdict ("94 ms too slow", "You never drew."); null clears. */
  cardTimes(t: CardTimes | null): void {
    renderTimes(this.cardTimesEl, t)
  }

  /** A red stamp across the card (a trick shot: "HAT SHOT"); null clears. */
  cardStamp(text: string | null): void {
    this.cardStampEl.textContent = text ?? ''
    if (text) {
      uiSound('uiStamp')
    }
  }

  /** The stamped wanted poster on the coward card. */
  cardPoster(src: string): void {
    uiSound('uiStamp')
    this.cardBig.innerHTML = ''
    const img = el('img', '', this.cardBig)
    img.alt = 'Wanted poster stamped: drew early, no bounty'
    img.src = src
  }

  /** "RANKED", "Practice", "BOUNTY HUNT"; a line still connecting ("…") stays up through the duel. */
  setMode(text: string): void {
    this.mode.textContent = text
    this.mode.classList.toggle('ranked', text === 'RANKED')
    this.mode.classList.toggle('alert', text.endsWith('…'))
  }

  /**
   * The duel's phase, on the root: from the cocking to the kill the CSS clears the counter, purse
   * and mode badge off the street (out-west.css), so only the duel is on screen.
   */
  phase(p: string): void {
    this.root.dataset.duel = p
  }

  /** The payout line on the result card, e.g. "+$150 · 212 ms draw bonus +$37". */
  cardPayout(text: string): void {
    this.cardPay.textContent = text
  }

  /** Set the purse; `animate` counts up (or down) gently instead of snapping. */
  setPurse(total: number, animate: boolean): void {
    // an empty purse is nothing to show
    this.purse.classList.toggle('zero', total === 0)
    if (!animate) {
      this.purseShown = total
      this.purseTo = total
      this.purseFrom = total
      this.purseT = 1
      this.purseText.textContent = money(total)
      return
    }
    this.purseFrom = this.purseShown
    this.purseTo = total
    this.purseT = 0
    const cls = total >= this.purseFrom ? 'gain' : 'loss'
    this.purse.classList.remove('gain', 'loss')
    void this.purse.offsetWidth
    this.purse.classList.add(cls)
  }

  hideCard(): void {
    this.card.classList.remove('on')
    // once it has faded, empty it: a hidden card's old verdict must not linger in the page (or be
    // read out) during the next duel or a Bounty Hunt
    clearTimeout(this.cardClear)
    this.cardClear = setTimeout(() => {
      if (!this.card.classList.contains('on')) {
        for (const e of [this.cardTitle, this.cardBig, this.cardSub, this.cardHint, this.cardPay]) {
          e.textContent = ''
        }
        this.cardTimes(null)
        this.cardStamp(null)
      }
    }, CARD_FADE_MS)
  }

  letterbox(on: boolean): void {
    this.letterTop.classList.toggle('on', on)
    this.letterBot.classList.toggle('on', on)
  }

  whipPan(): void {
    this.whip.classList.remove('on')
    void this.whip.offsetWidth
    this.whip.classList.add('on')
  }

  irisRed(on: boolean): void {
    this.iris.classList.toggle('on', on)
  }

  update(dtMs: number): void {
    if (this.purseT < 1) {
      this.purseT = Math.min(1, this.purseT + dtMs / 1100)
      const k = 1 - (1 - this.purseT) ** 3
      this.purseShown = Math.round(this.purseFrom + (this.purseTo - this.purseFrom) * k)
      this.purseText.textContent = money(this.purseShown)
      if (this.purseT >= 1) {
        this.purse.classList.remove('gain', 'loss')
      }
    }
    if (this.fakeTimer > 0) {
      this.fakeTimer -= dtMs
      if (this.fakeTimer <= 0) {
        this.fakeCap.classList.remove('on')
      }
    }
    if (this.lineTimer > 0) {
      this.lineTimer -= dtMs
      if (this.lineTimer <= 0) {
        this.lineCap.classList.remove('on')
      }
    }
    if (this.callTimer > 0) {
      // DRAW! fades after its hold; the red edge stays until a shot is fired
      this.callTimer -= dtMs
      if (this.callTimer <= 0) {
        this.callCap.classList.remove('on')
        this.callCapClear = setTimeout(() => {
          if (!this.callCap.classList.contains('on')) {
            this.callCap.textContent = ''
          }
        }, CARD_FADE_MS)
      }
    }
  }

  // ---------------------------------------------------------------- menus

  /**
   * Paused: the ways out first, then the run's one rule (assist) and, with a keyboard, the keys.
   * Captions, toggle walk, sound and the rest live in the Settings sheet.
   */
  openMenu(
    s: Settings,
    handlers: {
      resume: () => void
      change: (s: Settings) => void
      restart: () => void
      /** Back to the hub, keeping the run's save (absent where there's no hub). */
      saloon?: () => void
      remap: (a: Action, done: (code: string) => void) => void
    },
  ): void {
    const m = this.menu
    m.innerHTML = ''
    m.classList.add('on')
    el('h2', 'ow-menu-title', m, 'Paused')
    const btns = el('div', 'ow-menu-btns', m)
    const resume = el('button', 'ow-btn ow-btn-primary', btns, 'Resume')
    resume.type = 'button'
    resume.addEventListener('click', handlers.resume)
    const settings = el('button', 'ow-btn', btns, 'Settings')
    settings.type = 'button'
    settings.addEventListener('click', () => openSettings(this.root, () => handlers.change(s)))
    const restart = el('button', 'ow-btn', btns, 'Restart')
    restart.type = 'button'
    restart.addEventListener('click', handlers.restart)
    if (handlers.saloon) {
      const saloon = el('button', 'ow-btn', btns, 'Quit')
      saloon.type = 'button'
      saloon.title = 'Back to the menu. Your run is saved.'
      saloon.addEventListener('click', handlers.saloon)
    }
    const list = el('div', 'ow-menu-list', m)
    const row = el('label', 'ow-toggle', list)
    const assist = el('input', '', row)
    assist.type = 'checkbox'
    assist.checked = s.assist
    el('span', 'ow-toggle-label', row, 'Assist')
    el('span', 'ow-toggle-hint', row, '150 ms extra to react. Shown on your results.')
    assist.addEventListener('change', () => {
      s.assist = assist.checked
      handlers.change(s)
    })
    // a phone has no keys to remap
    const keys = el('div', 'ow-keys desktop-only', m)
    el('div', 'ow-keys-title', keys, 'Keys · click to remap')
    const actions: [Action, string][] = [
      ['walk', 'Walk'],
      ['fire', 'Draw / fire'],
      ['pause', 'Pause'],
      ['retry', 'Retry'],
      ['skip', 'Skip poster'],
    ]
    for (const [a, label] of actions) {
      const r = el('div', 'ow-key-row', keys)
      el('span', '', r, label)
      const b = el('button', 'ow-key', r, s.keys[a].map(keyLabel).join(' / '))
      b.type = 'button'
      b.addEventListener('click', () => {
        b.textContent = 'press a key…'
        handlers.remap(a, (code) => {
          s.keys[a] = [code]
          b.textContent = keyLabel(code)
          handlers.change(s)
        })
      })
    }
    resume.focus()
  }

  /**
   * A yes/no sheet in place of the pause menu (e.g. abandoning a ranked run). `extra` is an
   * optional third button (e.g. bank the run first).
   */
  menuConfirm(spec: ConfirmSpec): void {
    renderConfirm(this.menu, spec)
  }

  closeMenu(): void {
    this.menu.classList.remove('on')
    this.menu.innerHTML = ''
  }

  get menuOpen(): boolean {
    return this.menu.classList.contains('on')
  }

  showEnd(rows: LedgerRow[], spec: EndSpec): void {
    const { stats, onAgain, onLegend, onBoard } = spec
    const e = this.end
    e.innerHTML = ''
    e.classList.add('on')
    el('h1', 'ow-end-line', e, 'Fastest hand in the West.')
    if (stats.cowardice >= 10) {
      el('div', 'ow-end-title', e, 'The Yellowest Hand in the West')
    }
    // the ledger scrolls inside its paper under a sticky header, so the page never cuts it off
    const table = el('table', 'ow-ledger', el('div', 'ow-ledger-wrap', e))
    const head = el('tr', '', el('thead', '', table))
    for (const h of ['#', 'Outlaw', 'Best', 'Grade', 'Tries', 'Bounty']) {
      el('th', '', head, h)
    }
    const body = el('tbody', '', table)
    rows.forEach((r, i) => {
      const tr = el('tr', '', body)
      el('td', '', tr, String(i + 1))
      el('td', '', tr, r.name)
      el('td', '', tr, r.ms === null ? '—' : `${Math.round(r.ms)} ms`)
      el('td', '', tr, r.grade)
      el('td', '', tr, String(r.attempts))
      el('td', '', tr, r.paid === null ? '—' : money(r.paid))
    })
    // the total sits under the scroll, so it stays in view without covering the last rows
    const foot = el('div', 'ow-ledger-foot', e)
    el('span', '', foot, 'Total earned')
    el('b', '', foot, money(stats.total))
    const s = el('div', 'ow-end-stats', e)
    el(
      'div',
      'ow-end-purse',
      s,
      stats.total >= stats.best && stats.total > 0
        ? 'A new best purse'
        : `Best ${money(stats.best)}`,
    )
    el(
      'div',
      '',
      s,
      `Average reaction: ${stats.avg === null ? '—' : `${Math.round(stats.avg)} ms`}`,
    )
    el(
      'div',
      '',
      s,
      stats.cowardice === 1 ? 'Drew early: 1 time' : `Drew early: ${stats.cowardice} times`,
    )
    if (stats.assist) {
      el('div', '', s, 'Assist mode was on (+150 ms).')
    }
    if (stats.legend) {
      el('div', '', s, 'Legend mode: the original 2019 speeds.')
    }
    const b = el('div', 'ow-menu-btns', e)
    // ranked: banking the purse comes first; practice: another run
    const submit = el(
      'button',
      stats.ranked ? 'ow-btn ow-btn-primary' : 'ow-btn',
      b,
      stats.ranked ? 'Submit to leaderboard' : 'Leaderboard',
    )
    submit.type = 'button'
    submit.addEventListener('click', onBoard)
    const again = el('button', stats.ranked ? 'ow-btn' : 'ow-btn ow-btn-primary', b, 'Play again')
    again.type = 'button'
    again.addEventListener('click', onAgain)
    if (stats.legendUnlocked) {
      const leg = el('button', 'ow-btn', b, 'Legend mode')
      leg.type = 'button'
      leg.addEventListener('click', () => {
        // a second click, not a single stray one: starting Legend leaves this ledger
        e.querySelector('.ow-end-confirm')?.remove()
        const note = el(
          'div',
          'ow-end-confirm',
          e,
          stats.ranked
            ? 'Legend mode starts a new run. Submit this run to the leaderboard first, or start anyway.'
            : 'Legend mode starts a new run. The 2019 speeds are faster.',
        )
        const row = el('div', 'ow-menu-btns ow-end-confirm-row', note)
        const yes = el('button', 'ow-btn ow-btn-primary', row, 'Start Legend run')
        yes.type = 'button'
        yes.addEventListener('click', onLegend)
        if (stats.ranked) {
          const submitFirst = el('button', 'ow-btn', row, 'Submit first')
          submitFirst.type = 'button'
          submitFirst.addEventListener('click', onBoard)
        }
        const no = el('button', 'ow-btn', row, 'Cancel')
        no.type = 'button'
        no.addEventListener('click', () => note.remove())
      })
    }
    if (spec.onSaloon) {
      const saloon = el('button', 'ow-btn', b, 'Back')
      saloon.type = 'button'
      saloon.addEventListener('click', spec.onSaloon)
    }
    ;(stats.ranked ? submit : again).focus()
  }

  hideEnd(): void {
    this.end.classList.remove('on')
  }

  setDebug(text: string | null): void {
    this.debug.classList.toggle('on', text !== null)
    if (text !== null) {
      this.debug.textContent = text
    }
  }
}
