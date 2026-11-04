/**
 * First spawn, made foolproof. The How to play card shows the first time you ride in on this
 * device (and from the pause menu any time): four short steps, skippable, laid out for the
 * keyboard or for thumbs. Then contextual coach lines, each once per device:
 *
 * - the first time you carry money: follow the $ marker to a bank window;
 * - the first time you stand at a bank window with money: how to bank;
 * - the first time you die carrying: what you lost, and to bank sooner;
 * - the first deposit: it's safe in your purse now.
 *
 * Copy follows the copy pass: "purse" is banked money, "carried" is money at risk, "bank window".
 */
import { DESKTOP_HELP, PAD_HELP, TOUCH_HELP } from './bindings.ts'
import { type CoachFlag, coachSeen, markCoach } from './settings.ts'

interface Step {
  title: string
  body: string
  /** The HUD element this step points at (a glow), if any. */
  focus?: string
  keys?: boolean
}

const money = (n: number): string => `$${Math.max(0, Math.round(n)).toLocaleString('en-US')}`

function steps(touch: boolean): Step[] {
  return [
    {
      title: 'Move',
      body: touch
        ? 'Left thumb moves. Drag on the right to look. Hide behind low cover.'
        : 'Click to use the mouse. Hide behind low cover.',
      keys: true,
    },
    {
      title: 'Shoot players',
      body: 'Everyone is an enemy. Kill a player to drop the money they carried.',
    },
    {
      title: 'Grab the money',
      body: 'Walk over a dropped bag to pick it up. Carried money is at risk.',
      focus: '.fr-tc',
    },
    {
      title: 'Bank it',
      body: 'Follow the $ marker to a bank window. Banked money is safe in your purse. If you die first, you drop it.',
      focus: '.fr-tc',
    },
  ]
}

export interface OnboardingHooks {
  /** The card opened or closed (the game pauses input and frees the mouse while it's up). */
  onOpen: (open: boolean) => void
}

export class Onboarding {
  private readonly hud: HTMLElement
  private readonly touch: boolean
  private readonly hooks: OnboardingHooks
  private readonly card: HTMLElement
  private readonly coachEl: HTMLElement
  private coachTimer: ReturnType<typeof setTimeout> | null = null
  private step = 0
  private readonly list: Step[]
  /** Flags already shown this visit (also stops a repeat before storage answers). */
  private readonly shownNow = new Set<CoachFlag>()

  constructor(root: HTMLElement, hud: HTMLElement, touch: boolean, hooks: OnboardingHooks) {
    this.hud = hud
    this.touch = touch
    this.hooks = hooks
    this.list = steps(touch)
    this.card = document.createElement('div')
    this.card.className = 'fr-howto fr-hit'
    this.card.setAttribute('role', 'dialog')
    this.card.setAttribute('aria-modal', 'true')
    this.card.setAttribute('aria-label', 'How to play')
    this.card.hidden = true
    root.append(this.card)
    this.coachEl = document.createElement('div')
    this.coachEl.className = 'fr-coach'
    this.coachEl.setAttribute('role', 'status')
    hud.append(this.coachEl)
  }

  get open(): boolean {
    return !this.card.hidden
  }

  /** Show How to play if this device hasn't seen it. Returns true if it opened. */
  maybeShow(): boolean {
    if (coachSeen('howto') || this.open) {
      return false
    }
    this.show()
    return true
  }

  show(): void {
    this.step = 0
    this.card.hidden = false
    this.render()
    this.hooks.onOpen(true)
  }

  close(): void {
    if (!this.open) {
      return
    }
    this.card.hidden = true
    this.focus(null)
    markCoach('howto')
    this.hooks.onOpen(false)
  }

  /** Enter / arrows / Esc while the card is up. Returns true when it used the key. */
  key(code: string): boolean {
    if (!this.open) {
      return false
    }
    if (code === 'Escape') {
      this.close()
    } else if (code === 'Enter' || code === 'ArrowRight' || code === 'Space') {
      this.next()
    } else if (code === 'ArrowLeft') {
      this.go(this.step - 1)
    } else {
      return false
    }
    return true
  }

  private next(): void {
    if (this.step >= this.list.length - 1) {
      this.close()
    } else {
      this.go(this.step + 1)
    }
  }

