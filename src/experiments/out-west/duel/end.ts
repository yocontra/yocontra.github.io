import { bountyFor, drawBonus, type RunResult } from '../data/economy.ts'
import { OUTLAWS } from '../data/outlaws.ts'
import { save as persist } from '../save.ts'
import type { LedgerRow } from '../ui/hud.ts'
import type { Director } from './director.ts'
import { endShot } from './framing.ts'

const LEDGER_DELAY_MS = 1800

/** What each outlaw paid in this run (his first win's bounty plus bonus). */
function paidFor(run: RunResult, level: number): number | null {
  const first = run.duels.find((x) => x.level === level && x.outcome === 'win')
  return first ? bountyFor(level) + drawBonus(level, first.reactionMs) : null
}

function ledgerRows(d: Director): LedgerRow[] {
  const c = d.c
  return OUTLAWS.map((o, i) => {
    const b = c.save.best[i]
    return {
      name: o.name,
      ms: b ? b.ms : null,
      grade: b ? b.grade : '—',
      attempts: c.save.attempts[i] ?? 0,
      paid: paidFor(c.save.run, i),
    }
  })
}

/** The gauntlet is won: the ledger, the purse, and a seat on the leaderboard. */
export function toEnd(d: Director): void {
  const c = d.c
  d.enter('end')
  d.timeScale = 1
  c.save.legendUnlocked = true
  const run = c.save.run
  c.save.bestTotal = Math.max(c.save.bestTotal, run.total)
  persist(c.save)
  c.hud.hideCard()
  c.hud.show(false)
  c.audio.musicLevel(0, 1)
  c.audio.musicLowpass(18_000, 1)
  d.endT = 0
  const rows = ledgerRows(d)
  const ms = rows.map((r) => r.ms).filter((m): m is number => m !== null)
  const avg = ms.length > 0 ? ms.reduce((a, b) => a + b, 0) / ms.length : null
  setTimeout(() => {
    c.hud.showEnd(rows, {
      stats: {
        cowardice: c.save.cowardice,
        avg,
        assist: c.save.assistUsed,
        legend: c.save.legend,
        legendUnlocked: c.save.legendUnlocked,
        total: run.total,
        best: c.save.bestTotal,
        ranked: d.ranked,
      },
      onAgain: () => d.restartRun(false),
      onLegend: () => d.restartRun(true),
      onBoard: () => d.openBoard(true),
    })
  }, LEDGER_DELAY_MS)
  endShot(d)
}

export function tickEnd(d: Director, dt: number): void {
  d.endT += dt
  // the victory bells keep tolling to twelve under the ledger
  if (d.midnightBells > 0 && d.midnightBells < 12 && d.realTime >= d.nextToll) {
    d.toll()
  }
}
