/**
 * THE LAST CHANCE SALOON: the hub after the title. Your gunslinger stands on the boardwalk at dusk;
 * over the street sit your poster strip (name, level, XP, purse, bounty), the mode tiles, the
 * account panel, the Outfitter, the ledger and the leaderboard. Signed out, single player works
 * fully and the online modes ask for a passkey.
 */
import type { LedgerKind, MeResponse } from '../contract/economy.ts'
import { townClosedCopy } from '../contract/town.ts'
import { DEFAULT_LOADOUT, type ItemId, type Loadout, normalizeLoadout } from '../data/catalog.ts'
import type { Dyes } from '../data/dye.ts'
import { money } from '../data/economy.ts'
import { licenceCopy, licenceStatus } from '../data/licence.ts'
import { bountyForLevel, canPrestige, levelProgress, titleFor } from '../data/progression.ts'
import { type LicensedMode, licenceWish, setLicenceWish } from '../meta/licence-wish.ts'
import { fetchLedger, fetchMe, fetchTownOpen } from '../net/api.ts'
import { currentPlayer, onAuthChange } from '../net/auth.ts'
import type { QueueMatch } from '../net/queue.ts'
import { mountAccount } from './account.ts'
import { hubTools, openMore } from './hub-more.ts'
import { icon } from './icons.ts'
import { mountBlocks, mountNameChange } from './identity.ts'
import type { HubMeta, HubMetaUi } from './meta-hub.ts'
import { type GauntletChoice, gauntletSheet, type Mode, ModeTiles } from './mode-select.ts'
import { showNotices } from './notices.ts'
import { QueueSheet } from './queue.ts'
import { openSaloon, rideAgain } from './saloon.ts'
import { openSettings } from './settings-sheet.ts'
import { announceLevel } from './sfx.ts'
import { button, el, panelSheet, setBar, signedMoney, swallow } from './sheet.ts'
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
  /** Dress your gunslinger (equipped loadout, or a preview), with your dye jobs. */
  dress: (l: Loadout, dyes: Dyes) => void
  /** The Outfitter's picture of one piece of kit (null until the game has loaded). */
  thumb: (id: ItemId) => HTMLCanvasElement | null
  playGauntlet: (c: GauntletChoice) => void
  bountyHunt: (m: QueueMatch, xpBefore: number | null) => void
  /** A fresh Turnstile token for the queue. */
  token: () => Promise<string | null>
  openBoard: () => void
  /** The meta-game: the Daily Outlaw tile, the Gauntlet map and Achievements, the guest purse. */
  meta?: HubMeta
}

/** Your profile as the hub holds it: `GET /me` plus the fields the server branch adds. */
type Me = MeResponse

const LEDGER_LABEL: Record<LedgerKind, string> = {
  // biome-ignore-start lint/style/useNamingConvention: ledger kinds are snake_case on the wire
  start_grant: 'Grubstake',
  gauntlet_clear: 'Gauntlet bounty',
  duel_win: 'Bounty Hunt win',
  duel_loss: 'Bounty Hunt loss',
  duel_draw: 'Standoff: dead heat',
  duel_froze: 'Standoff: both froze',
  ghost_win: 'Ghost duel',
  ghost_royalty: 'Your ghost’s cut',
  ffa_kill_mint: 'Frontier kill',
  ffa_deposit: 'Banked in Frontier',
  ffa_strongbox: 'Strongbox',
  ffa_commission: 'Banker’s commission',
  store_purchase: 'Outfitter',
  level_reward: 'Level reward',
  admin_adjust: 'Adjustment',
  dye_job: 'Dye job',
  name_change: 'Name change',
  house_round: 'A round for the house',
  medal: 'Medal',
  challenge: 'Challenge',
  daily_outlaw: 'Daily Outlaw',
  guest_migration: 'Guest purse',
  // biome-ignore-end lint/style/useNamingConvention: ledger kinds are snake_case on the wire
}

/** Kinds the server books that this contract version doesn't list yet (sinks). */
const SINK_LABEL: Readonly<Record<string, string>> = {
  // biome-ignore-start lint/style/useNamingConvention: ledger kinds are snake_case on the wire
  dye_job: 'Dye job',
  name_change: 'Name change',
  house_round: 'A round for the house',
  // biome-ignore-end lint/style/useNamingConvention: ledger kinds are snake_case on the wire
}

