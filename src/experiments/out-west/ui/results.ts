// biome-ignore-all lint/style/noExcessiveClassesPerFile: the receipt and the room news it opens with belong together
/**
 * Bounty Hunt's results screen: the outcome, both reactions, the money and XP lines, level-ups,
 * the streak, rematch, and the opponent's poster and Report. (The wanted posters themselves are
 * `wanted.ts`, shared with the match intro and public profiles.)
 * The numbers are always the server's; this module only lays them out.
 */
import type { DuelResult, Seat, Settlement } from '../contract/duel.ts'
import { type SettlementLevels, settlementLevels } from '../contract/duel.ts'
import { money } from '../data/economy.ts'
import { levelProgress, levelRewards, titleFor } from '../data/progression.ts'
import { markLevelSeen } from './notices.ts'
import { openProfile, reportSheet } from './profile.ts'
import { noteLevel } from './sfx.ts'
import { button, countUp, el, setBar, signedMoney, swallow } from './sheet.ts'

export interface ResultView {
  tone: 'win' | 'loss' | 'even'
  title: string
  sub: string
  /** Judged reactions, ms. */
  you: number | null
  them: number | null
  settlement: Settlement | null
  /** XP before the match and after (for the bar and level-ups). */
  xpBefore: number | null
  xpAfter: number | null
  canRematch: boolean
  /** Shown instead of the money lines when there's no settlement to show. */
  pending?: string
}

export interface ResultHandlers {
  rematch: () => void
  next: () => void
  saloon: () => void
}

/** The man across the street, for his poster and Report (a live player or a ghost's owner). */
export interface OpponentRef {
  name: string
  kind: 'human' | 'ghost'
  /** The match id, attached to a report. */
  context: string
}

function settlementLines(panel: HTMLElement, s: Settlement | null, pending: string): void {
  const list = el('ul', 'ow-results-lines', panel)
  if (!s) {
    el('li', '', list, pending)
    return
  }
  for (const l of s.lines) {
    const li = el('li', '', list)
    el('span', '', li, l.label)
    el('b', l.amount < 0 ? 'neg' : 'pos', li, l.amount ? signedMoney(l.amount) : '')
    el('i', '', li, l.xp ? `+${l.xp} XP` : '')
  }
  const total = el('li', 'ow-results-total', list)
  el('span', '', total, s.streak > 1 ? `Total · ${s.streak}-win streak` : 'Total')
  countUp(el('b', s.delta < 0 ? 'neg' : 'pos', total), { from: 0, to: s.delta }, signedMoney, 1100)
  countUp(el('i', '', total), { from: 0, to: s.xp }, (n) => `+${n} XP`, 1100)
  if (s.pairFactor < 1) {
    el('li', 'ow-results-pair', list, `Same opponent again: ${Math.round(s.pairFactor * 100)}% pay`)
  }
  if (s.purse !== null) {
    const purse = el('li', 'ow-results-purse', list)
    countUp(purse, { from: s.purse - s.delta, to: s.purse }, (n) => `Purse ${money(n)}`, 1100)
  }
}

const ms = (v: number | null): string => (v === null ? '—' : `${Math.round(v)} ms`)

/** The results sheet over the kill cam. */
export class ResultsPanel {
  readonly root: HTMLElement
  private readonly levelBox: HTMLElement
  private readonly bar: HTMLElement
  private readonly barLabel: HTMLElement
  private readonly vote: HTMLElement
  private readonly record: HTMLElement
  private readonly rematchBtn: HTMLButtonElement
  private readonly nextBtn: HTMLButtonElement
  /**
   * open: you can ask for a rematch. voted: you asked, waiting on him. closed: no rematch can
   * happen (a dodge or forfeit, the window or the rematch count ran out, the room closed): the
   * button goes away and Next bounty takes the lead, rather than a dead pink button.
   */
  private rematch: 'open' | 'voted' | 'closed' = 'open'
  /** The settlement's XP and level numbers, when the server sends them. */
  private readonly booked: SettlementLevels | null

