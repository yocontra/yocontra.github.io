/**
 * Bounty Hunt's results screen, and the wanted posters it shares with the match intro: the
 * results (outcome, both reactions, the money and XP lines, level-ups, the streak, rematch).
 * The numbers are always the server's; this module only lays them out.
 */
import type { DuelResult, Poster, Seat, Settlement } from '../contract/duel.ts'
import { itemById, normalizeLoadout } from '../data/catalog.ts'
import { money } from '../data/economy.ts'
import { levelProgress, levelRewards, titleFor } from '../data/progression.ts'
import { FRAME_COLORS } from '../scene/loadout.ts'
import { button, el, signedMoney, swallow } from './sheet.ts'

const KIND_HEAD: Record<Poster['kind'], string> = {
  human: 'Wanted',
  ghost: 'Ghost of',
  outlaw: 'Town outlaw',
}

/** A wanted poster in its frame: name, level, live bounty, streak and kit. */
export function posterEl(p: Poster, side: 'you' | 'them'): HTMLElement {
  const l = normalizeLoadout(p.loadout)
  const card = el('div', `ow-wanted ow-wanted-${side}`)
  card.dataset.kind = p.kind
  card.style.setProperty('--frame', FRAME_COLORS[l.frame] ?? '#8a6a42')
  el('div', 'ow-wanted-head', card, KIND_HEAD[p.kind])
  el('div', 'ow-wanted-name', card, p.name)
  el('div', 'ow-wanted-meta', card, `Lv ${p.level} · ${titleFor(p.level)}`)
  el('div', 'ow-wanted-bounty', card, money(p.bounty))
  const notes: string[] = []
  if (p.streak > 1) {
    notes.push(`${p.streak}-win streak`)
  }
  if (p.cowardice > 0) {
    notes.push(`${p.cowardice} cowardice`)
  }
  if (p.kind === 'ghost') {
    notes.push('a recorded gunslinger')
  }
  el('div', 'ow-wanted-notes', card, notes.join(' · ') || 'clean record')
  const kit = el('ul', 'ow-wanted-kit', card)
  for (const id of [l.hat, l.gun, l.outfit, l.extra]) {
    const item = id ? itemById(id) : undefined
    if (item && item.source !== 'starter') {
      el('li', '', kit, item.name)
    }
  }
  if (kit.children.length === 0) {
    el('li', '', kit, 'Starter kit')
  }
  return card
}

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
}

export interface ResultHandlers {
  rematch: () => void
  next: () => void
  saloon: () => void
}

