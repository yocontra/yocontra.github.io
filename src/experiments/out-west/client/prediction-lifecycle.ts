/** Native SDK interpolation/history belongs to one player life, never a respawn. */
import type { Predict } from '@colyseus/sdk'
import type { PlayerRecord } from '../runtime/schema.ts'

type Predictor = ReturnType<typeof Predict.get>
export const REMOTE_POSE = {
  mode: 'lerp' as const,
  fields: ['x', 'y', 'z'] as const,
  snap: 2,
}
/** Facing lerps on the same 100 ms delay as position, so a remote body never turns before it moves. */
export const REMOTE_YAW = {
  mode: 'lerp' as const,
  fields: ['yaw'] as const,
  angle: true,
}

export function playerLifetimeSync(
  selfId: string,
  predict: Pick<Predictor, 'detach' | 'attach'>,
  mine: { reset: () => void },
  onReset: (id: string) => void,
): (players: Iterable<PlayerRecord>) => void {
  const spawns = new Map<string, number>()
  return (players) => {
    const present = new Set<string>()
    for (const player of players) {
      present.add(player.id)
      const previous = spawns.get(player.id)
      spawns.set(player.id, player.spawnTick)
      if (previous === undefined || previous === player.spawnTick) {
        continue
      }
      if (player.id === selfId) {
        // reset() adopts authority and drops the previous life's pending input/error offsets.
        mine.reset()
      } else {
        predict.detach(player)
        predict.attach(player, REMOTE_POSE)
        predict.attach(player, REMOTE_YAW)
      }
      onReset(player.id)
    }
    for (const id of spawns.keys()) {
      if (!present.has(id)) {
        spawns.delete(id)
      }
    }
  }
}
