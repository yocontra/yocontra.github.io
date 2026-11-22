import { expect, test as it } from 'bun:test'
import { GameInput } from '../../src/experiments/out-west/client/input.ts'
import type { ViewMode } from '../../src/experiments/out-west/ffa/client/settings.ts'
import { Buttons } from '../../src/experiments/out-west/runtime/protocol.ts'

function inputFixture(view: ViewMode, actionButtons = 0): GameInput {
  return Object.assign(Object.create(GameInput.prototype) as GameInput, {
    controls: { inert: false },
    settings: { view, invertY: false },
    keyboard: { isPressed: () => false },
    actionButtons: () => actionButtons,
    touchX: 0,
    touchZ: 0,
    yaw: 0,
    pitch: 0,
  })
}

it('resists only moving controller ADS look and preserves other aim input', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'getGamepads')
  const pad = {
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 13 }, () => ({ pressed: false })),
  }
  let hasController = true
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => (hasController ? [pad] : []),
  })
  let traces = 0
  const resistance = () => {
    traces++
    return 0.78
  }
  try {
    const trigger = pad.buttons[6]
    if (!trigger) {
      throw new Error('Missing controller ADS trigger')
    }
    pad.axes[2] = 0.5
    pad.axes[3] = -0.5
    const hip = inputFixture('third', Buttons.aim).sample(0, 0.1, resistance)
    expect(hip.yaw).toBeCloseTo(-0.225)
    expect(hip.pitch).toBeCloseTo(0.15)
    expect(traces).toBe(0)

    trigger.pressed = true
    const ads = inputFixture('first').sample(0, 0.1, resistance)
    expect(ads.yaw).toBeCloseTo(hip.yaw * 0.78)
    expect(ads.pitch).toBeCloseTo(hip.pitch * 0.78)
    expect(ads.buttons & Buttons.aim).toBe(Buttons.aim)
    expect(traces).toBe(1)

    const top = inputFixture('top').sample(0, 0.1, resistance)
    expect(top.yaw).toBeCloseTo(-Math.PI / 4)
    expect(top.pitch).toBe(0)
    expect(traces).toBe(1)

    pad.axes[2] = 0.05
    pad.axes[3] = 0.05
    const idle = inputFixture('third').sample(0, 0.1, resistance)
    expect(idle.yaw).toBe(0)
    expect(idle.pitch).toBe(0)
    expect(traces).toBe(1)

    hasController = false
    const mouse = inputFixture('third', Buttons.aim)
    mouse.yaw = 0.27
    mouse.pitch = -0.13
    const intent = mouse.sample(0, 0.1, resistance)
    expect(intent.yaw).toBe(mouse.yaw)
    expect(intent.pitch).toBe(mouse.pitch)
    expect(traces).toBe(1)
  } finally {
    if (original) {
      Object.defineProperty(navigator, 'getGamepads', original)
    } else {
      Reflect.deleteProperty(navigator, 'getGamepads')
    }
  }
})
