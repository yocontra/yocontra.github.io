/**
 * Rounds: a goal and some closure on top of the endless town. Each player's session is cut into
 * 6-minute rounds of their own (the lobby itself never stops: lobbies stay persistent, and this
 * costs the server nothing). A small clock sits under the money readout; with a minute left it
 * says to bank what you carry. At the bell a summary card shows what the round came to: dollars
 * banked, kills, deaths, best streak and XP, against your best round, then "Ride again" starts the
 * next one in place (no trip to the saloon).
 *
 * In the practice town the summary freezes the town while it's up (a loopback-only message), and
 * the finished round goes into your record, so the bots read a little sharper next round. In a
 * live lobby the town can't stop for you: the card waits for a natural pause (your death or your
 * next deposit, or 20 seconds of overtime) before it opens.
 *
 * Also hosts the first-bank objective chain and the bank moment (`objectives.ts`).
 */
import type { AudioEngine } from '../../audio/audio.ts'
import { KILL_DEAD_EYE, KILL_FARMED, KILL_PARDON, type ServerControl } from '../../contract/town.ts'
import { FFA_XP, ffaBankXp } from '../../data/progression.ts'
import { PRACTICE_BOT_KILL_XP } from '../sim/constants.ts'
import { BOT_KILL_XP } from '../sim/death.ts'
import type { SimEvent } from '../sim/types.ts'
import { Objectives } from './objectives.ts'
import {
  type FrontierRecord,
  loadRecord,
  PRACTICE_PURSE_CAP,
  patchRecord,
  practiceOptions,
} from './practice.ts'
import './round.css'

/** One round, seconds. */
export const ROUND_SECONDS = 360
/** The "bank what you carry" call, seconds before the bell. */
const LAST_CALL_S = 60
/** Live lobbies: the summary waits at most this long past the bell for a pause (s). */
const LIVE_OVERTIME_S = 20
const POLL_MS = 250

export interface RoundHost {
  practice: boolean
  audio: AudioEngine | null
  /** Your player id, whether you're alive, what you carry, your purse; whether an id is a bot. */
  you: () => number
  alive: () => boolean
  carried: () => number
  banked: () => number
  isBot: (id: number) => boolean
  /** Control text to the lobby (practice only: the loopback's pause and record messages). */
  send: (text: string) => void
  /** A line in the kill feed. */
  feed: (text: string) => void
  /** The summary opened or closed: input off while it's up. */
  onOpen: (open: boolean) => void
  /** "Leave town" from the summary. */
  leave: () => void
  /** True while something else owns the screen (How to play): the first round waits. */
  blocked: () => boolean
}

interface RoundStats {
  kills: number
  deaths: number
  banked: number
  streak: number
  best: number
  xp: number
}

const fresh = (): RoundStats => ({ kills: 0, deaths: 0, banked: 0, streak: 0, best: 0, xp: 0 })

const money = (n: number): string => `$${Math.max(0, Math.round(n)).toLocaleString('en-US')}`

function clock(s: number): string {
  const t = Math.max(0, Math.ceil(s))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  parent: HTMLElement | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) {
    e.textContent = text
  }
  parent?.append(e)
  return e
}

export class Rounds {
  private readonly host: RoundHost
  private readonly timerEl: HTMLElement
  private readonly card: HTMLElement
  readonly objectives: Objectives
  private stats = fresh()
  private round = 1
  /** performance.now() when this round's clock started, or −1 before the first one starts. */
  private startAt = -1
  private lastCall = false as boolean
  /** Live: the bell has rung and the card waits for a pause. */
  private pending = false as boolean
  private open = false as boolean
  private readonly poll: ReturnType<typeof setInterval>
  private lastText = ''

  constructor(root: HTMLElement, hud: HTMLElement, host: RoundHost) {
    this.host = host
    const record = loadRecord()
    this.timerEl = el('div', 'fr-round', hud)
    this.timerEl.setAttribute('aria-label', 'Round clock')
    this.card = el('div', 'fr-summary fr-hit', root)
    this.card.setAttribute('role', 'dialog')
    this.card.setAttribute('aria-modal', 'true')
    this.card.setAttribute('aria-label', 'Round summary')
    this.card.hidden = true
    this.objectives = new Objectives(hud, {
      practice: host.practice,
      audio: host.audio,
      done: record.firstBank,
    })
    this.poll = setInterval(() => this.update(), POLL_MS)
  }

