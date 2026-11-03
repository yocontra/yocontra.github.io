/**
 * What the saloon tells you when you walk in: money that came in while you were away (your
 * ghost's royalties, Most Wanted placings), levels gained elsewhere and their rewards, and reward
 * items granted since you last looked (Hardin's Pair, the Midnight frame, the Yellow Hat, a dated
 * Most Wanted frame). One paper notice, dismissed once; the away report is acknowledged on the
 * server so it isn't told twice, the rest is remembered per account on this device.
 */
import type { MeResponse } from '../contract/economy.ts'
import { itemById } from '../data/catalog.ts'
import { money } from '../data/economy.ts'
import { levelRewards, titleFor } from '../data/progression.ts'
import { currentPlayer } from '../net/auth.ts'
import { ackAway } from '../net/social.ts'
import { type AwayReport, type MeExtras, MOST_WANTED_FRAME, monthName } from '../net/wire-social.ts'
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
      line: `Your ghost gunned down ${n} ${n === 1 ? 'greenhorn' : 'greenhorns'}.`,
      amount: a.royalties.amount,
    })
  }
  for (const w of a.mostWanted) {
    out.push({
      title: `Most Wanted, ${monthName(w.month)}`,
      line: `You finished #${w.rank}. A dated Most Wanted frame is in your Outfitter.`,
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
      line: `${titleFor(me.level)}. A level-up pays $25 × the new level.`,
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

/**
 * Show the notices over the saloon (nothing when there are none). Dismissing acknowledges the
 * away report up to its `asOf`, so money arriving later is still reported next time.
 */
/** The away report already shown this page (its `asOf`): never shown twice before the ack lands. */
let shownAsOf = 0

export function showNotices(root: HTMLElement, me: MeResponse & MeExtras): void {
  if (root.querySelector('.ow-feat-notice')) {
    return
  }
  const away = me.away && me.away.asOf > shownAsOf ? me.away : undefined
  const notes = [...awayNotices(away), ...progressNotices(me)]
  if (notes.length === 0) {
    return
  }
  if (away) {
    shownAsOf = away.asOf
  }
  const back = el('div', 'ow-sheet on ow-feat-notice', root)
  back.setAttribute('role', 'alertdialog')
  back.setAttribute('aria-label', 'News at the saloon')
  swallow(back)
  const panel = el('div', 'ow-hub-panel ow-sheet-panel ow-paper-doc', back)
  el('div', 'ow-results-kicker', panel, 'The Perdition Gazette')
  el('h2', 'ow-hub-h', panel, 'News at the saloon')
  const list = el('ul', 'ow-ledger-list ow-feat-news', panel)
  for (const n of notes) {
    const li = el('li', '', list)
    const text = el('span', '', li)
    el('b', 'ow-feat-news-title', text, n.title)
    el('span', 'ow-feat-news-line', text, n.line)
    el('b', 'pos', li, n.amount ? signedMoney(n.amount) : '')
  }
  const total = notes.reduce((t, n) => t + (n.amount ?? 0), 0)
  if (total > 0) {
    el('p', 'ow-hub-note', panel, `Already in your purse: ${money(total)}.`)
  }
  uiSound('uiStamp')
  const row = el('div', 'ow-hub-row', panel)
  const ok = button(
    row,
    'Much obliged',
    () => {
      back.remove()
      if (away && (away.total > 0 || away.mostWanted.length > 0)) {
        ackAway(away.asOf).catch(() => undefined)
      }
    },
    true,
  )
  ok.focus()
}
