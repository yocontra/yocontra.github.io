/**
 * The first minute, made obvious. Until you've banked once on this device, a small objective chain
 * sits under the money readout: shoot a rider → grab the bag → bank it, each step ticking off as
 * it happens (in the practice town the first deposit pays a $50 bonus, and it says so). While the
 * chain is on, the bank marker pulses even for a small carry.
 *
 * And every deposit gets its moment: a stamp in the middle of the screen counting up what you just
 * banked, with the bonus and your purse under it, a till ring and a shower of coins.
 */
import type { AudioEngine } from '../../audio/audio.ts'
import { PRACTICE_FIRST_BANK_BONUS } from '../sim/constants.ts'
import { patchRecord } from './practice.ts'
import { setGuideUrgent } from './wayfinding.ts'

type Step = 'shoot' | 'grab' | 'bank'

const money = (n: number): string => `$${Math.max(0, Math.round(n)).toLocaleString('en-US')}`

const STEPS: readonly Step[] = ['shoot', 'grab', 'bank']

function stepText(step: Step, practice: boolean): string {
  if (step === 'shoot') {
    return 'Shoot a rider. Everyone drops their money when they fall.'
  }
  if (step === 'grab') {
    return 'Grab the bag. Run over it.'
  }
  const how = 'stand still at the window'
  const bonus = practice ? ` First bank pays +${money(PRACTICE_FIRST_BANK_BONUS)}.` : ''
  return `Bank it. Follow the $ marker to a window and ${how}.${bonus}`
}

const COINS = 14

export class Objectives {
  private readonly el: HTMLElement
  private readonly kicker: HTMLElement
  private readonly text: HTMLElement
  private readonly stamp: HTMLElement
  private readonly practice: boolean
  private readonly audio: AudioEngine | null
  private step: Step | null
  private stampTimer: ReturnType<typeof setTimeout> | null = null
  private countRaf = 0

  constructor(
    hud: HTMLElement,
    opts: { practice: boolean; audio: AudioEngine | null; done: boolean },
  ) {
    this.practice = opts.practice
    this.audio = opts.audio
    this.el = document.createElement('div')
    this.el.className = 'fr-obj'
    this.el.setAttribute('role', 'status')
    this.kicker = document.createElement('div')
    this.kicker.className = 'fr-obj-kicker'
    this.text = document.createElement('div')
    this.text.className = 'fr-obj-text'
    this.el.append(this.kicker, this.text)
    this.stamp = document.createElement('div')
    this.stamp.className = 'fr-bankstamp'
    this.stamp.setAttribute('aria-live', 'polite')
    hud.append(this.el, this.stamp)
    this.step = opts.done ? null : 'shoot'
    this.render()
  }

  /** The chain is still running (you've never banked on this device). */
  get active(): boolean {
    return this.step !== null
  }

  /** Dev and tests: the step showing, or null once done. */
  get current(): Step | null {
    return this.step
  }

  private go(step: Step | null): void {
    if (step === this.step) {
      return
    }
    this.step = step
    this.render()
  }

  private render(): void {
    const s = this.step
    setGuideUrgent(s === 'bank')
    this.el.classList.toggle('on', s !== null)
    if (s === null) {
      return
    }
    const n = STEPS.indexOf(s)
    this.kicker.textContent = `First bank · ${n + 1} of ${STEPS.length}`
    this.text.textContent = stepText(s, this.practice)
    this.el.classList.remove('tick')
    // restart the arrival bump
    void this.el.offsetWidth
    this.el.classList.add('tick')
  }

  /** A few times a second: what you carry decides the step (a death puts you back to shooting). */
  poll(alive: boolean, carried: number): void {
    if (this.step === null || !alive) {
      return
    }
    if (carried > 0) {
      this.go('bank')
    } else if (this.step === 'bank') {
      this.go('shoot')
    }
  }

  /** You killed someone (paid or not): on to the bag. */
  killed(): void {
    if (this.step === 'shoot') {
      this.go('grab')
    }
  }

  /** Your deposit landed: finish the chain (once per device) and give it its moment. */
  banked(amount: number, commission: number, purse: number): void {
    if (this.step !== null) {
      this.go(null)
      patchRecord({ firstBank: true })
    }
    this.moment(amount, commission, purse)
  }

  private moment(amount: number, commission: number, purse: number): void {
    const s = this.stamp
    s.replaceChildren()
    const kick = document.createElement('div')
    kick.className = 'fr-bankstamp-kicker'
    kick.textContent = 'Banked'
    const fig = document.createElement('div')
    fig.className = 'fr-bankstamp-fig'
    fig.textContent = money(0)
    s.append(kick, fig)
    if (commission > 0) {
      const extra = document.createElement('div')
      extra.className = 'fr-bankstamp-extra'
      const bonus = this.practice && commission >= PRACTICE_FIRST_BANK_BONUS
      extra.textContent = `+${money(commission)} ${bonus ? 'first-bank bonus' : 'commission'}`
      s.append(extra)
    }
    const total = document.createElement('div')
    total.className = 'fr-bankstamp-purse'
    total.textContent = `${this.practice ? 'Practice purse' : 'Purse'} ${money(purse)}`
    s.append(total)
    for (let i = 0; i < COINS; i++) {
      const c = document.createElement('i')
      c.className = 'fr-coin'
      c.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 260)}px`)
      c.style.setProperty('--dy', `${Math.round(-60 - Math.random() * 120)}px`)
      c.style.setProperty('--d', `${Math.round(Math.random() * 180)}ms`)
      s.append(c)
    }
    s.classList.remove('on')
    void s.offsetWidth
    s.classList.add('on')
    this.audio?.play('register', { gain: 0.9, priority: true })
    // count up over 0.6 s
    const start = performance.now()
    const target = amount + commission
    cancelAnimationFrame(this.countRaf)
    const step = (now: number): void => {
      const k = Math.min(1, (now - start) / 600)
      fig.textContent = money(target * (1 - (1 - k) ** 3))
      if (k < 1) {
        this.countRaf = requestAnimationFrame(step)
      }
    }
    this.countRaf = requestAnimationFrame(step)
    if (this.stampTimer) {
      clearTimeout(this.stampTimer)
    }
    this.stampTimer = setTimeout(() => s.classList.remove('on'), 2200)
  }

  dispose(): void {
    setGuideUrgent(false)
    cancelAnimationFrame(this.countRaf)
    if (this.stampTimer) {
      clearTimeout(this.stampTimer)
    }
    this.el.remove()
    this.stamp.remove()
  }
}
