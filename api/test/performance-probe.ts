/** Local fixture only: observe real room ticks and stage deterministic lifecycle transitions. */
import { applyFallDamage } from '../../src/experiments/out-west/ffa/sim/death.ts'
import { activePlayers } from '../../src/experiments/out-west/ffa/sim/state.ts'
import { breakGlass } from '../../src/experiments/out-west/ffa/sim/windows.ts'
import type { LobbyCore } from '../src/town/core.ts'

export class PerformanceProbe {
  private readonly start = Date.now()
  private readonly events: { type: string; tick: number; wall: number; self: boolean }[] = []
  private readonly samples: ReturnType<PerformanceProbe['sample']>[] = []
  private readonly interventions: { type: string; tick: number; wall: number }[] = []
  private window = -1
  private readonly completed = new Set<string>()
  private readonly core: LobbyCore
  private readonly self: number
  private readonly originalTick: LobbyCore['tick']
  constructor(core: LobbyCore, self: number) {
    this.core = core
    this.self = self
    const tick = core.tick.bind(core)
    this.originalTick = tick
    core.tick = (...args) => {
      const output = tick(...args)
      this.transition()
      for (const event of core.world.events) {
        if (
          this.events.length < 4096 &&
          ['shot', 'kill', 'respawn', 'glass_break'].includes(event.type)
        ) {
          this.events.push({
            type: event.type,
            tick: core.world.tick,
            wall: Date.now(),
            self:
              ('shooter' in event && event.shooter === self) ||
              ('victim' in event && event.victim === self) ||
              ('player' in event && event.player === self),
          })
        }
      }
      if (Date.now() - (this.samples.at(-1)?.wall ?? 0) >= 1000) {
        this.samples.push(this.sample())
      }
      // Keep fixture observation bounded even if the browser disappears.
      if (Date.now() - this.start >= 120_000) {
        core.tick = tick
      }
      return output
    }
  }
  stop(): void {
    this.core.tick = this.originalTick
  }
  private transition(): void {
    const elapsed = Date.now() - this.start
    const world = this.core.world
    const self = world.players[this.self]
    if (!self) {
      return
    }
    if (!this.completed.has('break') && elapsed >= 10_000) {
      const pane = [...world.grid.glass]
        .filter((candidate) => world.glass[candidate.index] === 0)
        .sort((a, b) => {
          const distance = (p: typeof a) =>
            Math.hypot(
              (p.axis === 0 ? p.at : (p.a0 + p.a1) / 2) - self.x,
              (p.axis === 0 ? (p.a0 + p.a1) / 2 : p.at) - self.z,
            )
          return distance(a) - distance(b)
        })[0]
      if (pane) {
        this.window = pane.index
        breakGlass(world, this.window)
        this.completed.add('break')
        this.interventions.push({ type: 'glass-break', tick: world.tick, wall: Date.now() })
      }
    }
    if (!this.completed.has('death') && elapsed >= 20_000 && self.alive) {
      applyFallDamage(world, self, 1000)
      if (!self.alive) {
        this.completed.add('death')
      }
      this.interventions.push({ type: 'environmental-death', tick: world.tick, wall: Date.now() })
    }
    if (!this.completed.has('reset') && this.completed.has('break') && elapsed >= 35_000) {
      world.glass[this.window] = 0
      this.completed.add('reset')
      this.interventions.push({ type: 'glass-reset', tick: world.tick, wall: Date.now() })
    }
  }
  private sample() {
    const players = [...activePlayers(this.core.world)]
    const self = this.core.world.players[this.self]
    return {
      wall: Date.now(),
      tick: this.core.world.tick,
      players: players.length,
      bots: players.filter((player) => player.bot).length,
      humans: this.core.connectedHumans(),
      window: this.window,
      windowBroken: this.core.world.glass[this.window] === 1,
      self: self && {
        x: self.x,
        y: self.y,
        z: self.z,
        alive: self.alive,
        shots: self.stats.shots,
        deaths: self.stats.deaths,
      },
    }
  }
  snapshot() {
    return {
      start: this.start,
      scriptedServerTransitions: true,
      current: this.sample(),
      samples: this.samples,
      events: this.events,
      interventions: this.interventions,
    }
  }
}
