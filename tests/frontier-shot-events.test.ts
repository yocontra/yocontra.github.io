import { describe, expect, it } from 'bun:test'
import { Vector3 } from 'three'
import type { AudioEngine } from '../src/experiments/out-west/audio/audio.ts'
import {
  EV_GLASS_BREAK,
  EV_SHOT,
  NONE,
  SHOT_HIT,
  SHOT_WALL,
} from '../src/experiments/out-west/contract/town.ts'
import { handleEvent, type Sink } from '../src/experiments/out-west/ffa/client/events.ts'
import { townWindows, windowPane } from '../src/experiments/out-west/ffa/sim/building-rules.ts'
import { toWireEvent } from '../src/experiments/out-west/ffa/sim/codec-events.ts'
import { buildGrid, TOWN } from '../src/experiments/out-west/ffa/sim/layout.ts'

function fixture(you: number) {
  const traces: unknown[][] = []
  const impacts: unknown[][] = []
  const holes: unknown[][] = []
  const sounds: unknown[][] = []
  const cases: unknown[][] = []
  const glass: unknown[][] = []
  const sink = {
    net: { you, grid: buildGrid() },
    crowd: { fired: () => undefined },
    hud: { hit: () => undefined },
    posOf: () => ({ x: 90, y: 8, z: 64 }),
    muzzleOf: () => new Vector3(90, 9.4, 64),
    fx: {
      shot: (...args: unknown[]) => traces.push(args),
      impactAt: (...args: unknown[]) => impacts.push(args),
      hole: (...args: unknown[]) => holes.push(args),
      casing: (...args: unknown[]) => cases.push(args),
      glass: (...args: unknown[]) => glass.push(args),
    },
    audio: {
      play: (...args: unknown[]) => sounds.push(args),
      impact: (...args: unknown[]) => sounds.push(args),
      whizz: () => undefined,
    } as unknown as AudioEngine,
    breakWindow: () => undefined,
  } as unknown as Sink
  return { sink, traces, impacts, holes, sounds, cases, glass }
}

function shot(flags: number) {
  return toWireEvent({
    type: 'shot',
    shooter: 1,
    target: NONE,
    flags,
    aim: 0,
    range: 40,
    x: 20,
    z: 64,
    y: 12,
    origin: { x: 20, y: 8.62, z: 64 },
    end: { x: 28.5, y: 1.23, z: 64 },
    pellets: [],
  })
}

describe('Frontier authoritative shot feedback', () => {
  it('uses wire geometry after the rendered shooter has moved, and puts blood at the exact height', () => {
    const f = fixture(0)
    const ev = shot(SHOT_HIT)
    expect(ev.type).toBe(EV_SHOT)
    handleEvent(f.sink, ev)
    expect(f.traces[0]?.[0]).toEqual(new Vector3(20, 8.62, 64))
    expect(f.traces[0]?.[1]).toEqual({ x: 28.5, y: 1.23, z: 64 })
    expect(f.impacts).toEqual([[28.5, 1.23, 64, true]])
    expect(f.sounds[0]?.[1]).toMatchObject({ pos: new Vector3(20, 8.62, 64) })
  })

  it('corrects a locally predicted ray without repeating its flash and places wall decals in 3D', () => {
    const f = fixture(1)
    handleEvent(f.sink, shot(SHOT_WALL))
    expect(f.traces[0]?.[3]).toBe(false)
    expect(f.cases.length).toBe(1)
    expect(f.impacts).toEqual([[28.5, 1.23, 64, false]])
    expect(f.holes[0]?.slice(0, 3)).toEqual([28.5, 1.23, 64])
    expect(Number(f.holes[0]?.[4])).toBeGreaterThan(0)
    expect(f.sounds.some((args) => args[0] === 'fire')).toBe(false)
  })

  it('plays an upper-storey window shatter at the pane, alongside its shards', () => {
    const f = fixture(0)
    const opening = townWindows(TOWN).find(({ b, w }) => windowPane(b, w).y0 > 3)
    if (!opening) {
      throw new Error('the town has no upper-storey window to test')
    }
    const pane = windowPane(opening.b, opening.w)
    const across = (pane.a0 + pane.a1) / 2
    const at = {
      x: pane.axis === 0 ? pane.at : across,
      y: (pane.y0 + pane.y1) / 2,
      z: pane.axis === 0 ? across : pane.at,
    }
    handleEvent(f.sink, { type: EV_GLASS_BREAK, window: opening.index })
    expect(at.y).toBeGreaterThan(3)
    expect(f.glass).toEqual([[at.x, at.y, at.z]])
    expect(f.sounds).toEqual([['bottle', { pos: at, gain: 0.7 }]])
  })
})
