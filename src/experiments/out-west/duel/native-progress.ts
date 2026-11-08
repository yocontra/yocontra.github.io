import { OUTLAWS } from '../data/outlaws.ts'
import { interlude } from '../meta/events.ts'
import type { RankedSession } from '../net/ranked.ts'
import { resetRun, save } from '../save.ts'
import { LocalDuelClock, type Verdict } from './clock.ts'
import { offerLicensedMode } from './licence-road.ts'
import type { NativeDirector } from './native-director.ts'
import { RankedDuelClock } from './ranked-clock.ts'

export function advance(d: NativeDirector): void {
  if (d.daily) {
    d.leaveSpecial()
    return
  }
  const next = d.level + 1
  d.c.save.level = next
  save(d.c.save)
  if (next >= OUTLAWS.length && !d.c.save.legend) {
    d.finishRun()
    return
  }
  const nextLevel = d.c.save.legend ? next % OUTLAWS.length : next
  d.interluding = true
  void (async () => {
    if (await offerLicensedMode(d, nextLevel)) {
      return
    }
    await interlude({ kind: 'next', level: nextLevel })
    await d.startLevel(nextLevel)
  })()
    .catch((error: unknown) =>
      d.c.hud.fake(error instanceof Error ? error.message : 'Could not start the next duel.', 4000),
    )
    .finally(() => {
      d.interluding = false
    })
}

export function retry(d: NativeDirector): void {
  if (d.daily) {
    d.leaveSpecial()
    return
  }
  void d.startLevel(d.level, true)
}

export function restartRun(d: NativeDirector, legend: boolean): void {
  resetRun(d.c.save, legend)
  save(d.c.save)
  void d.begin(true, !legend)
}

export function finishRun(d: NativeDirector): void {
  d.enter('end')
  const data = d.c.save
  data.legendUnlocked = true
  data.bestTotal = Math.max(data.bestTotal, data.run.total)
  save(data)
  d.c.hud.hideCard()
  d.c.hud.show(false)
  const rows = OUTLAWS.map((outlaw, level) => ({
    name: outlaw.name,
    ms: data.best[level]?.ms ?? null,
    grade: data.best[level]?.grade ?? '—',
    attempts: data.attempts[level] ?? 0,
    paid: d.clock instanceof RankedDuelClock ? d.clock.paidFor(level) : null,
  }))
  const times = rows.flatMap((row) => (row.ms === null ? [] : [row.ms]))
  d.c.hud.showEnd(rows, {
    stats: {
      cowardice: data.cowardice,
      avg: times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : null,
      assist: data.assistUsed,
      legend: data.legend,
      legendUnlocked: data.legendUnlocked,
      total: data.run.total,
      best: data.bestTotal,
      ranked: d.ranked,
    },
    onAgain: () => d.restartRun(false),
    onLegend: () => d.restartRun(true),
    onBoard: () => d.openBoard(),
    onSaloon: () => d.saloon(),
  })
}

export function openBoard(d: NativeDirector): void {
  const clock = d.clock
  if (clock instanceof RankedDuelClock && d.c.save.run.total > 0) {
    d.board.open({ purse: d.c.save.run.total, submit: (name) => clock.bank(name) })
  } else {
    d.board.open({ note: 'Practice runs aren’t ranked.' })
  }
}

export function togglePause(d: NativeDirector): void {
  if (d.phase === 'title' || d.phase === 'end') {
    return
  }
  if (d.paused) {
    d.resume()
    return
  }
  d.paused = true
  d.c.input.enabled = false
  if (!d.ranked) {
    d.clock.cancel()
  }
  d.c.hud.openMenu(d.c.save.settings, {
    resume: () => d.resume(),
    change: () => {
      d.applySettings()
      save(d.c.save)
    },
    restart: () => {
      d.resume()
      d.restartRun(d.c.save.legend)
    },
    saloon: () => d.saloon(),
    remap: (_action, done) => {
      d.c.input.capture = (code) => {
        d.c.input.capture = null
        done(code)
      }
    },
  })
}

export function pauseIfPlaying(d: NativeDirector): void {
  if (!d.paused) {
    d.togglePause()
  }
}

export function resume(d: NativeDirector): void {
  d.paused = false
  d.c.input.enabled = true
  d.c.hud.closeMenu()
  if (!d.ranked && d.phase === 'wait') {
    d.wait()
  }
}

export function saloon(d: NativeDirector): void {
  d.epoch++
  d.remote?.close()
  d.remote = null
  d.leaveSpecial()
  d.clock.cancel()
  d.paused = false
  d.c.input.enabled = true
  d.c.hud.closeMenu()
  d.c.hud.hideCard()
  d.c.hud.hideEnd()
  d.c.hud.show(false)
  d.enemy?.destroy()
  d.enemy = null
  d.rifleman?.destroy()
  d.rifleman = null
  d.c.audio.heartbeat(0)
  d.enter('title')
  d.hubShot('hub')
  d.onSaloon?.()
}

export async function dailyDuel(
  d: NativeDirector,
  spec: { outlaw: number; modifiers: readonly string[] },
  session: RankedSession,
  exit: (verdict: Verdict | null, ms: number | null) => void,
): Promise<void> {
  d.leaveSpecial()
  d.clock.dispose()
  d.clock = new RankedDuelClock(session, d.events)
  d.specialSave = d.c.save
  d.c.save = structuredClone(d.c.save)
  d.exitDuel = exit
  d.dailyModifiers = spec.modifiers
  d.arenas.dailyFog(spec.modifiers.includes('fog'))
  d.dailyVerdict = null
  d.c.hud.setMode('DAILY OUTLAW')
  d.c.hud.setDaily(true)
  await d.startLevel(spec.outlaw)
}

export function leaveSpecial(d: NativeDirector): void {
  if (d.specialSave) {
    d.c.save = d.specialSave
    d.specialSave = null
    save(d.c.save)
  }
  const exit = d.exitDuel
  if (!exit) {
    return
  }
  d.exitDuel = null
  d.dailyModifiers = []
  d.arenas.dailyFog(false)
  d.clock.dispose()
  d.clock = new LocalDuelClock(d.events)
  d.c.hud.setDaily(false)
  d.c.hud.hideCard()
  d.c.hud.show(false)
  d.enter('title')
  d.hubShot('hub')
  exit(d.dailyVerdict, d.reactionMs)
}
