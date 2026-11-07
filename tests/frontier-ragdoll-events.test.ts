import { describe, expect, it } from 'bun:test'
import { handleEvent, type Sink } from '../src/experiments/out-west/ffa/client/events.ts'
import type { RagdollImpact } from '../src/experiments/out-west/ffa/client/shot-impact.ts'
import { toWireEvent } from '../src/experiments/out-west/ffa/sim/codec-events.ts'

function fixture(impact: RagdollImpact | null = null) {
  const order: string[] = []
  const captured: unknown[][] = []
  const positions = new Map([
    [1, { x: 20, y: 4, z: 64 }],
    [2, { x: 18, y: 5.2, z: 64 }],
  ])
  const sink = {
    net: { you: 0, name: (id: number) => `Player ${id}`, takeRagdollImpact: () => impact },
    hud: { feed: () => undefined },
    posOf: (id: number) => positions.get(id) ?? null,
    crowd: {
      killed: () => order.push('death animation'),
      disarm: () => order.push('disarm'),
      gesture: () => undefined,
    },
    fx: { dust: () => order.push('dust') },
    audio: { play: () => order.push('bodyfall') },
    ragdollKilled: (...args: unknown[]) => {
      order.push('capture actual body')
      captured.push(args)
    },
    ragdollReleased: (id: number) => order.push(`release ${id}`),
  } as unknown as Sink
  return { sink, order, captured, positions }
}

describe('Frontier actual-body death event boundary', () => {
  it('captures the elevated rendered pose before animation/disarming and preserves kill feedback', () => {
    const f = fixture()
    handleEvent(f.sink, toWireEvent({ type: 'kill', victim: 1, killer: 2, flags: 0, bounty: 0 }))
    expect(f.captured).toEqual([[1, { x: 20, y: 4, z: 64 }, { x: 18, y: 5.2, z: 64 }, null]])
    expect(f.order).toEqual([
      'capture actual body',
      'death animation',
      'dust',
      'bodyfall',
      'disarm',
    ])
  })

  it('forwards the authoritative point/direction/weapon unchanged to the physical body', () => {
    const impact = {
      point: { x: 20.1, y: 5.3, z: 64 },
      direction: { x: 0.8, y: -0.6, z: 0 },
      weapon: 0,
    } as const
    const f = fixture(impact)
    handleEvent(f.sink, toWireEvent({ type: 'kill', victim: 1, killer: 2, flags: 0, bounty: 0 }))
    expect(f.captured[0]?.[3]).toBe(impact)
  })

  it.each([1, 99])('gives self/unknown kill source %s no invented impact position', (killer) => {
    const f = fixture()
    handleEvent(f.sink, toWireEvent({ type: 'kill', victim: 1, killer, flags: 0, bounty: 0 }))
    expect(f.captured[0]?.[2]).toBeNull()
  })

  it('does not fabricate a body when no rendered victim position is available', () => {
    const f = fixture()
    f.positions.delete(1)
    handleEvent(f.sink, toWireEvent({ type: 'kill', victim: 1, killer: 2, flags: 0, bounty: 0 }))
    expect(f.captured).toEqual([])
    expect(f.order).toEqual(['disarm'])
  })

  it('releases the physical body before resetting the live weapon on respawn', () => {
    const f = fixture()
    handleEvent(f.sink, toWireEvent({ type: 'respawn', player: 1 }))
    expect(f.order).toEqual(['release 1', 'disarm', 'dust'])
    expect(f.captured).toEqual([])
  })
})
