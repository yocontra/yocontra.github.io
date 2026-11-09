import { STRONGBOX_RADIUS } from '../ffa/sim/constants.ts'
import { zoneAt } from '../ffa/sim/layout.ts'
import { ladderAt } from '../ffa/sim/roofwalks.ts'
import { calloutTarget, canDuel } from '../ffa/sim/showdown.ts'
import type { World } from '../ffa/sim/state.ts'
import type { Player } from '../ffa/sim/types.ts'

/** Context buttons appear only where the same domain rules can use them. */
export function touchActions(world: World, player: Player) {
  const box = world.strongbox
  const spot = box ? world.layout.strongboxes[box.spot] : undefined
  const strongbox = Boolean(
    box &&
      box.openedBy < 0 &&
      spot &&
      Math.abs(player.y - (spot.y ?? 0)) <= 1.2 &&
      Math.hypot(player.x - spot.x, player.z - spot.z) <= STRONGBOX_RADIUS,
  )
  return {
    use: Boolean(
      player.channel ||
        (player.carried > 0 && zoneAt(world.layout, player.x, player.z, player.y)) ||
        strongbox ||
        ladderAt(player.x, player.z, player.y, player.roof),
    ),
    call: player.calledBy >= 0 || (canDuel(world, player) && calloutTarget(world, player) !== null),
    throw: player.dynamite > 0,
  }
}
