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
  /**
   * Ride out: hide the hub and play the duel. `back` runs on the empty street with the verdict;
   * the hub stays hidden until `home` (the result offers another try first).
   */
  start: (spec: DailySpec, session: RankedSession, back: (v: Verdict | null) => void) => void
  /** Back to the saloon from the result. */
  home: () => void
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
    return t.best ? `Best today ${t.best} ms · back tomorrow` : 'Back tomorrow'
  }
  const tries = `${left} ${left === 1 ? 'try' : 'tries'} left`
  if (t.best) {
    return `Best today ${t.best} ms · ${tries}`
  }
  return t.paid ? tries : `${tries} · win +${money(DAILY_PAY.cash)}`
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
    this.kicker.textContent = `Daily Outlaw · ${spec.modifiers.map((m) => MOD_LABEL[m]).join(' · ')}`
    this.sub.textContent = dailyStatus(this.today)
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

  /**
   * A new ticket and its socket, then the duel. `early` is a token fetched while the player read
   * the last result; a stale one (Turnstile tokens expire) is replaced once.
   */
  private async ride(
    status: (text: string, kind?: 'info' | 'error') => void,
    early: Promise<string | null> | null = null,
  ): Promise<boolean> {
    status('Checking you’re not a bot…')
    let token = (await early) ?? (await this.deps.token())
    if (!token) {
      status('Couldn’t verify you. Try again.', 'error')
      return false
    }
    status('Saddling up…')
    let ticket = await issueDaily(token)
    if (!ticket.ok && ticket.status === 403 && early) {
      token = await this.deps.token()
      ticket = token ? await issueDaily(token) : ticket
    }
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
      this.result(spec, v).catch(() => undefined)
    })
    return true
  }

  /**
   * Back on the street: how it went, then the one obvious next step. With tries left that is
   * "Try again" (a new ticket, the same outlaw, no trip through the saloon); without, your best,
   * your place on the board, and Back. Closing the sheet any way goes back to the saloon.
   */
  private async result(spec: DailySpec, v: Verdict | null): Promise<void> {
    let retrying = false
    const s = panelSheet(this.root, {
      title: 'The Daily Outlaw',
      paper: true,
      cls: 'ow-daily ow-daily-result',
      onClose: () => {
        if (!retrying) {
          this.deps.home()
        }
      },
    })
    // the next try's Turnstile token, fetched while the result is read
    const early = this.deps.token()
    el('div', 'ow-results-kicker', s.body, `${spec.day} · ${spec.title}`)
    el('h3', 'ow-daily-big', s.body, verdictLine(v))
    if (v && v.payout > 0) {
      el(
        'p',
        'ow-hub-note',
        s.body,
        `+${money(v.payout)} and +${DAILY_PAY.xp} XP, booked to your ledger.`,
      )
    }
    const terms = el('p', 'ow-hub-note ow-daily-terms', s.body)
    const status = statusLine(s.body)
    const row = el('div', 'ow-hub-row', s.body)
    const back = button(row, 'Back', () => s.close())
    const again = button(
      row,
      'Try again',
      () =>
        this.again({
          status,
          early,
          again,
          back,
          sheet: s,
          go: () => {
            retrying = true
          },
        }),
      true,
    )
    again.disabled = true
    again.focus()
    const [today, b] = await Promise.all([this.reload(), fetchDailyBoard()])
    const left = today ? Math.max(0, today.maxTries - today.tries) : 0
    if (left > 0) {
      again.textContent = `Try again (${left} left)`
      again.disabled = !this.deps.ready()
    } else {
      again.remove()
      back.classList.add('ow-btn-primary')
      back.focus()
    }
    terms.textContent = standingLine(today, b.ok ? b.value : null)
    board(s.body, b.ok ? b.value : null)
  }

  /** "Try again" on the result: the buttons hold while a new ticket is fetched. */
  private again(o: {
    status: (text: string, kind?: 'info' | 'error') => void
    early: Promise<string | null>
    again: HTMLButtonElement
    back: HTMLButtonElement
    sheet: { close: () => void }
    go: () => void
  }): void {
    const hold = (on: boolean): void => {
      o.again.disabled = on
      o.back.disabled = on
    }
    hold(true)
    this.ride(o.status, o.early)
      .then((ok) => {
        if (ok) {
          o.go()
          o.sheet.close()
        } else {
          hold(false)
        }
      })
      .catch(() => hold(false))
  }

  /** Today's tries and best, fresh from the server; also updates the banner. */
  private async reload(): Promise<DailyResponse | null> {
    await this.refresh().catch(() => undefined)
    return this.today
  }
}

/** The result's headline. */
function verdictLine(v: Verdict | null): string {
  if (v?.outcome === 'win') {
    return `You beat him: ${Math.round(v.reactionMs ?? 0)} ms.`
  }
  if (v?.outcome === 'loss') {
    return v.reactionMs
      ? `He was quicker. You drew in ${Math.round(v.reactionMs)} ms${v.enemyMs ? `, he drew in ${Math.round(v.enemyMs)} ms` : ''}.`
      : 'He was quicker. You never drew.'
  }
  if (v?.outcome === 'coward') {
    return 'You drew before the bell. No time for that.'
  }
  return 'The line dropped before the bell. That try is void.'
}

/** Your day so far: tries left (or none), your best time, your place on the board. */
function standingLine(t: DailyResponse | null, b: DailyBoardResponse | null): string {
  if (!t) {
    return ''
  }
  const left = Math.max(0, t.maxTries - t.tries)
  const parts = [left > 0 ? `${left} of ${t.maxTries} tries left today` : 'No tries left today']
  if (t.best) {
    parts.push(`your best ${t.best} ms`)
  }
  if (b?.you) {
    parts.push(`#${b.you.rank} on the board`)
  }
  return `${parts.join(' · ')}.`
}