function settlementLines(panel: HTMLElement, s: Settlement | null): void {
  const list = el('ul', 'ow-results-lines', panel)
  if (!s) {
    el('li', '', list, 'Settling up with the bank…')
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
  el('b', s.delta < 0 ? 'neg' : 'pos', total, signedMoney(s.delta))
  el('i', '', total, `+${s.xp} XP`)
  if (s.pairFactor < 1) {
    el(
      'li',
      'ow-results-pair',
      list,
      `Same opponent again: paid at ${Math.round(s.pairFactor * 100)}%`,
    )
  }
  if (s.purse !== null) {
    el('li', 'ow-results-purse', list, `Purse ${money(s.purse)}`)
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

  constructor(parent: HTMLElement, v: ResultView, h: ResultHandlers) {
    this.root = el('div', `ow-results ow-results-${v.tone}`, parent)
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', v.title)
    swallow(this.root)
    const panel = el('div', 'ow-hub-panel ow-results-panel', this.root)
    el('h2', 'ow-results-title', panel, v.title)
    el('p', 'ow-hub-note', panel, v.sub)
    const draws = el('div', 'ow-results-draws', panel)
    const cell = (who: string, t: number | null): void => {
      const c = el('div', 'ow-results-draw', draws)
      el('span', 'ow-results-who', c, who)
      el('b', '', c, ms(t))
    }
    cell('You', v.you)
    cell('Him', v.them)
    settlementLines(panel, v.settlement)
    this.levelBox = el('div', 'ow-results-level', panel)
    const track = el('div', 'ow-xp', panel)
    this.bar = el('div', 'ow-xp-fill', track)
    this.barLabel = el('div', 'ow-xp-label', panel)
    this.setXp(v.xpBefore, v.xpAfter)
    this.record = el('div', 'ow-xp-label', panel)
    this.vote = el('div', 'ow-results-vote', panel)
    this.vote.setAttribute('aria-live', 'polite')
    const row = el('div', 'ow-hub-row', panel)
    button(row, 'Saloon', h.saloon)
    button(row, 'Next bounty', h.next)
    this.rematchBtn = button(
      row,
      'Rematch',
      () => {
        this.rematchBtn.disabled = true
        h.rematch()
      },
      true,
    )
    this.rematchBtn.disabled = !v.canRematch
    requestAnimationFrame(() => this.root.classList.add('on'))
  }

  /** The XP bar (and a level-up banner when the level changed). */
  setXp(before: number | null, after: number | null): void {
    if (after === null) {
      this.barLabel.textContent = ''
      return
    }
    const a = levelProgress(after)
    const b = before === null ? a : levelProgress(before)
    const pct = a.next > 0 ? (a.into / a.next) * 100 : 100
    this.bar.style.width = `${b.level === a.level && before !== null ? (b.into / Math.max(1, b.next)) * 100 : 0}%`
    requestAnimationFrame(() => {
      this.bar.style.width = `${pct}%`
    })
    this.barLabel.textContent =
      a.next > 0 ? `Lv ${a.level} · ${a.into} / ${a.next} XP` : `Lv ${a.level} · max level`
    this.levelBox.replaceChildren()
    if (a.level > b.level) {
      el('b', '', this.levelBox, `Level up · Lv ${a.level} ${titleFor(a.level)}`)
      el('span', '', this.levelBox, ` +${money(levelRewards(b.level, a.level))}`)
      this.levelBox.classList.add('on')
    }
  }

  /** Rematch votes from the server: [seat0, seat1], with the window's deadline. */
  setVotes(votes: readonly [boolean, boolean], me: 0 | 1, left: number): void {
    const mine = votes[me]
    const theirs = votes[me === 0 ? 1 : 0]
    if (left <= 0) {
      this.rematchBtn.disabled = true
    }
    if (mine && theirs) {
      this.vote.textContent = 'Rematch! Back to the street…'
    } else if (theirs) {
      this.vote.textContent = 'He wants a rematch.'
    } else if (mine) {
      this.vote.textContent = 'Waiting on him…'
    }
  }

  say(text: string): void {
    this.vote.textContent = text
  }

  /** Your Bounty Hunt record, once the server has it. */
  setRecord(text: string): void {
    this.record.textContent = text
  }

  disableRematch(): void {
    this.rematchBtn.disabled = true
  }

  close(): void {
    this.root.remove()
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
      ? { tone: 'win', title: `${name} is dead`, sub: 'The bounty’s yours.' }
      : { tone: 'loss', title: 'You lose', sub: `${name} was quicker.` },
    coward:
      r.culprit === me
        ? { tone: 'loss', title: 'Coward.', sub: 'You drew before the bell. Full penalty.' }
        : { tone: 'win', title: 'He drew early', sub: 'Shot at your boots. Bounty’s yours.' },
    forfeit:
      r.culprit === me
        ? { tone: 'loss', title: 'Forfeit', sub: 'You left the street. Full penalty.' }
        : { tone: 'win', title: 'He lit out', sub: 'His line went dead. Bounty’s yours.' },
    dodge:
      r.culprit === me
        ? { tone: 'loss', title: 'Dodged', sub: 'You never cocked. Half penalty, no XP.' }
        : {
            tone: 'even',
            title: 'He dodged',
            sub: 'He never cocked. Back to the front of the queue.',
          },
    froze: { tone: 'even', title: 'Both froze', sub: 'Nobody drew. A little XP, no money.' },
    draw: { tone: 'even', title: 'A draw', sub: 'Two dead heats. Nobody pays.' },
  }
  return { ...base, ...(byOutcome[r.outcome] ?? byOutcome.froze) } as ResultView
}
