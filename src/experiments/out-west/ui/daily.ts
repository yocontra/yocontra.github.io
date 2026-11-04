/**
 * The Daily Outlaw in the saloon (meta-game stream): the hub tile, the day's sheet (who, what's
 * different, your tries, the board), the ride out, and the result when you're back.
 * The duel itself is `duel/daily.ts`; the server is `api/src/daily/*`.
 */
import type { DailyBoardResponse, DailyResponse } from '../contract/meta.ts'
import { DAILY_PAY, type DailyModifier, type DailySpec, dailySpec, dayKey } from '../data/daily.ts'
import { money } from '../data/economy.ts'
import { OUTLAWS } from '../data/outlaws.ts'
import type { Verdict } from '../duel/clock.ts'
import { currentPlayer } from '../net/auth.ts'
import { fetchDaily, fetchDailyBoard, issueDaily } from '../net/meta.ts'
import { RankedSession } from '../net/ranked.ts'
import { icon } from './icons.ts'
import { button, el, panelSheet, statusLine } from './sheet.ts'

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
  'double-fakes': 'Two fake-outs',
  'no-bell': 'No bell',
}

function modifiers(parent: HTMLElement, spec: DailySpec): void {
  const row = el('div', 'ow-daily-mods', parent)
  for (const m of spec.modifiers) {
    el('span', `ow-daily-mod ow-daily-mod-${m}`, row, MOD_LABEL[m])
  }
}

function board(parent: HTMLElement, b: DailyBoardResponse | null): void {
  el('h3', 'ow-map-h', parent, 'Today’s board')
  if (!b || b.rows.length === 0) {
    el('p', 'ow-hub-note', parent, 'Nobody has beaten him yet today.')
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
    el('p', 'ow-hub-note', parent, `You: #${b.you.rank}, ${b.you.ms} ms.`)
  }
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
    this.sub = el('span', 'ow-tile-sub', b, 'A new outlaw every day')
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
    this.kicker.textContent = `Daily Outlaw · ${spec.modifiers.map((m) => MOD_LABEL[m]).join(' · ')}`
    const t = this.today
    if (!t) {
      this.sub.textContent = 'Saddling up…'
      return
    }
    const left = Math.max(0, t.maxTries - t.tries)
    this.sub.textContent = t.best
      ? `Best today ${t.best} ms · ${left} ${left === 1 ? 'try' : 'tries'} left`
      : `${left} of ${t.maxTries} tries left · ${t.paid ? 'paid today' : `win: +${money(DAILY_PAY.cash)}`}`
  }

  /** The day's sheet: who, what's different, the board, and the ride out. */
  async open(): Promise<void> {
    const s = panelSheet(this.root, { title: 'The Daily Outlaw', paper: true, cls: 'ow-daily' })
    const status = statusLine(s.body)
    status('Asking around town…')
    const [today, b] = await Promise.all([fetchDaily(), fetchDailyBoard()])
    status('')
    if (!today.ok) {
      el(
        'p',
        'ow-hub-note',
        s.body,
        today.status === 404
          ? 'The Daily Outlaw isn’t on this server yet.'
          : 'Couldn’t reach the server. The Daily Outlaw needs a connection.',
      )
      return
    }
    this.today = today.value
    const t = today.value
    const spec = t.spec
    const o = OUTLAWS[spec.outlaw]
    el('div', 'ow-results-kicker', s.body, `${spec.day} · ${spec.title}`)
    modifiers(s.body, spec)
    el('p', 'ow-hub-note', s.body, spec.blurb)
    if (o) {
      el(
        'p',
        'ow-hub-note',
        s.body,
        `He rides in as ${o.name}, ${o.epithet}, and draws in about ${spec.drawMs} ms.`,
      )
    }
    const left = Math.max(0, t.maxTries - t.tries)
    el(
      'p',
      'ow-hub-note ow-daily-terms',
      s.body,
      currentPlayer()
        ? `${left} of ${t.maxTries} tries left today. A win pays +${money(DAILY_PAY.cash)} and +${DAILY_PAY.xp} XP once a day${t.paid ? ' (paid today)' : ''}; your best time goes on the board.`
        : `${left} of ${t.maxTries} tries left today. Sign in to get paid and go on the board.`,
    )
    board(s.body, b.ok ? b.value : null)
    const row = el('div', 'ow-hub-row', s.body)
    const ride = button(
      row,
      left > 0 ? 'Ride out' : 'Back tomorrow',
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
      status('Couldn’t verify you. Try again.', 'error')
      return false
    }
    status('Saddling up…')
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
    const s = panelSheet(this.root, { title: 'The Daily Outlaw', paper: true, cls: 'ow-daily' })
    el('div', 'ow-results-kicker', s.body, `${spec.day} · ${spec.title}`)
    let line = 'The line dropped before the bell. That try is void.'
    if (v?.outcome === 'win') {
      line = `You beat him: ${Math.round(v.reactionMs ?? 0)} ms.`
    } else if (v?.outcome === 'loss') {
      line = v.reactionMs
        ? `He was quicker. You drew in ${Math.round(v.reactionMs)} ms${v.enemyMs ? `, he drew in ${Math.round(v.enemyMs)} ms` : ''}.`
        : 'He was quicker. You never drew.'
    } else if (v?.outcome === 'coward') {
      line = 'You drew before the bell. No time for that.'
    }
    el('h3', 'ow-daily-big', s.body, line)
    if (v && v.payout > 0) {
      el(
        'p',
        'ow-hub-note',
        s.body,
        `+${money(v.payout)} and +${DAILY_PAY.xp} XP, booked to your ledger.`,
      )
    }
    const b = await fetchDailyBoard()
    board(s.body, b.ok ? b.value : null)
  }
}
