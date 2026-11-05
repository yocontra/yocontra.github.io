import { describe, expect, test as it } from 'bun:test'
import { rankVoicePeers, type VoicePeer } from '../../../src/experiments/out-west/voice/rank.ts'

const peer = (id: number, x: number, z = 0): VoicePeer => ({ id, name: `r${id}`, x, y: 0, z })

const rank = (
  peers: VoicePeer[],
  own = { x: 0, z: 0 },
  mute: number[] = [],
): { ids: number[]; keep: Map<number, number> } => {
  const keep = new Map<number, number>()
  const ids = rankVoicePeers(new Map(peers.map((p) => [p.id, p])), own, {
    max: 4,
    inRange: 24,
    outRange: 28,
    keepMs: 2000,
    now: 10_000,
    muted: new Set(mute),
    keepUntil: keep,
  })
  return { ids, keep }
}

describe('proximity voice ranking', () => {
  it('keeps the nearest four and drops the rest', () => {
    const { ids } = rank([peer(1, 3), peer(2, 4), peer(3, 5), peer(4, 6), peer(5, 7)])
    expect(ids).toEqual([1, 2, 3, 4])
  })

  it('drops anything past the outer radius', () => {
    expect(rank([peer(1, 23), peer(2, 29)]).ids).toEqual([1])
  })

  it('keeps a player that just crossed the fade edge for the grace window', () => {
    const keep = new Map<number, number>()
    const at = (x: number, now: number) =>
      rankVoicePeers(
        new Map([[1, peer(1, x)]]),
        { x: 0, z: 0 },
        {
          max: 4,
          inRange: 24,
          outRange: 28,
          keepMs: 2000,
          now,
          muted: new Set(),
          keepUntil: keep,
        },
      )
    expect(at(23, 10_000)).toEqual([1])
    expect(at(26, 11_000)).toEqual([1])
    expect(at(26, 13_500)).toEqual([])
  })

  it('never subscribes to a muted or blocked player', () => {
    const { ids } = rank([peer(1, 2), peer(2, 3)], { x: 0, z: 0 }, [2])
    expect(ids).toEqual([1])
  })

  it('uses the listener position, not the world origin', () => {
    expect(rank([peer(1, 120)], { x: 100, z: 0 }).ids).toEqual([1])
    expect(rank([peer(1, 20)], { x: 100, z: 0 }).ids).toEqual([])
  })
})