/** Your name on the plate, sized by its length so it always fits (see hub.css). */
function nameplate(strip: HTMLElement, name: string): void {
  el('div', 'ow-hub-name', strip, name).style.setProperty(
    '--ow-name-len',
    String(Math.max(1, [...name].length)),
  )
}

export class Hub {
  readonly root: HTMLElement
  private readonly deps: HubDeps
  private readonly strip: HTMLElement
  private readonly tiles: ModeTiles
  private readonly parent: HTMLElement
  private me = null as Me | null
  private sheet = null as { dispose: () => void } | null
  private visible = false as boolean
  private readonly metaUi: HubMetaUi | null
  /** A locked tile tapped while signed out: where signing in carries on to. */
  private afterSignIn = null as Mode | null

  constructor(parent: HTMLElement, deps: HubDeps) {
    this.parent = parent
    this.deps = deps
    this.root = el('div', 'ow-hub', parent)
    this.root.setAttribute('aria-label', 'The Last Chance Saloon')
    swallow(this.root)
    const top = el('header', 'ow-hub-top', this.root)
    this.strip = el('div', 'ow-hub-strip', top)
    hubTools(top, {
      account: () => this.openAccount(),
      settings: () => openSettings(this.parent),
    })
    const side = el('div', 'ow-hub-side', this.root)
    this.tiles = new ModeTiles(side, (m) => this.pick(m))
    this.metaUi = deps.meta?.mount(side) ?? null
    const meta = this.metaUi
    // the modes are the tiles; one row under them: the board, and More for everything else
    const links = el('div', 'ow-hub-links', side)
    button(links, 'Leaderboard', () => deps.openBoard())
    button(links, 'More', () =>
      openMore(this.parent, [
        ...(meta
          ? [
              { label: 'Gauntlet map', open: meta.map },
              { label: 'Achievements', open: meta.achievements },
            ]
          : []),
        {
          label: 'Chalkboard',
          open: () =>
            openSaloon(this.parent, {
              me: () => this.me,
              changed: (patch) => this.patch(patch),
            }),
        },
        { label: 'Ledger', open: () => this.openLedger() },
      ]),
    )
    onAuthChange(() => {
      this.refresh()
        .then(() => this.carryOn())
        .catch(() => undefined)
    })
  }

  show(): void {
    this.visible = true
    this.root.classList.add('on')
    this.deps.stage('hub')
    this.render()
    this.refresh()
      .then(() => this.licensedCarryOn(0))
      .catch(() => undefined)
    this.metaUi?.refresh()
  }

