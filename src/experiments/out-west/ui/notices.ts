/**
 * What the saloon tells you when you walk in: money that came in while you were away (your
 * ghost's royalties, Most Wanted placings), levels gained elsewhere and their rewards, and reward
 * items granted since you last looked (Hardin's Pair, the Midnight frame, the Yellow Hat, a dated
 * Most Wanted frame). One paper notice at a time, each dismissed once; the away report is
 * acknowledged on the server so it isn't told twice, the rest is remembered per account here.
 */
import type { AwayReport, MeResponse } from '../contract/economy.ts'
import { itemById } from '../data/catalog.ts'
import { levelRewards, titleFor } from '../data/progression.ts'
import { MOST_WANTED_FRAME, monthName } from '../data/sinks.ts'
import { currentPlayer } from '../net/auth.ts'
import { ackAway } from '../net/social.ts'
import { uiSound } from './sfx.ts'
import { button, el, signedMoney, swallow } from './sheet.ts'

interface Seen {
  level: number
  prestige: number
  rewards: string[]
}

const KEY = 'ow-seen:'

function load(accountId: string): Seen | null {
  try {
    const raw = localStorage.getItem(KEY + accountId)
    const v: unknown = raw ? JSON.parse(raw) : null
    if (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as Seen).level === 'number' &&
      Array.isArray((v as Seen).rewards)
    ) {
      return v as Seen
    }
  } catch {
    // private mode or a smudged entry: start over
  }
  return null
}

function store(accountId: string, seen: Seen): void {
  try {
    localStorage.setItem(KEY + accountId, JSON.stringify(seen))
  } catch {
    // private mode: notices may repeat next visit, nothing worse
  }
}

/** A results sheet already showed this level-up: the saloon won't tell it again. */
export function markLevelSeen(level: number): void {
  const id = currentPlayer()?.accountId
  if (!id) {
    return
  }
  const seen = load(id)
  if (seen && level > seen.level) {
    store(id, { ...seen, level })
  }
}

export interface Notice {
  title: string
  line: string
  amount?: number
}

/** "Your ghost gunned down 3 greenhorns while you were away: +$41". */
export function awayNotices(a: AwayReport | undefined): Notice[] {
  if (!a) {
    return []
  }
  const out: Notice[] = []
  if (a.royalties.count > 0) {
    const n = a.royalties.count
    out.push({
      title: 'While you were away',
      line: `Your ghost won ${n} ${n === 1 ? 'duel' : 'duels'}.`,
      amount: a.royalties.amount,
    })
  }
  for (const w of a.mostWanted) {
    out.push({
      title: `Most Wanted, ${monthName(w.month)}`,
      line: `You finished #${w.rank}. Your dated frame is in the Outfitter.`,
    })
  }
  return out
}

const isReward = (id: string): boolean =>
  id === MOST_WANTED_FRAME || itemById(id)?.rarity === 'reward'

/** A reward's name, including the dated frame the catalog may not list yet. */
const rewardName = (id: string): string =>
  itemById(id)?.name ?? (id === MOST_WANTED_FRAME ? 'Most Wanted frame (dated)' : id)

/** Levels gained and reward items granted since this device last saw the profile. */
export function progressNotices(me: MeResponse): Notice[] {
  const seen = load(me.accountId)
  const rewards = me.owned.filter(isReward)
  store(me.accountId, { level: me.level, prestige: me.prestige, rewards })
  if (!seen) {
    // the first visit on this device is the baseline
    return []
  }
  const out: Notice[] = []
  if (seen.prestige === me.prestige && me.level > seen.level) {
    out.push({
      title: `Level ${me.level}`,
      line: `New title: ${titleFor(me.level)}.`,
      amount: levelRewards(seen.level, me.level),
    })
  }
  for (const id of rewards) {
    if (!seen.rewards.includes(id)) {
      const item = itemById(id)
      out.push({
        title: 'Reward earned',
        line: `${rewardName(id)}${item?.unlock ? `: ${item.unlock}` : ''}. Equip it in the Outfitter.`,
      })
    }
  }
  return out
}

/** The away report already shown this page (its `asOf`): never shown twice before the ack lands. */
let shownAsOf = 0

interface Queued extends Notice {
  /** Dismissing this one acknowledges the away report up to here. */
  ack?: AwayReport
}

/** Notices waiting their turn, oldest first. One shows at a time, never over another sheet. */
const queue: Queued[] = []
let showing = false as boolean
let poll: ReturnType<typeof setInterval> | undefined

/** Anything else on screen that a notice must not stack on: a sheet, the Outfitter, a duel. */
const BUSY = '.ow-sheet:not(.ow-feat-notice), .ow-store, .ow-match'

function clear(root: HTMLElement): boolean {
  return root.querySelector('.ow-hub.on') !== null && root.querySelector(BUSY) === null
}

/** Show the next notice once the saloon is clear; check again every half second until it is. */
function pump(root: HTMLElement): void {
  if (showing || queue.length === 0) {
    clearInterval(poll)
    poll = undefined
    return
  }
  if (!clear(root)) {
    poll ??= setInterval(() => pump(root), 500)
    return
  }
  clearInterval(poll)
  poll = undefined
  const n = queue.shift()
  if (n) {
    showing = true
    paper(root, n, () => {
      showing = false
      pump(root)
    })
  }
}

/** One notice on Gazette stock, dismissed with "OK". */
function paper(root: HTMLElement, n: Queued, done: () => void): void {
  const back = el('div', 'ow-sheet on ow-feat-notice', root)
  back.setAttribute('role', 'alertdialog')
  back.setAttribute('aria-label', n.title)
  swallow(back)
  const panel = el('div', 'ow-hub-panel ow-sheet-panel ow-paper-doc', back)
  el('div', 'ow-results-kicker', panel, 'The Perdition Gazette')
  el('h2', 'ow-hub-h', panel, n.title)
  el('p', 'ow-feat-news-line', panel, n.line)
  if (n.amount) {
    el('p', 'ow-hub-note', panel, `Added to your purse: ${signedMoney(n.amount)}`)
  }
  if (queue.length > 0) {
    el('p', 'ow-hub-note ow-feat-news-more', panel, `${queue.length} more after this.`)
  }
  uiSound('uiStamp')
  const row = el('div', 'ow-hub-row', panel)
  const ok = button(
    row,
    'OK',
    () => {
      back.remove()
      const a = n.ack
      if (a && (a.total > 0 || a.mostWanted.length > 0)) {
        ackAway(a.asOf).catch(() => undefined)
      }
      done()
    },
    true,
  )
  ok.focus()
}

/**
 * Queue what the saloon has to tell you (nothing when there's nothing new). Each notice shows on
 * its own, one after another, and waits while a sheet, the Outfitter or a duel is up, so signing
 * in never piles papers on the account sheet. Dismissing the last away notice acknowledges the
 * away report up to its `asOf`, so money arriving later is still reported next time.
 */
export function showNotices(root: HTMLElement, me: MeResponse): void {
  const away = me.away && me.away.asOf > shownAsOf ? me.away : undefined
  const fromAway: Queued[] = awayNotices(away)
  if (away) {
    shownAsOf = away.asOf
    const last = fromAway.at(-1)
    if (last) {
      last.ack = away
    }
  }
  queue.push(...fromAway, ...progressNotices(me))
  pump(root)
}
