/**
 * The Daily Outlaw in the saloon (meta-game stream): the hub tile, the day's sheet (who, what's
 * different, your tries, the board), the ride out, and the result when you're back.
 * The duel itself is `duel/daily.ts`; the server is `api/src/daily/*`.
 */
import type { DailyBoardResponse, DailyResponse } from '../contract/meta.ts'
import {
  DAILY_PAY,
  type DailyModifier,
  type DailySpec,
  dailySpec,
  dayKey,
  modifierRule,
} from '../data/daily.ts'
import { money } from '../data/economy.ts'
import { OUTLAWS } from '../data/outlaws.ts'
import type { Verdict } from '../duel/clock.ts'
import { currentPlayer } from '../net/auth.ts'
import { fetchDaily, fetchDailyBoard, issueDaily } from '../net/meta.ts'
import { RankedSession } from '../net/ranked.ts'
import { icon } from './icons.ts'
import { button, el, facts, panelSheet, statusLine } from './sheet.ts'

export interface DailyDeps {
  /** The game behind the hub is loaded. */
  ready: () => boolean
  /** A fresh Turnstile token. */
  token: () => Promise<string | null>
  /** Ride out: hide the hub and play the duel; `back` runs at the saloon with the verdict. */
  start: (spec: DailySpec, session: RankedSession, back: (v: Verdict | null) => void) => void
}

const MOD_LABEL: Readonly<Record<DailyModifier, string>> = {
  fog: 'Fog',
  'double-fakes': '2 fake-outs',
  'no-bell': 'No bell',
}

/** The day's modifiers as chips, then one plain line each on what changes. */
function modifiers(parent: HTMLElement, spec: DailySpec): void {
  const row = el('div', 'ow-daily-mods', parent)
  for (const m of spec.modifiers) {
    el('span', `ow-daily-mod ow-daily-mod-${m}`, row, MOD_LABEL[m])
  }
  for (const m of spec.modifiers) {
    el('p', 'ow-hub-note ow-daily-rule', parent, modifierRule(m))
  }
}

/** "$50 + 75 XP" */
const reward = (cash: number): string => `${money(cash)} + ${DAILY_PAY.xp} XP`

function board(parent: HTMLElement, b: DailyBoardResponse | null): void {
  el('h3', 'ow-map-h', parent, 'Today’s best times')
  if (!b || b.rows.length === 0) {
    el('p', 'ow-hub-note', parent, 'No one has beaten him yet.')
    return
  }
  const list = el('ol', 'ow-ledger-list ow-daily-board', parent)
  for (const r of b.rows.slice(0, 10)) {
    const li = el('li', '', list)
    el('span', 'ow-t-num', li, `#${r.rank}`)
    el('span', '', li, r.name)
    el('b', 'ow-t-num', li, `${r.ms} ms`)
  }
  if (b.you && b.you.rank > 10) {
    el('p', 'ow-hub-note', parent, `You: #${b.you.rank} · ${b.you.ms} ms`)
  }
}

/**
 * The banner's one line: how your day stands (tries, best, the pay still on offer). Empty when
 * the server can't be reached: the kicker already names the day's twist, and a "loading" line
 * that never resolves reads as stuck.
 */
function dailyStatus(t: DailyResponse | null): string {
  if (!t) {
    return ''
  }
  const left = Math.max(0, t.maxTries - t.tries)
  if (left === 0) {
    return t.best ? `Best ${t.best} ms · No tries left` : 'No tries left today'
  }
  const tries = `${left} ${left === 1 ? 'try' : 'tries'} left`
  if (t.best) {
    return `Best ${t.best} ms · ${tries}`
  }
  return t.paid ? tries : `${tries} · Win ${money(DAILY_PAY.cash)}`
}

export class DailyTile {
  readonly button: HTMLButtonElement
  private readonly deps: DailyDeps
  private readonly root: HTMLElement
  private readonly sub: HTMLElement
  private readonly kicker: HTMLElement
  private today = null as DailyResponse | null

