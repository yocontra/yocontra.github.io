/**
 * Who's in town, and the poster behind every name (spec §11.4: Report and Block on every poster).
 * The HUD's head count opens the riders list; the death card opens your killer's poster. Your
 * block list is read once at the start: a blocked player's call-out is never shown to you (the
 * server refuses to pair you anyway). The practice town (loopback) has no accounts behind its
 * names, so none of this applies there.
 */
import '../../ui/tokens.css'
import '../../ui/controls.css'
import '../../ui/sheets.css'
import '../../ui/pvp.css'
import '../../ui/features.css'
import type { RosterEntry } from '../../contract/town.ts'
import { currentPlayer } from '../../net/auth.ts'
import { blockedNames } from '../../net/social.ts'
import { openProfile } from '../../ui/profile.ts'
import { button, el, panelSheet } from '../../ui/sheet.ts'

export interface RidersDeps {
  /** Where the sheets mount (the HUD root). */
  root: HTMLElement
  roster: () => ReadonlyMap<number, RosterEntry>
  you: () => number
  lobbyId: () => string
}

export class Riders {
  private readonly deps: RidersDeps
  private blocked: ReadonlySet<string> = new Set()

  constructor(deps: RidersDeps) {
    this.deps = deps
    this.reload()
  }

  /** Accounts stand behind the names (not the practice town), and you're signed in. */
  get live(): boolean {
    return this.deps.lobbyId() !== 'loopback' && currentPlayer() !== null
  }

  private reload(): void {
    if (currentPlayer() === null) {
      return
    }
    blockedNames()
      .then((b) => {
        this.blocked = b
      })
      .catch(() => undefined)
  }

  /** True when the player behind entity `id` is on your block list. */
  isBlocked(id: number): boolean {
    const name = this.deps.roster().get(id)?.name
    return name !== undefined && this.blocked.has(name.toLowerCase())
  }

  /** The person (not a bot, not you) behind entity `id`, if any. */
  person(id: number): RosterEntry | null {
    const r = this.deps.roster().get(id)
    return r && !r.bot && id !== this.deps.you() ? r : null
  }

  /** `name`'s poster, with Report and Block when this is a live town. */
  poster(name: string): void {
    openProfile(this.deps.root, name, {
      context: this.deps.lobbyId(),
      onBlockChange: () => this.reload(),
    })
  }

  /** The riders in town: every person's name, level and a way to their poster. */
  open(): void {
    const sheet = panelSheet(this.deps.root, { title: 'Players' })
    const people = [...this.deps.roster().values()]
      .filter((r) => !r.bot && r.id !== this.deps.you())
      .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name))
    const bots = this.deps.roster().size - people.length - 1
    el(
      'p',
      'ow-hub-note',
      sheet.body,
      people.length > 0
        ? 'Tap a name to see their poster, report or block.'
        : 'No other players. Only bots.',
    )
    const list = el('ul', 'ow-ledger-list ow-feat-record', sheet.body)
    for (const r of people) {
      const li = el('li', '', list)
      const name = el('button', 'ow-feat-name', li)
      name.type = 'button'
      const hidden = this.blocked.has(r.name.toLowerCase())
      name.textContent = hidden ? `${r.name} (blocked)` : r.name
      el('b', '', li, `Lv ${r.level}${r.prestige > 0 ? ` ${'★'.repeat(r.prestige)}` : ''}`)
      if (this.live) {
        name.addEventListener('click', (e) => {
          e.stopPropagation()
          this.poster(r.name)
        })
      } else {
        name.disabled = true
      }
    }
    if (bots > 0) {
      el('p', 'ow-hub-note', sheet.body, `Plus ${bots} bot${bots === 1 ? '' : 's'}.`)
    }
    const row = el('div', 'ow-hub-row', sheet.body)
    button(row, 'Close', () => sheet.close(), true)
  }
}
