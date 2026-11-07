/** Ordered live snapshots followed by uncapped authoritative state on full/overflow recovery. */
import type { ServerControl } from '../../../src/experiments/out-west/contract/town.ts'
import type { Writer } from '../../../src/experiments/out-west/ffa/sim/bytes.ts'
import {
  eventRelevant,
  persistentStateFor,
  snapshotFor,
} from '../../../src/experiments/out-west/ffa/sim/snapshot.ts'
import type { World } from '../../../src/experiments/out-west/ffa/sim/state.ts'
import type { CoreMetrics, Session } from './core.ts'

export function broadcastSnapshots({
  world,
  sessions,
  writer,
  metrics,
}: {
  world: World
  sessions: Iterable<Session>
  writer: Writer
  metrics: CoreMetrics
}): void {
  let persistentText: string | undefined
  for (const session of sessions) {
    const player = world.players[session.playerId]
    if (!(session.peer && player)) {
      continue
    }
    const full = session.stream.full
    const overflow =
      world.events.length > 255 &&
      world.events.filter((event) => eventRelevant(world, event, player)).length > 255
    const bytes = snapshotFor(
      world,
      { viewer: player, stream: session.stream },
      { banked: session.banked, events: world.events, inputLead: session.queue.takeLead() },
      writer,
    )
    session.peer.send(bytes)
    metrics.bytesOut += bytes.length
    metrics.msgsOut++
    if (full || overflow) {
      persistentText ??= JSON.stringify({
        type: 'town_state',
        state: persistentStateFor(world),
      } satisfies ServerControl)
      session.peer.send(persistentText)
      metrics.bytesOut += persistentText.length
      metrics.msgsOut++
    }
  }
}