  /** The summary card is up. */
  get summaryOpen(): boolean {
    return this.open
  }

  /** Dev and tests: the round's state. */
  get state(): {
    round: number
    left: number
    open: boolean
    objective: string | null
  } & RoundStats {
    return {
      round: this.round,
      left: this.left(),
      open: this.open,
      objective: this.objectives.current,
      ...this.stats,
    }
  }

  private left(): number {
    return this.startAt < 0
      ? ROUND_SECONDS
      : ROUND_SECONDS - (performance.now() - this.startAt) / 1000
  }

  private update(): void {
    const h = this.host
    this.objectives.poll(h.alive(), h.carried())
    if (this.open) {
      return
    }
    if (this.startAt < 0) {
      if (!h.blocked() && h.alive()) {
        this.startAt = performance.now()
      } else {
        return
      }
    }
    const left = this.left()
    const text = `Round ${this.round} · ${clock(left)}`
    if (text !== this.lastText) {
      this.lastText = text
      this.timerEl.textContent = text
    }
    this.timerEl.classList.add('on')
    this.timerEl.classList.toggle('late', left <= LAST_CALL_S)
    if (!this.lastCall && left <= LAST_CALL_S) {
      this.lastCall = true
      h.feed('One minute left in the round. Bank what you carry.')
    }
    if (left > 0) {
      return
    }
    if (h.practice || !h.alive() || left <= -LIVE_OVERTIME_S || h.carried() === 0) {
      this.end()
    } else if (!this.pending) {
      this.pending = true
      this.timerEl.textContent = `Round ${this.round} · overtime: bank it`
      this.lastText = ''
    }
  }

  /** Server events: your kills, deaths, deposits and strongboxes count toward the round. */
  event(ev: SimEvent): void {
    const you = this.host.you()
    if (ev.type === 'kill') {
      if (ev.victim === you) {
        this.stats.deaths++
        this.stats.streak = 0
        if (this.pending) {
          // let the death land before the card
          setTimeout(() => this.end(), 1200)
        }
      } else if (ev.killer === you) {
        this.objectives.killed()
        if ((ev.flags & (KILL_PARDON | KILL_FARMED)) === 0) {
          this.stats.kills++
          this.stats.streak++
          this.stats.best = Math.max(this.stats.best, this.stats.streak)
          this.stats.xp += this.killXp(ev.victim, ev.flags)
        }
      }
    } else if (ev.type === 'deposit' && ev.player === you) {
      this.stats.banked += ev.amount + ev.commission
      this.stats.xp += ffaBankXp(ev.amount) * FFA_XP.bankPer10
      const purse = this.host.banked() + ev.amount + ev.commission
      this.objectives.banked(
        ev.amount,
        ev.commission,
        this.host.practice ? Math.min(PRACTICE_PURSE_CAP, purse) : purse,
      )
      if (this.pending) {
        setTimeout(() => this.end(), 1600)
      }
    } else if (ev.type === 'strongbox_open' && ev.by === you) {
      this.stats.xp += FFA_XP.strongbox
    }
  }

  private killXp(victim: number, flags: number): number {
    if (this.host.isBot(victim)) {
      return this.host.practice ? PRACTICE_BOT_KILL_XP : BOT_KILL_XP
    }
    return FFA_XP.kill + (flags & KILL_DEAD_EYE ? FFA_XP.deadEyeKill : 0)
  }

  /** Control messages: a confirmed practice deposit updates the practice purse on this device. */
  control(m: ServerControl): void {
    if (m.type === 'deposit' && m.ok && this.host.practice) {
      patchRecord({ purse: Math.min(PRACTICE_PURSE_CAP, m.banked) })
    }
  }

