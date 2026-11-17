import { Vec3 } from 'playcanvas'
import type { Actors } from './actors.ts'
import type { GameApplication } from './application.ts'
import { GameEffects } from './effects.ts'
import type { BreakableProps } from './environment-response.ts'
import type { FrontierItems } from './items.ts'
import type { GameSession } from './viewport.ts'
import type { BreakableWindows } from './windows.ts'

export function createEffects(
  application: GameApplication,
  actors: Actors,
  session: GameSession,
  scenery: { windows: BreakableWindows; items: FrontierItems; props: BreakableProps },
): GameEffects {
  const { windows, items, props } = scenery
  return new GameEffects(application, {
    event: (event) => {
      windows.event(event)
      if (event.type === 'prop_break') {
        return props.event(event)
      }
      if (event.type === 'dynamite_thrown') {
        const id = String(event.player)
        const player = session.players.get(id)
        const hand = actors.throwDynamite(id)
        if (player) {
          items.throwDynamite(event, new Vec3(player.x, player.y + 0.45, player.z), hand)
        }
      } else if (event.type === 'respawn') {
        actors.cancelThrow(String(event.player))
      }
      return false
    },
    fire: (id) => actors.fire(id),
    muzzle: (id) => actors.muzzle(id),
    trace: (from, to) => session.cameraTrace?.(from, to),
    riders: () => session.players,
    selfId: () => session.selfId,
    world: () => session.world,
    spurs: (id) => session.appearance?.(id)?.loadout.spurs,
  })
}
