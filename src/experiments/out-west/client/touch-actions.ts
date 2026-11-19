import { ladderAt } from '../ffa/sim/roofwalks.ts'
import { calloutChallenger, calloutTarget, canIssueCallout } from '../ffa/sim/showdown.ts'
import type { World } from '../ffa/sim/state.ts'
import type { Player } from '../ffa/sim/types.ts'

/** Context buttons appear only where the same domain rules can use them. */
export function touchActions(world: World, player: Player) {
  return {
    use: ladderAt(player.x, player.z, player.y, player.roof) !== null,
    call:
      calloutChallenger(world, player) !== null ||
      (canIssueCallout(world, player) && calloutTarget(world, player) !== null),
    throw: player.dynamite > 0,
  }
}
