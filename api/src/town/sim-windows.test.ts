import { describe, expect, test as it } from 'bun:test'
import {
  townWindows,
  type WindowOpening,
  windowPane,
} from '../../../src/experiments/out-west/ffa/sim/building-rules.ts'
import { TOWN } from '../../../src/experiments/out-west/ffa/sim/layout.ts'
import { shatterGlass } from '../../../src/experiments/out-west/ffa/sim/windows.ts'
import { testWorld } from './test-helpers.ts'
import { nativeWorld } from './testing/native.ts'

/** A ground-floor window on a hollow building, with the opening clear of the eave. */
function openWindow() {
  for (const { b, w, index } of townWindows(TOWN)) {
    if (b.hollow && w.floor === 0 && w.top + 0.3 < b.height) {
      return { b, w, index, pane: windowPane(b, w) }
    }
  }
  throw new Error('no ground-floor window in the layout')
}

/** A shot from `out` metres outside the pane, aimed straight through it. */
function throughPane(win: WindowOpening, pane: ReturnType<typeof windowPane>, out: number) {
  const across = (pane.a0 + pane.a1) / 2
  let ox = across
  let oz = across
  let dx = 0
  let dz = 0
  if (pane.axis === 0) {
    ox = pane.at + (win.side === 'e' ? out : -out)
    dx = win.side === 'e' ? -1 : 1
  } else {
    oz = pane.at + (win.side === 's' ? out : -out)
    dz = win.side === 's' ? -1 : 1
  }
  return { ox, oy: (pane.y0 + pane.y1) / 2, oz, dx, dz }
}

describe('breakable windows', () => {
  it('native frame colliders leave the shot opening clear before and after the pane breaks', async () => {
    const { world: w, physics } = await nativeWorld()
    const { w: win, index, pane } = openWindow()
    const ray = { ...throughPane(win, pane, 1), dy: 0, maxT: 2 }
    expect(physics.castWorld(ray)).toBeNull()
    expect(w.glass[index]).toBe(0)
    shatterGlass(w, ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, ray.maxT)
    expect(w.glass[index]).toBe(1)
    expect(w.events).toContainEqual({ type: 'glass_break', window: index })
    expect(physics.castWorld(ray)).toBeNull()
    expect(physics.castWorld({ ...ray, oy: pane.y0 - 0.2 })).toBeLessThan(2)
    expect(physics.castWorld({ ...ray, oy: pane.y1 + 0.2 })).toBeLessThan(2)
  })
  it('a shot through the opening shatters the pane and carries on', () => {
    const w = testWorld()
    const { w: win, index, pane } = openWindow()
    const out = 3
    const ray = throughPane(win, pane, out)
    expect(w.glass[index]).toBe(0)
    shatterGlass(w, ray.ox, ray.oy, ray.oz, ray.dx, 0, ray.dz, out * 2)
    expect(w.glass[index]).toBe(1)
    expect(w.events).toContainEqual({ type: 'glass_break', window: index })
  })

  it('the same pane breaks once, not once per pellet', () => {
    const w = testWorld()
    const { w: win, index, pane } = openWindow()
    const out = 2
    const ray = throughPane(win, pane, out)
    shatterGlass(w, ray.ox, ray.oy, ray.oz, ray.dx, 0, ray.dz, out * 2)
    shatterGlass(w, ray.ox, ray.oy, ray.oz, ray.dx, 0, ray.dz, out * 2)
    expect(w.events.filter((e) => e.type === 'glass_break')).toHaveLength(1)
    expect(w.glass[index]).toBe(1)
  })
})
