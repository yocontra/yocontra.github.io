/**
 * THE LAST CHANCE SALOON: the hub after the title. Your gunslinger stands on the boardwalk at dusk;
 * over the street sit your poster strip (name, level, XP, purse, bounty), the mode tiles, the
 * account panel, the Outfitter, the ledger and the leaderboard. Signed out, single player works
 * fully and the online modes ask for a passkey.
 */
import type { MeResponse } from '../contract/economy.ts'
import { DEFAULT_LOADOUT, type Loadout, normalizeLoadout } from '../data/catalog.ts'
import { money } from '../data/economy.ts'
import { bountyForLevel, levelProgress, titleFor } from '../data/progression.ts'
import { fetchLedger, fetchMe } from '../net/api.ts'
import { currentPlayer, onAuthChange } from '../net/auth.ts'
import type { QueueMatch } from '../net/queue.ts'
// TEMP: stream G's Frontier entry point (ffa/client/), until it exists
import { mountFrontier } from '../stubs/frontier.ts'
import { mountAccount } from './account.ts'
import { type GauntletChoice, gauntletSheet, type Mode, ModeTiles } from './mode-select.ts'
import { QueueSheet } from './queue.ts'
import { button, el, signedMoney, swallow } from './sheet.ts'
import { mountStanding } from './standing.ts'
import { Outfitter } from './store.ts'

export interface HubDeps {
  /** True once the 3D game behind the hub has loaded. */
  ready: () => boolean
  /** Outlaw index a saved practice run would continue from. */
  continueAt: () => number
  /** Ranked runs are possible on this page load (no debug hash). */
  rankedOk: boolean
  /** Frame your gunslinger for the hub or the Outfitter. */
  stage: (shot: 'hub' | 'store') => void
  /** Dress your gunslinger (equipped loadout, or a preview). */
  dress: (l: Loadout) => void
  playGauntlet: (c: GauntletChoice) => void
  bountyHunt: (m: QueueMatch, xpBefore: number | null) => void
  /** A fresh Turnstile token for the queue. */
  token: () => Promise<string | null>
  openBoard: () => void
}

const LEDGER_LABEL: Record<string, string> = {
  // biome-ignore-start lint/style/useNamingConvention: ledger kinds are snake_case on the wire
  start_grant: 'Grubstake',
  gauntlet_clear: 'Gauntlet bounty',
  duel_win: 'Bounty Hunt win',
  duel_loss: 'Bounty Hunt loss',
  ghost_win: 'Ghost duel',
  ghost_royalty: 'Your ghost’s cut',
  ffa_kill_mint: 'Frontier kill',
  ffa_deposit: 'Banked in Frontier',
  ffa_strongbox: 'Strongbox',
  ffa_commission: 'Banker’s commission',
  store_purchase: 'Outfitter',
  level_reward: 'Level reward',
  admin_adjust: 'Adjustment',
  // biome-ignore-end lint/style/useNamingConvention: ledger kinds are snake_case on the wire
}

export class Hub {
  readonly root: HTMLElement
  private readonly deps: HubDeps
  private readonly strip: HTMLElement
  private readonly tiles: ModeTiles
  private readonly parent: HTMLElement
  private me = null as MeResponse | null
  private sheet = null as { dispose: () => void } | null
  private visible = false as boolean

  constructor(parent: HTMLElement, deps: HubDeps) {
    this.parent = parent
    this.deps = deps
    this.root = el('div', 'ow-hub', parent)
    this.root.setAttribute('aria-label', 'The Last Chance Saloon')
    swallow(this.root)
    const top = el('header', 'ow-hub-top', this.root)
    el('div', 'ow-hub-sign', top, 'The Last Chance Saloon')
    this.strip = el('div', 'ow-hub-strip', top)
    const side = el('div', 'ow-hub-side', this.root)
    this.tiles = new ModeTiles(side, (m) => this.pick(m))
    const links = el('div', 'ow-hub-links', side)
    button(links, 'Leaderboard', () => deps.openBoard())
    button(links, 'Ledger', () => this.openLedger())
    button(links, 'Account', () => this.openAccount())
    onAuthChange(() => {
      this.refresh().catch(() => undefined)
    })
  }

  show(): void {
    this.visible = true
    this.root.classList.add('on')
    this.deps.stage('hub')
    this.render()
    this.refresh().catch(() => undefined)
  }

  hide(): void {
    this.visible = false
    this.root.classList.remove('on')
  }

  /** The 3D game finished loading behind us. */
  gameReady(): void {
    this.render()
    if (this.visible) {
      this.deps.stage('hub')
      this.dressEquipped()
    }
  }

  get profile(): MeResponse | null {
    return this.me
  }

  get loadout(): Loadout {
    return normalizeLoadout(this.me?.loadout ?? DEFAULT_LOADOUT)
  }

  private dressEquipped(): void {
    if (this.deps.ready()) {
      this.deps.dress(this.loadout)
    }
  }

  /** Reload your profile from the server (after sign-in, a duel, a purchase). */
  async refresh(): Promise<void> {
    if (!currentPlayer()) {
      this.me = null
      this.render()
      this.dressEquipped()
      return
    }
    const r = await fetchMe()
    this.me = r.ok ? r.value : null
    this.render()
    this.dressEquipped()
  }