  private end(): void {
    if (this.open) {
      return
    }
    this.pending = false
    const s = this.stats
    const before = loadRecord()
    const patch: Partial<FrontierRecord> = {
      bestBanked: Math.max(before.bestBanked, s.banked),
      bestKills: Math.max(before.bestKills, s.kills),
    }
    if (this.host.practice) {
      patch.rounds = before.rounds + 1
      patch.kills = before.kills + s.kills
      patch.deaths = before.deaths + s.deaths
      this.host.send(JSON.stringify({ type: 'practice_pause', on: true }))
    }
    const after = patchRecord(patch)
    this.show(before, after)
  }

  private show(before: FrontierRecord, after: FrontierRecord): void {
    const s = this.stats
    const c = this.card
    c.replaceChildren()
    const inner = el('div', 'fr-summary-card', c)
    el(
      'div',
      'fr-summary-kicker',
      inner,
      `${this.host.practice ? 'Practice town' : 'Perdition'} · Round ${this.round}`,
    )
    el('h2', 'fr-summary-title', inner, 'Round over')
    const hero = el('div', 'fr-summary-hero', inner)
    el('div', 'fr-summary-fig', hero, money(s.banked))
    el('div', 'fr-summary-label', hero, 'banked')
    const grid = el('dl', 'fr-summary-grid', inner)
    const row = (k: string, v: string): void => {
      const cell = el('div', 'fr-summary-cell', grid)
      el('dd', '', cell, v)
      el('dt', '', cell, k)
    }
    row('Kills', String(s.kills))
    row('Deaths', String(s.deaths))
    row('Best streak', String(s.best))
    row('XP', `+${s.xp}`)
    let note = `Best round: ${money(before.bestBanked)} banked.`
    if (s.banked > 0 && s.banked > before.bestBanked) {
      note = 'Your best round yet.'
    } else if (s.banked === 0) {
      note = 'Nothing banked this round. Bank sooner: carried money drops when you fall.'
    }
    el('p', 'fr-summary-note', inner, note)
    if (this.host.practice) {
      el(
        'p',
        'fr-summary-note quiet',
        inner,
        `Practice purse ${money(after.purse)}. Practice money stays on this device.`,
      )
    }
    const buttons = el('div', 'fr-summary-row', inner)
    const again = el('button', 'fr-menu-item fr-hit', buttons, 'Ride again')
    again.type = 'button'
    again.addEventListener('click', (e) => {
      e.stopPropagation()
      this.next()
    })
    const leave = el('button', 'fr-menu-item fr-hit fr-menu-quiet', buttons, 'Leave town')
    leave.type = 'button'
    leave.addEventListener('click', (e) => {
      e.stopPropagation()
      this.close()
      this.host.leave()
    })
    c.hidden = false
    this.open = true
    this.timerEl.classList.remove('on')
    this.host.onOpen(true)
    this.host.audio?.play('uiStamp', { gain: 0.6, priority: true })
    again.focus({ preventScroll: true })
  }

  private close(): void {
    if (!this.open) {
      return
    }
    this.card.hidden = true
    this.open = false
    if (this.host.practice) {
      this.host.send(JSON.stringify({ type: 'practice_pause', on: false }))
    }
    this.host.onOpen(false)
  }

  /** "Ride again": the next round, in place. The practice bots read the updated record. */
  next(): void {
    if (this.host.practice) {
      this.host.send(JSON.stringify({ type: 'practice_record', ...practiceOptions() }))
    }
    this.close()
    this.stats = fresh()
    this.round++
    this.startAt = performance.now()
    this.lastCall = false
    this.lastText = ''
  }

  /** Enter / Escape while the card is up. Returns true when it used the key. */
  key(code: string): boolean {
    if (!this.open) {
      return false
    }
    if (code === 'Enter' || code === 'Space' || code === 'Escape') {
      this.next()
      return true
    }
    return false
  }

  /** Dev harness: ring the bell now. */
  devEnd(): void {
    this.startAt = performance.now() - ROUND_SECONDS * 1000
    this.update()
  }

  dispose(): void {
    clearInterval(this.poll)
    this.objectives.dispose()
    this.timerEl.remove()
    this.card.remove()
  }
}