  private go(i: number): void {
    this.step = Math.max(0, Math.min(this.list.length - 1, i))
    this.render()
  }

  private focus(sel: string | undefined | null): void {
    for (const e of this.hud.querySelectorAll('.fr-coach-focus')) {
      e.classList.remove('fr-coach-focus')
    }
    if (sel) {
      this.hud.querySelector(sel)?.classList.add('fr-coach-focus')
    }
  }

  private render(): void {
    const s = this.list[this.step]
    if (!s) {
      return
    }
    const c = this.card
    c.replaceChildren()
    const inner = document.createElement('div')
    inner.className = 'fr-howto-card'
    const kicker = document.createElement('div')
    kicker.className = 'fr-howto-kicker'
    kicker.textContent = `How to play · ${this.step + 1} of ${this.list.length}`
    const h = document.createElement('h2')
    h.className = 'fr-howto-title'
    h.textContent = s.title
    const p = document.createElement('p')
    p.className = 'fr-howto-body'
    p.textContent = s.body
    inner.append(kicker, h, p)
    if (s.keys) {
      inner.append(this.keyTable())
    }
    const dots = document.createElement('div')
    dots.className = 'fr-howto-dots'
    for (let i = 0; i < this.list.length; i++) {
      const d = document.createElement('span')
      d.className = i === this.step ? 'on' : ''
      dots.append(d)
    }
    const row = document.createElement('div')
    row.className = 'fr-howto-row'
    const skip = button('Skip', 'fr-menu-quiet', () => this.close())
    const back = button('Back', 'fr-menu-quiet', () => this.go(this.step - 1))
    back.hidden = this.step === 0
    const last = this.step === this.list.length - 1
    const next = button(last ? 'Play' : 'Next', '', () => this.next())
    row.append(this.step === 0 ? skip : back, next)
    inner.append(dots, row)
    c.append(inner)
    this.focus(s.focus)
    next.focus({ preventScroll: true })
  }

  private keyTable(): HTMLElement {
    const t = document.createElement('dl')
    t.className = 'fr-howto-keys'
    const pad = typeof navigator.getGamepads === 'function' && navigator.getGamepads().some(Boolean)
    let rows = this.touch ? TOUCH_HELP : DESKTOP_HELP
    if (pad) {
      rows = PAD_HELP
    }
    for (const [k, what] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.textContent = what
      t.append(dt, dd)
    }
    return t
  }

  /** A short coach line over the play area (replaces any line already up). */
  coach(text: string, ms = 5000, tone = ''): void {
    this.coachEl.textContent = text
    this.coachEl.className = `fr-coach on ${tone}`.trim()
    if (this.coachTimer) {
      clearTimeout(this.coachTimer)
    }
    this.coachTimer = setTimeout(() => this.coachEl.classList.remove('on'), ms)
  }

  /** Show a one-time coach line; false if this device has seen it. */
  once(flag: CoachFlag, text: string, ms = 6000, tone = ''): boolean {
    if (this.shownNow.has(flag) || coachSeen(flag)) {
      return false
    }
    this.shownNow.add(flag)
    markCoach(flag)
    this.coach(text, ms, tone)
    return true
  }

  firstCarry(amount: number): void {
    this.once('carry', `You’re carrying ${money(amount)}. Follow the $ marker to bank it.`, 7000)
  }

  atWindow(): void {
    this.once(
      'bankPrompt',
      this.touch
        ? 'Tap BANK and hold still for 2 seconds.'
        : 'Press E and hold still for 2 seconds.',
      5000,
    )
  }

  diedCarrying(amount: number): void {
    this.once('deathMoney', `You lost ${money(amount)}. Bank sooner.`, 6000, 'red')
  }

  banked(amount: number): void {
    this.once('banked', `Banked ${money(amount)}. It’s safe in your purse.`, 5000, 'gold')
  }

  dispose(): void {
    if (this.coachTimer) {
      clearTimeout(this.coachTimer)
    }
    this.card.remove()
    this.coachEl.remove()
  }
}

function button(text: string, cls: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `fr-menu-item fr-hit ${cls}`.trim()
  b.textContent = text
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    fn()
  })
  return b
}
