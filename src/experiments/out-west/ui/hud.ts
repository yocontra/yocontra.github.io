import { type Action, keyLabel } from '../engine/input'
import type { Settings } from '../save'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  parent: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  parent.appendChild(e)
  return e
}

export interface LedgerRow {
  name: string
  ms: number | null
  grade: string
  attempts: number
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
  private readonly letterTop: HTMLElement
  private readonly letterBot: HTMLElement
  private readonly whip: HTMLElement
  private readonly iris: HTMLElement
  readonly pauseBtn: HTMLButtonElement
  readonly menu: HTMLElement
  readonly end: HTMLElement
  readonly debug: HTMLElement
  private readonly callIndicator: HTMLElement
  private fakeTimer = 0
  private lineTimer = 0
  private callTimer = 0
  captions = true

  constructor(root: HTMLElement) {
    this.root = root
    const hud = el('div', 'ow-hud', root)
    this.counter = el('div', 'ow-counter', hud)
    this.pauseBtn = el('button', 'ow-pause', hud)
    this.pauseBtn.type = 'button'
    this.pauseBtn.setAttribute('aria-label', 'Pause')
    this.pauseBtn.innerHTML = '<span></span><span></span>'
    this.pips = el('div', 'ow-pips', hud)
    this.letterTop = el('div', 'ow-letter ow-letter-top', root)
    this.letterBot = el('div', 'ow-letter ow-letter-bot', root)
    this.callIndicator = el('div', 'ow-call-indicator', root)
    this.callCap = el('div', 'ow-cap-call', root)
    this.callCap.setAttribute('role', 'status')
    this.fakeCap = el('div', 'ow-cap-fake', root)
    this.lineCap = el('div', 'ow-cap-line', root)
    this.card = el('div', 'ow-card', root)
    this.cardTitle = el('div', 'ow-card-title', this.card)
    this.cardBig = el('div', 'ow-card-big', this.card)
    this.cardSub = el('div', 'ow-card-sub', this.card)
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

  setCounter(i: number, total: number, legend: boolean): void {
    this.counter.textContent = `${legend ? 'LEGEND · ' : ''}${i + 1} / ${total}`
  }

  setPips(n: number, visible: boolean): void {
    this.pips.classList.toggle('on', visible)
    while (this.pips.children.length < n) {
      const p = el('span', 'ow-pip', this.pips)
      requestAnimationFrame(() => p.classList.add('in'))
    }
    while (this.pips.children.length > n) this.pips.lastChild?.remove()
  }

  call(text: string, ms: number): void {
    this.callCap.textContent = text
    this.callCap.classList.remove('on')
    void this.callCap.offsetWidth
    this.callCap.classList.add('on')
    this.callIndicator.classList.add('on')
    this.callTimer = ms
  }

  clearCall(): void {
    this.callCap.classList.remove('on')
    this.callIndicator.classList.remove('on')
    this.callTimer = 0
  }

  fake(text: string): void {
    if (!this.captions) return
    this.fakeCap.textContent = text
    this.fakeCap.classList.add('on')
    this.fakeTimer = 1800
  }

  line(who: string, text: string, ms = 2400): void {
    if (!this.captions) return
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

  showCard(
    kind: 'win' | 'lose' | 'coward' | 'info',
    title: string,
    big: string,
    sub: string,
    hint: string,
  ): void {
    this.card.className = `ow-card ow-card-${kind} on`
    this.cardTitle.textContent = title
    this.cardBig.textContent = big
    this.cardSub.textContent = sub
    this.cardHint.textContent = hint
  }

  hideCard(): void {
    this.card.classList.remove('on')
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
    if (this.fakeTimer > 0) {
      this.fakeTimer -= dtMs
      if (this.fakeTimer <= 0) this.fakeCap.classList.remove('on')
    }
    if (this.lineTimer > 0) {
      this.lineTimer -= dtMs
      if (this.lineTimer <= 0) this.lineCap.classList.remove('on')
    }
    if (this.callTimer > 0) {
      this.callTimer -= dtMs
      if (this.callTimer <= 0) this.clearCall()
    }
  }

  // ---------------------------------------------------------------- menus

  openMenu(
    s: Settings,
    handlers: {
      resume: () => void
      change: (s: Settings) => void
      restart: () => void
      remap: (a: Action, done: (code: string) => void) => void
    },
  ): void {
    const m = this.menu
    m.innerHTML = ''
    m.classList.add('on')
    el('h2', 'ow-menu-title', m, 'PAUSED')
    const list = el('div', 'ow-menu-list', m)
    const toggle = (key: keyof Omit<Settings, 'keys'>, label: string, hint: string) => {
      const row = el('label', 'ow-toggle', list)
      const input = el('input', '', row)
      input.type = 'checkbox'
      input.checked = s[key]
      el('span', 'ow-toggle-label', row, label)
      el('span', 'ow-toggle-hint', row, hint)
      input.addEventListener('change', () => {
        s[key] = input.checked
        handlers.change(s)
      })
    }
    toggle('reducedMotion', 'Reduced motion', 'No shake, zooms or flashes. Short kill cam.')
    toggle('captions', 'Captions', 'Sound captions and heckles.')
    toggle('toggleWalk', 'Toggle walk', 'Press once to start walking, again to stop.')
    toggle('assist', 'Assist', '+150 ms for every outlaw. Noted on the ledger.')
    toggle('mono', 'Mono audio', 'Fold the mix to one channel.')
    const keys = el('div', 'ow-keys', m)
    el('div', 'ow-keys-title', keys, 'KEYS (click to remap)')
    const actions: [Action, string][] = [
      ['walk', 'Walk'],
      ['fire', 'Draw / fire'],
      ['pause', 'Pause'],
      ['retry', 'Retry'],
      ['skip', 'Skip poster'],
    ]
    for (const [a, label] of actions) {
      const row = el('div', 'ow-key-row', keys)
      el('span', '', row, label)
      const b = el('button', 'ow-key', row, s.keys[a].map(keyLabel).join(' / '))
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
    const btns = el('div', 'ow-menu-btns', m)
    const resume = el('button', 'ow-btn ow-btn-primary', btns, 'Resume')
    resume.type = 'button'
    resume.addEventListener('click', handlers.resume)
    const restart = el('button', 'ow-btn', btns, 'Restart gauntlet')
    restart.type = 'button'
    restart.addEventListener('click', handlers.restart)
    resume.focus()
  }

  closeMenu(): void {
    this.menu.classList.remove('on')
    this.menu.innerHTML = ''
  }

  get menuOpen(): boolean {
    return this.menu.classList.contains('on')
  }

  showEnd(
    rows: LedgerRow[],
    stats: {
      cowardice: number
      avg: number | null
      assist: boolean
      legend: boolean
      legendUnlocked: boolean
    },
    onAgain: () => void,
    onLegend: () => void,
  ): void {
    const e = this.end
    e.innerHTML = ''
    e.classList.add('on')
    el('h1', 'ow-end-line', e, 'YOU’RE THE FASTEST HAND IN THE WEST!')
    if (stats.cowardice >= 10) el('div', 'ow-end-title', e, 'The Yellowest Hand in the West')
    const table = el('table', 'ow-ledger', e)
    const head = el('tr', '', el('thead', '', table))
    for (const h of ['#', 'Outlaw', 'Best', 'Grade', 'Tries']) el('th', '', head, h)
    const body = el('tbody', '', table)
    rows.forEach((r, i) => {
      const tr = el('tr', '', body)
      el('td', '', tr, String(i + 1))
      el('td', '', tr, r.name)
      el('td', '', tr, r.ms === null ? '—' : `${Math.round(r.ms)} ms`)
      el('td', '', tr, r.grade)
      el('td', '', tr, String(r.attempts))
    })
    const s = el('div', 'ow-end-stats', e)
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
      stats.cowardice === 1 ? '1 man shot in the back' : `${stats.cowardice} men shot in the back`,
    )
    if (stats.assist) el('div', '', s, 'Assist mode was on (+150 ms).')
    if (stats.legend) el('div', '', s, 'LEGEND MODE — the 2019 curve. Respect.')
    const b = el('div', 'ow-menu-btns', e)
    const again = el('button', 'ow-btn ow-btn-primary', b, 'Play again')
    again.type = 'button'
    again.addEventListener('click', onAgain)
    if (stats.legendUnlocked) {
      const leg = el('button', 'ow-btn', b, 'Legend mode')
      leg.type = 'button'
      leg.addEventListener('click', onLegend)
    }
  }

  hideEnd(): void {
    this.end.classList.remove('on')
  }

  setDebug(text: string | null): void {
    this.debug.classList.toggle('on', text !== null)
    if (text !== null) this.debug.textContent = text
  }
}