  private render(): void {
    const signedIn = currentPlayer() !== null
    this.tiles.update({ signedIn, ready: this.deps.ready(), continueAt: this.deps.continueAt() })
    this.strip.replaceChildren()
    const me = this.me
    if (!me) {
      el('div', 'ow-hub-name', this.strip, signedIn ? (currentPlayer()?.name ?? '') : 'Stranger')
      el(
        'div',
        'ow-hub-meta',
        this.strip,
        signedIn ? 'Couldn’t reach the bank. Single player still works.' : 'Playing as a guest',
      )
      if (!signedIn) {
        button(this.strip, 'Sign in', () => this.openAccount(), true).classList.add('ow-hub-signin')
      }
      return
    }
    const prog = levelProgress(me.xp)
    el('div', 'ow-hub-name', this.strip, me.name)
    el('div', 'ow-hub-meta', this.strip, `Lv ${me.level} · ${me.title || titleFor(me.level)}`)
    const xp = el('div', 'ow-xp', this.strip)
    xp.setAttribute('role', 'progressbar')
    xp.setAttribute('aria-label', 'Experience')
    xp.setAttribute('aria-valuenow', String(prog.into))
    xp.setAttribute('aria-valuemax', String(prog.next))
    el('div', 'ow-xp-fill', xp).style.width =
      `${prog.next > 0 ? (prog.into / prog.next) * 100 : 100}%`
    const nums = el('div', 'ow-hub-nums', this.strip)
    el('span', 'ow-hub-purse', nums, money(me.purse))
    el('span', 'ow-hub-bounty', nums, `Bounty ${money(me.bounty || bountyForLevel(me.level))}`)
  }

  private pick(m: Mode): void {
    const signedIn = currentPlayer() !== null
    if (m === 'gauntlet') {
      if (!this.deps.ready()) {
        return
      }
      gauntletSheet(
        this.parent,
        { signedIn, ready: true, continueAt: this.deps.continueAt() },
        this.deps.rankedOk,
        (c) => {
          if (c) {
            this.hide()
            this.deps.playGauntlet(c)
          }
        },
      )
      return
    }
    if (m === 'store') {
      this.openStore()
      return
    }
    if (!signedIn) {
      this.openAccount()
      return
    }
    if (m === 'bounty') {
      this.openQueue()
    } else {
      this.hide()
      mountFrontier(this.parent, { onExit: () => this.show() })
    }
  }

  private openQueue(): void {
    if (!this.deps.ready()) {
      return
    }
    const xpBefore = this.me?.xp ?? null
    this.root.classList.add('dim')
    const q = new QueueSheet(this.parent, {
      token: () => this.deps.token(),
      matched: (match) => {
        this.root.classList.remove('dim')
        this.hide()
        this.deps.bountyHunt(match, xpBefore)
      },
      closed: () => this.root.classList.remove('dim'),
    })
    void q
  }

  /** Back from a duel: straight into the queue again for "Next bounty". */
  requeue(): void {
    this.show()
    this.openQueue()
  }

  private openStore(): void {
    if (!this.deps.ready()) {
      return
    }
    this.root.classList.add('shop')
    this.deps.stage('store')
    const store = new Outfitter(this.parent, {
      me: () => this.me,
      preview: (l) => this.deps.dress(l),
      changed: (patch) => {
        if (this.me) {
          this.me = { ...this.me, ...patch }
          this.render()
        }
      },
      close: () => {
        this.root.classList.remove('shop')
        this.deps.stage('hub')
      },
    })
    void store
  }

  private closeSheet(): void {
    this.sheet?.dispose()
    this.sheet = null
  }

  /** A panel over the hub with a close button; returns its body. */
  private panel(title: string): HTMLElement {
    this.closeSheet()
    const back = el('div', 'ow-sheet on', this.parent)
    back.setAttribute('role', 'dialog')
    back.setAttribute('aria-label', title)
    swallow(back)
    const panel = el('div', 'ow-hub-panel ow-sheet-panel', back)
    const head = el('div', 'ow-hub-row ow-sheet-head', panel)
    el('h2', 'ow-hub-h', head, title)
    button(head, 'Close', () => this.closeSheet())
    const body = el('div', 'ow-sheet-body', panel)
    back.addEventListener('click', (e) => {
      if (e.target === back) {
        this.closeSheet()
      }
    })
    this.sheet = { dispose: () => back.remove() }
    return body
  }

  private openAccount(): void {
    const body = this.panel('Your poster')
    const acct = mountAccount(body, { onClose: () => this.closeSheet() })
    mountStanding(body)
    const back = this.sheet
    this.sheet = {
      dispose: () => {
        acct.dispose()
        back?.dispose()
      },
    }
  }

  private openLedger(): void {
    const body = this.panel('Ledger')
    if (!currentPlayer()) {
      el('p', 'ow-hub-note', body, 'Sign in to keep a ledger: every dollar and every point of XP.')
      return
    }
    const note = el('p', 'ow-hub-note', body, 'Opening the books…')
    fetchLedger(15)
      .then((r) => {
        if (!r.ok) {
          note.textContent = r.error
          return
        }
        note.remove()
        const list = el('ul', 'ow-ledger-list', body)
        if (r.value.length === 0) {
          el('li', '', list, 'Nothing in the books yet.')
        }
        for (const row of r.value) {
          const li = el('li', '', list)
          el('span', '', li, LEDGER_LABEL[row.kind] ?? row.kind)
          el('b', row.amount < 0 ? 'neg' : 'pos', li, row.amount ? signedMoney(row.amount) : '')
          el('i', '', li, row.xp ? `+${row.xp} XP` : '')
          el('time', '', li, new Date(row.createdAt).toLocaleDateString())
        }
      })
      .catch(() => undefined)
  }
}
