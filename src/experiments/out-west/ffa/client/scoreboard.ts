/**
 * The scoreboard (hold Tab): everyone in town, ranked by kills since you rode in, with deaths, level
 * and the Most Wanted star. Kills and deaths are tallied from the kill feed this client has seen
 * (the server doesn't send a running score), so the header says so. Rebuilt only while open.
 */
import type { RosterEntry } from '../../contract/town.ts'
import { NONE } from '../../contract/town.ts'

interface Tally {
  kills: number
  deaths: number
}

export interface ScoreDeps {
  roster: () => ReadonlyMap<number, RosterEntry>
  you: () => number
  mostWanted: () => number
}

export class Scoreboard {
  private readonly el: HTMLElement
  private readonly body: HTMLElement
  private readonly deps: ScoreDeps
  private readonly tally = new Map<number, Tally>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(parent: HTMLElement, deps: ScoreDeps) {
    this.deps = deps
    this.el = document.createElement('div')
    this.el.className = 'fr-score'
    this.el.hidden = true
    const card = document.createElement('div')
    card.className = 'fr-score-card'
    const h = document.createElement('h2')
    h.className = 'fr-score-title'
    h.textContent = 'Scoreboard'
    const sub = document.createElement('div')
    sub.className = 'fr-score-sub'
    sub.textContent = 'Kills and deaths this match'
    this.body = document.createElement('div')
    this.body.className = 'fr-score-rows'
    card.append(h, sub, this.body)
    this.el.append(card)
    parent.append(this.el)
  }

  /** A kill from the feed. */
  kill(killer: number, victim: number): void {
    const v = this.get(victim)
    v.deaths++
    if (killer !== NONE && killer !== victim) {
      this.get(killer).kills++
    }
  }

  /** A rider left town: forget his line. */
  forget(id: number): void {
    this.tally.delete(id)
  }

  private get(id: number): Tally {
    let t = this.tally.get(id)
    if (!t) {
      t = { kills: 0, deaths: 0 }
      this.tally.set(id, t)
    }
    return t
  }

  get open(): boolean {
    return !this.el.hidden
  }

  show(on: boolean): void {
    if (on === this.open) {
      return
    }
    this.el.hidden = !on
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (on) {
      this.render()
      this.timer = setInterval(() => this.render(), 500)
    }
  }

  private render(): void {
    const you = this.deps.you()
    const mw = this.deps.mostWanted()
    const rows = [...this.deps.roster().values()].map((r) => ({
      r,
      t: this.tally.get(r.id) ?? { kills: 0, deaths: 0 },
    }))
    rows.sort((a, b) => b.t.kills - a.t.kills || a.t.deaths - b.t.deaths || a.r.id - b.r.id)
    const head = row('fr-score-row fr-score-head', ['', 'Player', 'Lvl', 'K', 'D'])
    const lines = rows.map(({ r, t }, i) => {
      const name = `${r.id === mw ? '★ ' : ''}${r.name}${r.bot ? ' (bot)' : ''}`
      const line = row(`fr-score-row${r.id === you ? ' you' : ''}`, [
        String(i + 1),
        name,
        String(r.level),
        String(t.kills),
        String(t.deaths),
      ])
      return line
    })
    this.body.replaceChildren(head, ...lines)
  }

  dispose(): void {
    this.show(false)
    this.el.remove()
  }
}

function row(cls: string, cells: readonly string[]): HTMLElement {
  const r = document.createElement('div')
  r.className = cls
  for (const c of cells) {
    const s = document.createElement('span')
    s.textContent = c
    r.append(s)
  }
  return r
}
