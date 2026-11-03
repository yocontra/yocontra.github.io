/**
 * A player's public wanted poster (`GET /players/:name`): their poster, kit, Bounty Hunt and
 * Frontier records and Most Wanted months, with Report and Block (spec §11.4: on every poster).
 * Opened from the Most Wanted board, the Bounty Hunt results sheet and Frontier's riders list and
 * death card. Blocking is private; a blocked player is never matched with you and never shown.
 */

import {
  type PlayerPoster,
  REPORT_LABELS,
  REPORT_REASONS,
  type ReportReason,
} from '../contract/social.ts'
import { money } from '../data/economy.ts'
import { monthName } from '../data/sinks.ts'
import { currentPlayer } from '../net/auth.ts'
import { block, fetchPoster, report, setBlocked, unblock } from '../net/social.ts'
import { button, el, panelSheet, statusLine } from './sheet.ts'
import { posterEl } from './wanted.ts'

export interface ProfileOpts {
  /** The match or lobby the report is about, if any. */
  context?: string
  /** Called after a block or unblock (lists that hide blocked players refresh). */
  onBlockChange?: (name: string, blocked: boolean) => void
}

const joined = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' })

function recordLines(body: HTMLElement, p: PlayerPoster): void {
  const list = el('ul', 'ow-ledger-list ow-feat-record', body)
  const line = (label: string, value: string): void => {
    const li = el('li', '', list)
    el('span', '', li, label)
    el('b', '', li, value)
  }
  const d = p.duel
  line('Bounty Hunt', `${d.wins}–${d.losses}–${d.draws}`)
  line('Best streak', d.bestStreak > 0 ? `${d.bestStreak} wins` : '—')
  line('Cowardice', String(d.cowardice))
  const f = p.frontier
  line('Frontier', `${f.kills} kills · ${f.deaths} deaths`)
  line('Banked in Frontier', money(f.banked))
  for (const w of p.mostWanted) {
    line(`Most Wanted, ${monthName(w.month)}`, `#${w.rank}`)
  }
  line('Rode in', joined.format(new Date(p.joinedAt)))
}

/** The report form: a reason, an optional block, then one POST. */
export function reportSheet(root: HTMLElement, name: string, o: ProfileOpts = {}): void {
  const sheet = panelSheet(root, { title: `Report ${name}` })
  el('p', 'ow-hub-note', sheet.body, 'Reports go to the sheriff, not to them. Pick what’s wrong.')
  let reason: ReportReason | null = null
  const list = el('div', 'ow-hub-choices', sheet.body)
  list.setAttribute('role', 'radiogroup')
  const choices: HTMLButtonElement[] = []
  for (const r of REPORT_REASONS) {
    const b = el('button', 'ow-choice', list)
    b.type = 'button'
    b.dataset.reason = r
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', 'false')
    el('b', '', b, REPORT_LABELS[r])
    choices.push(b)
  }
  // one listener for the group: the pressed choice is the reason
  list.addEventListener('click', (e) => {
    e.stopPropagation()
    const b = choices.find((c) => e.target instanceof Node && c.contains(e.target))
    const r = REPORT_REASONS.find((x) => x === b?.dataset.reason)
    if (!(b && r)) {
      return
    }
    reason = r
    for (const c of choices) {
      c.classList.toggle('primary', c === b)
      c.setAttribute('aria-checked', String(c === b))
    }
    send.disabled = false
  })
  const label = el('label', 'ow-toggle', sheet.body)
  const alsoBlock = el('input', '', label)
  alsoBlock.type = 'checkbox'
  alsoBlock.checked = true
  el('span', 'ow-toggle-label', label, 'Also block them')
  el('span', 'ow-toggle-hint', label, 'You’ll never be matched with them or see them again.')
  const say = statusLine(sheet.body)
  const row = el('div', 'ow-hub-row', sheet.body)
  button(row, 'Cancel', () => sheet.close())
  const send = button(
    row,
    'Send report',
    () => {
      if (!reason) {
        return
      }
      send.disabled = true
      say('Sending…')
      report({
        name,
        reason,
        block: alsoBlock.checked,
        ...(o.context ? { context: o.context } : {}),
      })
        .then((r) => {
          if (!r.ok) {
            send.disabled = false
            say(r.error, 'error')
            return
          }
          if (r.value.blocked) {
            setBlocked(null)
            o.onBlockChange?.(name, true)
          }
          say(r.value.blocked ? 'Reported and blocked. Thank you.' : 'Reported. Thank you.', 'ok')
          setTimeout(() => sheet.close(), 1200)
        })
        .catch(() => undefined)
    },
    true,
  )
  send.disabled = true
}

function actions(root: HTMLElement, body: HTMLElement, p: PlayerPoster, o: ProfileOpts): void {
  if (!currentPlayer()) {
    el('p', 'ow-hub-note', body, 'Sign in with a passkey to report or block.')
    return
  }
  if (p.blockedByYou === null) {
    // it's you
    return
  }
  const say = statusLine(body)
  const row = el('div', 'ow-hub-row ow-feat-actions', body)
  let blocked = p.blockedByYou
  const toggle = button(row, blocked ? 'Unblock' : 'Block', () => {
    toggle.disabled = true
    const call = blocked ? unblock(p.name) : block(p.name)
    call
      .then((r) => {
        toggle.disabled = false
        if (!r.ok) {
          say(r.error, 'error')
          return
        }
        blocked = !blocked
        setBlocked(r.value.blocked)
        toggle.textContent = blocked ? 'Unblock' : 'Block'
        say(blocked ? `${p.name} is blocked.` : `${p.name} is unblocked.`, 'ok')
        o.onBlockChange?.(p.name, blocked)
      })
      .catch(() => undefined)
  })
  button(row, 'Report…', () => reportSheet(root, p.name, o)).classList.add('ow-btn-danger')
}

/** Open `name`'s public poster over `root`. */
export function openProfile(root: HTMLElement, name: string, o: ProfileOpts = {}): void {
  const sheet = panelSheet(root, { title: 'Wanted poster', cls: 'ow-feat-profile' })
  const say = statusLine(sheet.body)
  say('Fetching the poster…')
  fetchPoster(name)
    .then((r) => {
      if (!r.ok) {
        say(r.error, 'error')
        return
      }
      say('')
      const p = r.value
      const card = posterEl(
        {
          kind: 'human',
          name: p.name,
          level: p.level,
          prestige: p.prestige,
          bounty: p.bounty,
          streak: p.duel.streak,
          cowardice: p.duel.cowardice,
          loadout: p.loadout,
        },
        'them',
      )
      card.classList.add('ow-feat-poster')
      sheet.body.append(card)
      el(
        'p',
        'ow-hub-note ow-feat-title',
        sheet.body,
        `${p.title}${p.prestige > 0 ? ` · ${'★'.repeat(p.prestige)}` : ''}${p.licensed ? '' : ' · unlicensed'}`,
      )
      recordLines(sheet.body, p)
      actions(root, sheet.body, p, o)
    })
    .catch(() => undefined)
}