  /**
   * The licence road's end: back in the saloon with the licence a gate sent you to earn, carry on
   * into that mode. The server books clears a moment after the duel, so look again a few times.
   */
  private licensedCarryOn(tries: number): void {
    const wish = licenceWish()
    if (!(wish && this.visible && this.me)) {
      return
    }
    if (!licenceStatus(this.me.gauntletClears).licensed) {
      if (tries < 3) {
        setTimeout(() => {
          this.refresh()
            .then(() => this.licensedCarryOn(tries + 1))
            .catch(() => undefined)
        }, 1500)
      }
      return
    }
    setLicenceWish(null)
    this.pick(wish)
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

  /** Your dye jobs (none when signed out). */
  get dyes(): Dyes {
    return this.me?.dyes ?? {}
  }

  /** The server accepted a purchase, a dye, a name or a round. */
  private patch(p: Partial<Me>): void {
    if (this.me) {
      this.me = { ...this.me, ...p }
      this.render()
    }
  }

  get loadout(): Loadout {
    return normalizeLoadout(this.me?.loadout ?? DEFAULT_LOADOUT)
  }

  private dressEquipped(): void {
    if (this.deps.ready()) {
      this.deps.dress(this.loadout, this.dyes)
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
    this.me = r.ok ? (r.value as Me) : null
    if (this.me && this.visible) {
      // a level gained elsewhere (a ranked gauntlet), once the saloon shows it; Bounty Hunt's
      // results sheet has already played its own
      announceLevel(this.me.level)
      // royalties while you were away, levels and rewards gained since you last looked
      showNotices(this.parent, this.me)
    }
    this.render()
    this.dressEquipped()
  }

  private render(): void {
    const signedIn = currentPlayer() !== null
    this.tiles.update({ signedIn, ready: this.deps.ready(), continueAt: this.deps.continueAt() })
    this.strip.replaceChildren()
    const me = this.me
    if (!me) {
      nameplate(this.strip, signedIn ? (currentPlayer()?.name ?? '') : 'Stranger')
      // a guest's line only when it carries something (the guest purse); "Stranger" and the Sign
      // in button already say you're a guest
      const line = signedIn
        ? 'Couldn’t reach the server. Quick Draw still works.'
        : (this.deps.meta?.guestLine() ?? null)
      if (line) {
        el('div', 'ow-hub-meta', this.strip, line)
      }
      if (!signedIn) {
        button(this.strip, 'Sign in', () => this.openAccount(), true).classList.add('ow-hub-signin')
      }
      return
    }
    const prog = levelProgress(me.xp)
    nameplate(this.strip, me.name)
    const stars = me.prestige > 0 ? ` · ${'★'.repeat(me.prestige)}` : ''
    el(
      'div',
      'ow-hub-meta',
      this.strip,
      `Lv ${me.level} · ${me.title || titleFor(me.level)}${stars}`,
    ).setAttribute(
      'aria-label',
      `Level ${me.level}${me.prestige > 0 ? `, ${me.prestige} prestige stars` : ''}`,
    )
    const xp = el('div', 'ow-xp', this.strip)
    xp.setAttribute('role', 'progressbar')
    xp.setAttribute('aria-label', 'Experience')
    xp.setAttribute('aria-valuenow', String(prog.into))
    xp.setAttribute('aria-valuemax', String(prog.next))
    setBar(el('div', 'ow-xp-fill', xp), prog.next > 0 ? prog.into / prog.next : 1)
    const nums = el('div', 'ow-hub-nums', this.strip)
    const purse = el('span', 'ow-hub-purse', nums)
    purse.setAttribute('aria-label', `Purse ${money(me.purse)}`)
    purse.title = 'Purse: your money, won in duels. Spend it at the Outfitter.'
    purse.append(icon('money'), el('small', '', null, 'Purse'), money(me.purse))
    const bounty = el('span', 'ow-hub-bounty', nums)
    const b = money(me.bounty || bountyForLevel(me.level))
    bounty.setAttribute('aria-label', `Bounty ${b}`)
    bounty.title = 'Bounty: the price on your poster. It grows with your level and your win streak.'
    bounty.append(icon('bounty'), el('small', '', null, 'Bounty'), b)
    if (canPrestige(me.level, me.prestige)) {
      button(
        this.strip,
        'Ride again',
        () =>
          rideAgain(this.parent, me, (next) => {
            this.me = { ...this.me, ...next }
            this.render()
            this.refresh().catch(() => undefined)
          }),
        true,
      ).classList.add('ow-feat-prestige')
    }
  }

  /** Signed in from a locked tile: close the account sheet and go on into that mode. */
  private carryOn(): void {
    const m = this.afterSignIn
    if (m === null || !currentPlayer() || !this.visible) {
      return
    }
    this.afterSignIn = null
    this.closeSheet()
    this.pick(m)
  }

  /** Straight into a ranked run from outlaw 1 (the licence road), or the Quick Draw sheet. */
  private rideRanked(): void {
    if (this.deps.rankedOk && this.deps.ready()) {
      this.hide()
      this.deps.playGauntlet({ ranked: true, resume: false })
    } else {
      this.pick('gauntlet')
    }
  }

  /** Bounty Hunt and Frontier want the licence: say so, with the way to earn it, not a dead end. */
  private licenceGate(mode: LicensedMode, title: string, line: string): boolean {
    const me = this.me
    if (!me || licenceStatus(me.gauntletClears).licensed) {
      return false
    }
    const s = panelSheet(this.parent, { title, cls: 'ow-feat-gate' })
    const copy = licenceCopy(licenceStatus(me.gauntletClears))
    el('p', 'ow-hub-note', s.body, line)
    el('p', 'ow-hub-note', s.body, copy.progress ?? copy.kicker)
    const row = el('div', 'ow-hub-row', s.body)
    button(row, 'Not now', () => s.close())
    button(
      row,
      'Ride the ranked gauntlet',
      () => {
        s.close()
        // once licensed, the duel and the saloon carry on into the mode you wanted
        setLicenceWish(mode)
        this.rideRanked()
      },
      true,
    ).focus()
    return true
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
        { rankedOk: this.deps.rankedOk, ...(this.metaUi ? { map: this.metaUi.map } : {}) },
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
      // set after opening: opening closes any older sheet, whose cleanup clears it
      this.afterSignIn = m
      return
    }
    if (m === 'bounty') {
      this.openQueue()
    } else {
      this.openFrontier().catch(() => undefined)
    }
  }

  /**
   * Frontier runs on its own page: one WebGL context and render loop at a time, which matters on
   * phones. Leaving town returns straight to the saloon (`?saloon`). Before the trip: the licence
   * (the first three outlaws on a ranked run) and whether the town is open this month.
   */
  private async openFrontier(): Promise<void> {
    if (this.licenceGate('frontier', 'Frontier', 'Perdition is for licensed gunslingers only.')) {
      return
    }
    const open = await fetchTownOpen()
    if (open.ok && !open.value) {
      const s = panelSheet(this.parent, { title: 'Frontier', cls: 'ow-feat-gate' })
      el('p', 'ow-hub-note', s.body, townClosedCopy())
      return
    }
    location.assign('/experiments/out-west/frontier/?server=remote')
  }

  private openQueue(): void {
    if (!this.deps.ready()) {
      return
    }
    if (
      this.licenceGate('bounty', 'Bounty Hunt', 'Bounty Hunt is for licensed gunslingers only.')
    ) {
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
      rideRanked: () => {
        setLicenceWish('bounty')
        this.rideRanked()
      },
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
      preview: (l, dyes) => this.deps.dress(l, dyes ?? this.dyes),
      thumb: (id) => this.deps.thumb(id),
      changed: (patch) => this.patch(patch),
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

  /**
   * A panel over the hub with a close button (Escape and a tap outside close it too). `cleanup`
   * runs however it closes.
   */
  private panel(
    title: string,
    paper = false,
    cleanup: { run: () => void } | null = null,
  ): HTMLElement {
    this.closeSheet()
    const s = panelSheet(this.parent, {
      title,
      paper,
      onClose: () => {
        cleanup?.run()
        if (this.sheet === handle) {
          this.sheet = null
        }
      },
    })
    const handle = { dispose: () => s.close() }
    this.sheet = handle
    return s.body
  }

  private openAccount(): void {
    // the account panel holds a pending conditional sign-in: cancelled however the sheet closes
    const cleanup = { run: (): void => undefined }
    const body = this.panel('Account', false, cleanup)
    const acct = mountAccount(body, {
      onClose: () => this.closeSheet(),
      gauntletClears: this.me?.gauntletClears ?? null,
    })
    cleanup.run = () => {
      acct.dispose()
      // closed without signing in: the tapped tile stays locked
      if (!currentPlayer()) {
        this.afterSignIn = null
      }
    }
    mountStanding(body)
    if (this.me) {
      mountNameChange(body, this.me, (patch) => this.patch(patch))
      mountBlocks(body)
    }
  }

  private openLedger(): void {
    const body = this.panel('Ledger', true)
    if (!currentPlayer()) {
      el('p', 'ow-hub-note', body, 'Sign in to keep a ledger of your money and XP.')
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
          el('span', '', li, LEDGER_LABEL[row.kind] ?? SINK_LABEL[row.kind] ?? row.kind)
          el('b', row.amount < 0 ? 'neg' : 'pos', li, row.amount ? signedMoney(row.amount) : '')
          el('i', '', li, row.xp ? `+${row.xp} XP` : '')
          el('time', '', li, new Date(row.createdAt).toLocaleDateString())
        }
      })
      .catch(() => undefined)
  }
}