  constructor(root: HTMLElement, parent: HTMLElement, deps: DailyDeps) {
    this.root = root
    this.deps = deps
    const b = el('button', 'ow-tile ow-tile-daily', parent)
    b.type = 'button'
    b.append(icon('badge'))
    this.kicker = el('span', 'ow-tile-kicker', b, 'Daily Outlaw')
    el('span', 'ow-tile-title', b, dailySpec(dayKey()).title)
    // empty (hidden) until the server says how your day stands: never a loading line
    this.sub = el('span', 'ow-tile-sub', b)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      this.open().catch(() => undefined)
    })
    b.addEventListener('pointerdown', (e) => e.stopPropagation())
    this.button = b
  }

  /** Reload today's tries and best (after sign-in, after a duel). */
  async refresh(): Promise<void> {
    const r = await fetchDaily()
    this.today = r.ok ? r.value : null
    const spec = this.today?.spec ?? dailySpec(dayKey())
    const title = this.button.querySelector('.ow-tile-title')
    if (title) {
      title.textContent = spec.title
    }
    // the tile is narrow on a phone: the modifiers live on the sheet (and in the tooltip)
    this.kicker.textContent = 'Daily Outlaw'
    this.button.title = `Daily Outlaw: ${spec.modifiers.map((m) => MOD_LABEL[m]).join(', ')}`
    this.sub.textContent = dailyStatus(this.today)
  }

  /** The day's sheet: who, what's different, the board, and the ride out. */
  async open(): Promise<void> {
    const s = panelSheet(this.root, { title: 'Daily Outlaw', paper: true, cls: 'ow-daily' })
    const status = statusLine(s.body)
    status('Loading…')
    const [today, b] = await Promise.all([fetchDaily(), fetchDailyBoard()])
    status('')
    if (!today.ok) {
      el(
        'p',
        'ow-hub-note',
        s.body,
        today.status === 404
          ? 'The Daily Outlaw isn’t available yet.'
          : 'Couldn’t connect. Check your connection and try again.',
      )
      return
    }
    this.today = today.value
    const t = today.value
    const spec = t.spec
    const o = OUTLAWS[spec.outlaw]
    el('div', 'ow-results-kicker', s.body, spec.title)
    el('h3', 'ow-daily-big', s.body, o ? o.name : 'Daily Outlaw')
    modifiers(s.body, spec)
    const left = Math.max(0, t.maxTries - t.tries)
    let pay = `${reward(DAILY_PAY.cash)} (first win today)`
    if (!currentPlayer()) {
      pay = `Sign in to earn ${reward(DAILY_PAY.cash)}`
    } else if (t.paid) {
      pay = 'Paid today'
    }
    facts(
      s.body,
      [
        ['His draw', `~${Math.round(spec.drawMs / 10) * 10} ms`],
        ['Tries left', `${left} of ${t.maxTries}`],
        ['Reward', pay],
      ],
      'ow-daily-facts',
    )
    board(s.body, b.ok ? b.value : null)
    const row = el('div', 'ow-hub-row', s.body)
    const ride = button(
      row,
      left > 0 ? 'Duel' : 'No tries left',
      () => {
        ride.disabled = true
        this.ride(status)
          .then((ok) => {
            if (ok) {
              s.close()
            } else {
              ride.disabled = false
            }
          })
          .catch(() => {
            ride.disabled = false
          })
      },
      true,
    )
    ride.disabled = left === 0 || !this.deps.ready()
  }

  private async ride(status: (text: string, kind?: 'info' | 'error') => void): Promise<boolean> {
    status('Checking you’re not a bot…')
    const token = await this.deps.token()
    if (!token) {
      status('Couldn’t check you’re human. Try again.', 'error')
      return false
    }
    status('Starting…')
    const ticket = await issueDaily(token)
    if (!ticket.ok) {
      status(ticket.error, 'error')
      return false
    }
    const session = await RankedSession.attach(ticket.value)
    if (!session.ok) {
      status(session.error, 'error')
      return false
    }
    const spec = this.today?.spec ?? dailySpec(dayKey())
    this.deps.start(spec, session.value, (v) => {
      this.refresh().catch(() => undefined)
      this.result(spec, v).catch(() => undefined)
    })
    return true
  }

  /** Back at the saloon: how it went, and the board. */
  private async result(spec: DailySpec, v: Verdict | null): Promise<void> {
    const s = panelSheet(this.root, { title: 'Daily Outlaw', paper: true, cls: 'ow-daily' })
    el('div', 'ow-results-kicker', s.body, spec.title)
    const ms = (n: number | null | undefined): string => (n ? `${Math.round(n)} ms` : '')
    let line = 'Connection lost'
    let note = 'That try didn’t count.'
    if (v?.outcome === 'win') {
      line = 'You won'
      note = ''
    } else if (v?.outcome === 'loss') {
      line = 'You lost'
      note = v.reactionMs ? '' : 'You didn’t draw.'
    } else if (v?.outcome === 'coward') {
      line = 'Too early'
      note = 'You drew before the bell.'
    }
    el('h3', 'ow-daily-big', s.body, line)
    if (note) {
      el('p', 'ow-hub-note', s.body, note)
    }
    facts(s.body, [
      ['Your draw', ms(v?.reactionMs)],
      ['His draw', v?.outcome === 'loss' ? ms(v.enemyMs) : ''],
      ['Reward', v && v.payout > 0 ? reward(v.payout) : ''],
    ])
    const b = await fetchDailyBoard()
    board(s.body, b.ok ? b.value : null)
  }
}
