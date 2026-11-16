/** Read-only qualification surface. Imported only by explicit local QA production builds. */
import { revision, version } from 'playcanvas'
import type { SimEvent } from '../ffa/sim/types.ts'
import type { FrontierSession } from './frontier-session.ts'
import type { GameViewport } from './viewport.ts'

export function performanceSnapshot(session: FrontierSession, game: GameViewport): () => void {
  const events: {
    type: SimEvent['type']
    tick: number
    at: number
    wall: number
    self: boolean
  }[] = []
  const unsubscribe = session.subscribe((event) => {
    if (events.length >= 4096 || !['shot', 'kill', 'respawn', 'glass_break'].includes(event.type)) {
      return
    }
    events.push({
      type: event.type,
      tick: session.world.tick,
      at: performance.now(),
      wall: Date.now(),
      self:
        ('shooter' in event && event.shooter === session.selfSlot) ||
        ('victim' in event && event.victim === session.selfSlot) ||
        ('player' in event && event.player === session.selfSlot),
    })
  })
  Reflect.set(globalThis, '__owPerformanceSnapshot', (history = false) => {
    const self = session.world.players[session.selfSlot]
    return structuredClone({
      qaInstrumentation: true,
      development: import.meta.env.DEV,
      engine: { version, revision },
      lobbyId: session.lobbyId,
      tick: session.world.tick,
      selfSlot: session.selfSlot,
      self: self && {
        alive: self.alive,
        x: self.x,
        y: self.y,
        z: self.z,
        shots: self.stats.shots,
        deaths: self.stats.deaths,
        spawnTick: self.spawnTick,
        lastButtons: self.lastButtons,
      },
      scene: game.debug(),
      brokenWindows: [...session.world.glass.entries()]
        .filter(([, broken]) => broken)
        .map(([index]) => index),
      ...(history ? { events } : {}),
    })
  })
  return () => {
    unsubscribe()
    Reflect.deleteProperty(globalThis, '__owPerformanceSnapshot')
  }
}
