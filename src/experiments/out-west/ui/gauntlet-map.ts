/**
 * The gauntlet map (meta-game stream): all seventeen outlaws down the street, each with his medal
 * (bronze, silver, gold and the times to beat), your best draw, and his challenge. Below: the
 * medal sets and the cosmetics they earn, and what your guest purse holds (or that your account
 * keeps it). Printed on the Gazette's paper stock, like the ledger.
 */
import { itemById } from '../data/catalog.ts'
import { money } from '../data/economy.ts'
import {
  CHALLENGES,
  GUEST_CAP,
  isClaim,
  MEDAL_MS,
  meetsReward,
  OUTLAW_COUNT,
  SOLO_REWARDS,
  TIERS,
  tally,
} from '../data/medals.ts'
import { OUTLAWS } from '../data/outlaws.ts'
import { challengePay, type Meta } from '../meta/progress.ts'
import { currentPlayer } from '../net/auth.ts'
import { button, el, panelSheet } from './sheet.ts'

export interface MapLinks {
  gazette: () => void
  achievements: () => void
}

function medalRow(parent: HTMLElement, tier: number): void {
  const pips = el('span', 'ow-map-pips', parent)
  pips.setAttribute('aria-label', tier > 0 ? `${TIERS[tier - 1]} medal` : 'No medal yet')
  for (const [i, t] of TIERS.entries()) {
    const pip = el('span', `ow-map-pip ow-map-pip-${t}${tier > i ? ' on' : ''}`, pips)
    pip.setAttribute('aria-hidden', 'true')
  }
}

function sets(parent: HTMLElement, meta: Meta): void {
  const t = tally(meta.marks())
  const row = el('div', 'ow-map-sets', parent)
  const cell = (label: string, n: number, cls: string): void => {
    const c = el('div', `ow-map-set ${cls}`, row)
    el('b', 'ow-t-num', c, `${n}/${OUTLAW_COUNT}`)
    el('span', '', c, label)
  }
  cell('Bronze', t.bronze, 'ow-map-pip-bronze')
  cell('Silver', t.silver, 'ow-map-pip-silver')
  cell('Gold', t.gold, 'ow-map-pip-gold')
  cell('Challenges', t.challenges, 'ow-map-set-ch')
}

function purse(parent: HTMLElement, meta: Meta): void {
  const p = meta.guestPurse()
  if (currentPlayer()) {
    el(
      'p',
      'ow-hub-note ow-map-purse',
      parent,
      meta.account
        ? 'Medals and challenges pay once, on ranked runs. Practice wins show here but don’t pay.'
        : 'Medals pay once each, on ranked runs.',
    )
    return
  }
  el(
    'p',
    'ow-hub-note ow-map-purse',
    parent,
    `Guest earnings: ${money(p.cash)} and ${p.xp.toLocaleString('en-US')} XP. ` +
      `Sign in to keep up to ${money(GUEST_CAP.cash)} and ${GUEST_CAP.xp.toLocaleString('en-US')} XP.`,
  )
}

/** A challenge's task loses its full stop when the pay follows it on the same line. */
const END_STOP = /\.$/u

function outlawRow(list: HTMLElement, meta: Meta, i: number): void {
  const o = OUTLAWS[i]
  const c = CHALLENGES[i]
  const ms = MEDAL_MS[i]
  if (!(o && c && ms)) {
    return
  }
  const m = meta.marks()[i]
  const beaten = (meta.data.clears & (1 << i)) !== 0 || (m?.tier ?? 0) > 0
  const li = el('li', `ow-map-row${beaten ? ' beaten' : ''}`, list)
  el('span', 'ow-map-no ow-t-num', li, String(i + 1).padStart(2, '0'))
  const who = el('div', 'ow-map-who', li)
  el('b', 'ow-map-name', who, o.name)
  el('span', 'ow-map-epithet', who, o.epithet)
  const medal = el('div', 'ow-map-medal', li)
  medalRow(medal, m?.tier ?? 0)
  let best = beaten ? 'no medal yet' : '—'
  if (m?.bestMs) {
    best = `${m.bestMs} ms`
  }
  el('span', 'ow-map-best ow-t-num', medal, best)
  el('span', 'ow-map-need ow-t-num', medal, `${ms[0]} · ${ms[1]} · ${ms[2]}`).title =
    'Medal times in ms: bronze, silver, gold'
  const ch = el('div', `ow-map-ch${m?.challenge ? ' done' : ''}`, li)
  el('b', 'ow-map-ch-title', ch, `${m?.challenge ? '✓ ' : ''}${c.title}`)
  const pay = challengePay(c)
  el(
    'span',
    'ow-map-ch-task',
    ch,
    `${c.task.replace(END_STOP, '')} · ${pay.xp} XP${pay.cash ? ` + ${money(pay.cash)}` : ''}${isClaim(c) ? ' · Tap his hat' : ''}`,
  )
}

function rewards(parent: HTMLElement, meta: Meta): void {
  el('h3', 'ow-map-h', parent, 'Rewards')
  const owned = new Set(meta.account?.rewards ?? [])
  const state = {
    marks: meta.marks(),
    dailyWins: meta.achievementState().dailyDays,
    legendBest: meta.data.legendBest,
  }
  const list = el('ul', 'ow-map-rewards', parent)
  for (const r of SOLO_REWARDS) {
    const item = itemById(r.item)
    if (!item) {
      continue
    }
    const has = owned.has(r.item)
    const met = meetsReward(r.rule, state)
    const li = el('li', has ? 'owned' : '', list)
    li.classList.toggle('met', met && !has)
    el('b', '', li, item.name)
    el('span', '', li, item.unlock ?? '')
    let status = 'Not yet'
    if (has) {
      status = 'In your Outfitter'
    } else if (met) {
      status = currentPlayer() ? 'Win it on a ranked run' : 'Sign in to claim it'
    }
    el('i', '', li, status)
  }
}

/** Opens the map over `root`. */
export function openGauntletMap(root: HTMLElement, meta: Meta, links: MapLinks): void {
  let off = (): void => undefined
  const s = panelSheet(root, {
    title: 'The Gauntlet',
    paper: true,
    cls: 'ow-map',
    onClose: () => off(),
  })
  const paint = (): void => {
    s.body.replaceChildren()
    el('div', 'ow-results-kicker', s.body, '17 outlaws')
    sets(s.body, meta)
    purse(s.body, meta)
    el('p', 'ow-hub-note ow-map-legend', s.body, 'Medal times in ms: bronze · silver · gold')
    const list = el('ol', 'ow-map-list', s.body)
    for (let i = 0; i < OUTLAW_COUNT; i++) {
      outlawRow(list, meta, i)
    }
    rewards(s.body, meta)
    const row = el('div', 'ow-hub-row', s.body)
    button(row, 'Read the Gazette', () => links.gazette())
    button(row, 'Achievements', () => links.achievements())
  }
  paint()
  off = meta.onChange(paint)
  meta.sync().catch(() => undefined)
}