  constructor(
    parent: HTMLElement,
    v: ResultView,
    h: ResultHandlers,
    opponent: OpponentRef | null = null,
  ) {
    this.root = el('div', `ow-results ow-results-${v.tone}`, parent)
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', v.title)
    swallow(this.root)
    const panel = el('div', 'ow-hub-panel ow-paper-doc ow-results-panel', this.root)
    el('div', 'ow-results-kicker', panel, 'Bank of Perdition · Receipt')
    el('h2', 'ow-results-title', panel, v.title)
    el('p', 'ow-hub-note ow-results-sub', panel, v.sub)
    const draws = el('div', 'ow-results-draws', panel)
    const cell = (who: string, t: number | null): void => {
      const c = el('div', 'ow-results-draw', draws)
      el('span', 'ow-results-who', c, who)
      el('b', '', c, ms(t))
    }
    cell('You', v.you)
    cell('Him', v.them)
    settlementLines(panel, v.settlement, v.pending ?? 'Adding up…')
    this.levelBox = el('div', 'ow-results-level', panel)
    this.levelBox.setAttribute('role', 'status')
    const track = el('div', 'ow-xp', panel)
    this.bar = el('div', 'ow-xp-fill', track)
    this.barLabel = el('div', 'ow-xp-label', panel)
    // the server's own before/after (from the committed ledger) wins over what the client captured
    this.booked = settlementLevels(v.settlement)
    this.setXp(v.xpBefore, v.xpAfter)
    this.record = el('div', 'ow-xp-label', panel)
    this.vote = el('div', 'ow-results-vote', panel)
    this.vote.setAttribute('aria-live', 'polite')
    const row = el('div', 'ow-hub-row', panel)
    button(row, 'Menu', h.saloon)
    this.nextBtn = button(row, 'Next duel', h.next)
    this.rematchBtn = button(
      row,
      'Rematch',
      () => {
        if (this.rematch === 'open') {
          this.voted()
          h.rematch()
        }
      },
      true,
    )
    this.rematchBtn.classList.add('ow-results-rematch')
    if (!v.canRematch) {
      this.closeRematch()
    }
    if (opponent) {
      const who = el('div', 'ow-hub-row ow-feat-opponent', panel)
      const label = opponent.kind === 'ghost' ? 'His owner’s poster' : 'His poster'
      button(who, label, () => openProfile(this.root, opponent.name, { context: opponent.context }))
      button(who, 'Report', () =>
        reportSheet(this.root, opponent.name, { context: opponent.context }),
      ).classList.add('ow-btn-danger')
    }
    requestAnimationFrame(() => this.root.classList.add('on'))
  }

  /** The XP bar (and a level-up banner when the level changed). */
  setXp(xpBefore: number | null, xpAfter: number | null): void {
    const booked = this.booked
    const before = booked ? booked.xpBefore : xpBefore
    const after = booked ? booked.xpAfter : xpAfter
    if (after === null) {
      this.barLabel.textContent = ''
      return
    }
    const a = levelProgress(after)
    const b = before === null ? a : levelProgress(before)
    const to = a.next > 0 ? a.into / a.next : 1
    setBar(this.bar, b.level === a.level && before !== null ? b.into / Math.max(1, b.next) : 0)
    requestAnimationFrame(() => setBar(this.bar, to))
    this.barLabel.textContent =
      a.next > 0 ? `Lv ${a.level} · ${a.into} / ${a.next} XP` : `Lv ${a.level} · max level`
    this.levelBox.replaceChildren()
    if (a.level > b.level) {
      // the seal's slam plays the fanfare (ui/sfx.ts); the saloon mustn't play it (or tell it) again
      noteLevel(a.level)
      markLevelSeen(a.level)
      el('span', 'ow-results-seal', this.levelBox, String(a.level))
      const stamp = el('div', 'ow-results-stamp', this.levelBox)
      el('b', '', stamp, 'Level up')
      el(
        'span',
        '',
        stamp,
        `${titleFor(a.level)} · +${money(booked ? booked.levelReward : levelRewards(b.level, a.level))}`,
      )
      this.levelBox.classList.add('on')
    }
  }

  /** Rematch votes from the server: [seat0, seat1], and how many rematches the room has left. */
  setVotes(votes: readonly [boolean, boolean], me: 0 | 1, left: number): void {
    const mine = votes[me]
    const theirs = votes[me === 0 ? 1 : 0]
    if (left <= 0) {
      this.closeRematch()
      return
    }
    if (mine) {
      this.voted()
    }
    if (mine && theirs) {
      this.vote.textContent = 'Rematch accepted. Starting…'
    } else if (theirs) {
      this.vote.textContent = 'He wants a rematch.'
    } else if (mine) {
      this.vote.textContent = 'Waiting for him…'
    }
  }

