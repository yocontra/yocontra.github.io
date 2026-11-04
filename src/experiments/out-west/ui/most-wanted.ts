/**
 * The monthly Most Wanted board (spec §4 live ops): gross dollars earned across Bounty Hunt and
 * Frontier this UTC month, top 25, your own standing, last month's top 10 (each got a dated frame),
 * and earlier months. Every name opens that player's poster. Blocked players show as such.
 */

import type { MostWantedResponse, MostWantedRow } from '../contract/economy.ts'
import { money } from '../data/economy.ts'
import { MOST_WANTED_WINNERS, monthName, monthOf, previousMonth } from '../data/sinks.ts'
import { currentPlayer } from '../net/auth.ts'
import { blockedNames, fetchMostWanted } from '../net/social.ts'
import { openProfile } from './profile.ts'
import { el, statusLine } from './sheet.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** "Oct 2026" for `2026-10`. */
const shortMonth = (month: string): string =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })

/** A month step in the board's running head: a small-caps arrow link, not a button plate. */
function step(
  nav: HTMLElement,
  o: { label: string; dir: 'prev' | 'next' },
  go: () => void,
): HTMLButtonElement {
  const b = el('button', `ow-feat-mw-step ${o.dir}`, nav)
  b.type = 'button'
  b.setAttribute('aria-label', o.dir === 'prev' ? `Earlier: ${o.label}` : `Later: ${o.label}`)
  el('span', 'ow-feat-mw-arrow', b, o.dir === 'prev' ? '‹' : '›')
  el('span', '', b, o.label)
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    go()
  })
  b.addEventListener('pointerdown', (e) => e.stopPropagation())
  return b
}

function closesIn(at: number): string {
  const days = Math.ceil((at - Date.now()) / DAY_MS)
  if (days <= 1) {
    return 'Ends tonight (UTC)'
  }
  return `Ends in ${days} days`
}

function rows(
  list: HTMLElement,
  data: readonly MostWantedRow[],
  o: { sheets: HTMLElement; blocked: ReadonlySet<string>; me: string | null; redraw: () => void },
): void {
  for (const r of data) {
    const li = el('li', 'ow-board-entry ow-feat-mw-entry', list)
    const hidden = o.blocked.has(r.name.toLowerCase())
    if (o.me !== null && r.name.toLowerCase() === o.me) {
      li.classList.add('mine')
    }
    el('span', 'ow-board-rank', li, String(r.rank))
    const who = el('button', 'ow-board-who ow-feat-name', li)
    who.type = 'button'
    who.textContent = hidden ? 'A blocked gunslinger' : r.name
    who.disabled = hidden
    if (!hidden) {
      who.setAttribute('aria-label', `${r.name}'s poster`)
      who.addEventListener('click', (e) => {
        e.stopPropagation()
        openProfile(o.sheets, r.name, { onBlockChange: o.redraw })
      })
    }
    el('span', 'ow-board-total', li, money(r.earned))
    el(
      'span',
      'ow-board-date',
      li,
      `Lv ${r.level}${r.prestige > 0 ? ` ${'★'.repeat(r.prestige)}` : ''}`,
    )
  }
}

/** Render the board for `month` (the current one when omitted) into `host`. */
export function mountMostWanted(host: HTMLElement, sheets: HTMLElement, month?: string): void {
  host.replaceChildren()
  const nav = el('nav', 'ow-feat-mw-nav', host)
  nav.setAttribute('aria-label', 'Months')
  const head = el('div', 'ow-feat-mw-head', host)
  const say = statusLine(host)
  const list = el('ol', 'ow-board-list', host)
  const prev = el('div', 'ow-feat-mw-prev', host)
  say('Loading…')
  const draw = (r: MostWantedResponse, blocked: ReadonlySet<string>): void => {
    const now = monthOf(Date.now())
    nav.replaceChildren()
    const earlier = previousMonth(r.month)
    step(nav, { label: shortMonth(earlier), dir: 'prev' }, () =>
      mountMostWanted(host, sheets, earlier),
    )
    if (r.month < now) {
      const d = new Date(`${r.month}-01T00:00:00Z`)
      d.setUTCMonth(d.getUTCMonth() + 1)
      const later = monthOf(d.getTime())
      step(nav, { label: later === now ? 'This month' : shortMonth(later), dir: 'next' }, () =>
        mountMostWanted(host, sheets, later),
      )
    }
    head.replaceChildren()
    el('b', 'ow-feat-mw-month', head, monthName(r.month))
    el(
      'span',
      'ow-hub-note',
      head,
      r.final
        ? `Final. The top ${MOST_WANTED_WINNERS} won a dated frame.`
        : `${closesIn(r.closesAt)}. Ranked by money earned in Bounty Hunt and Frontier. Top ${MOST_WANTED_WINNERS} win a dated frame.`,
    )
    if (r.you) {
      el(
        'span',
        'ow-hub-note ow-feat-mw-you',
        head,
        r.you.rank === null
          ? `You: ${money(r.you.earned)} so far. Not ranked yet.`
          : `You: #${r.you.rank} · ${money(r.you.earned)}`,
      )
    }
    const me = currentPlayer()?.name.toLowerCase() ?? null
    const redraw = (): void => mountMostWanted(host, sheets, r.month)
    list.replaceChildren()
    say(r.rows.length > 0 ? '' : 'No one has earned money this month yet.')
    rows(list, r.rows, { sheets, blocked, me, redraw })
    prev.replaceChildren()
    if (r.previous.winners.length > 0) {
      el('h3', 'ow-standing-h', prev, `Most Wanted, ${monthName(r.previous.month)}`)
      rows(el('ol', 'ow-board-list', prev), r.previous.winners, { sheets, blocked, me, redraw })
    }
  }
  Promise.all([fetchMostWanted(month), currentPlayer() ? blockedNames() : new Set<string>()])
    .then(([r, blocked]) => {
      if (!host.isConnected) {
        return
      }
      if (!r.ok) {
        say(r.error, 'error')
        return
      }
      draw(r.value, blocked)
    })
    .catch(() => undefined)
}