  say(text: string): void {
    this.vote.textContent = text
  }

  /** Your Bounty Hunt record, once the server has it. */
  setRecord(text: string): void {
    this.record.textContent = text
  }

  /** You asked: the button stays, quiet and disabled, while you wait on him. */
  private voted(): void {
    if (this.rematch !== 'open') {
      return
    }
    this.rematch = 'voted'
    this.rematchBtn.disabled = true
    this.rematchBtn.classList.remove('ow-btn-primary')
    this.rematchBtn.setAttribute('aria-pressed', 'true')
  }

  /** No rematch is possible any more: hide the button and hand the lead to Next bounty. */
  closeRematch(): void {
    if (this.rematch === 'closed') {
      return
    }
    this.rematch = 'closed'
    this.rematchBtn.disabled = true
    this.rematchBtn.hidden = true
    this.nextBtn.classList.add('ow-btn-primary')
  }

  /** The room closed (or the line died) after the verdict. */
  disableRematch(): void {
    this.closeRematch()
  }

  close(): void {
    this.root.remove()
  }
}

interface Votes {
  votes: readonly [boolean, boolean]
  left: number
}

/**
 * What the room says after its verdict, for the receipt. The kill cam is often still playing when
 * the rematch votes arrive or the room closes; the receipt opens with them instead of dropping
 * them (and offering a Rematch that can't happen).
 */
export class RoomNews {
  private votes: Votes | null = null
  private closed: string | null = null
  private panel: ResultsPanel | null = null

  /** A new duel: a rematch, or the first hello. */
  reset(): void {
    this.votes = null
    this.closed = null
    this.panel = null
  }

  /** The receipt is up: tell it everything so far. */
  attach(panel: ResultsPanel, seat: 0 | 1): void {
    this.panel = panel
    if (this.votes) {
      panel.setVotes(this.votes.votes, seat, this.votes.left)
    }
    if (this.closed !== null) {
      this.close(this.closed)
    }
  }

  vote(v: Votes, seat: 0 | 1): void {
    this.votes = { votes: v.votes, left: v.left }
    this.panel?.setVotes(v.votes, seat, v.left)
  }

  /** The room closed (or the line died) after the verdict. */
  close(reason: string): void {
    this.closed = reason
    this.panel?.disableRematch()
    this.panel?.say(reason)
  }
}

/** What the results sheet says for a room's verdict, from your seat. */
export function resultView(
  r: DuelResult,
  me: Seat,
  name: string,
  xp: { before: number | null; after: number | null },
): ResultView {
  const won = r.winner === me
  const base = {
    you: r.reactions[me],
    them: r.reactions[me === 0 ? 1 : 0],
    settlement: r.you,
    xpBefore: xp.before,
    xpAfter: xp.after,
    canRematch: r.outcome !== 'dodge' && r.outcome !== 'forfeit',
  }
  const byOutcome: Record<string, Pick<ResultView, 'tone' | 'title' | 'sub'>> = {
    win: won
      ? // the title and the receipt below already say it: no line between them
        { tone: 'win', title: `${name} is dead`, sub: '' }
      : { tone: 'loss', title: 'You lose', sub: `${name} was quicker.` },
    coward:
      r.culprit === me
        ? { tone: 'loss', title: 'Too early', sub: 'You drew before the bell. Full penalty.' }
        : { tone: 'win', title: 'He drew early', sub: 'He drew before the bell. You win.' },
    forfeit:
      r.culprit === me
        ? { tone: 'loss', title: 'Forfeit', sub: 'You left the street. Full penalty.' }
        : { tone: 'win', title: 'He left', sub: 'His connection dropped. You win.' },
    dodge:
      r.culprit === me
        ? { tone: 'loss', title: 'Dodged', sub: 'You didn’t press Ready. Half penalty, no XP.' }
        : {
            tone: 'even',
            title: 'He dodged',
            sub: 'He didn’t press Ready. You’re first in the queue.',
          },
    froze: { tone: 'even', title: 'No one drew', sub: 'A little XP, no money.' },
    draw: { tone: 'even', title: 'Tie', sub: 'Two ties in a row. No one pays.' },
  }
  return { ...base, ...(byOutcome[r.outcome] ?? byOutcome.froze) } as ResultView
}
