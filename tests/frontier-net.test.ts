import { describe, expect, it } from 'bun:test'
import { domainInput } from '../src/experiments/out-west/client/frontier-session.ts'
import { assertCompatibility } from '../src/experiments/out-west/client/state.ts'
import { COLLISION_VERSION } from '../src/experiments/out-west/content/manifest.ts'
import {
  Buttons,
  neutralInput,
  PROTOCOL_VERSION,
} from '../src/experiments/out-west/runtime/protocol.ts'
import { FrontierState } from '../src/experiments/out-west/runtime/schema.ts'

describe('Frontier native welcome compatibility', () => {
  it('accepts the exact protocol and collision content the client predicts', () => {
    const state = new FrontierState()
    state.protocol = PROTOCOL_VERSION
    state.content = COLLISION_VERSION
    expect(() => assertCompatibility(state)).not.toThrow()
  })
  it.each([0, PROTOCOL_VERSION + 1, -1])(
    'rejects incompatible protocol %d before prediction',
    (protocol) => {
      const state = new FrontierState()
      state.protocol = protocol
      state.content = COLLISION_VERSION
      expect(() => assertCompatibility(state)).toThrow('updated')
    },
  )
  it('rejects stale collision content even when the protocol matches', () => {
    const state = new FrontierState()
    state.protocol = PROTOCOL_VERSION
    state.content = 'previous-town'
    expect(() => assertCompatibility(state)).toThrow('updated')
  })
  it.each([
    [0, 49_152],
    [-Math.PI / 2, 0],
    [Math.PI, 16_384],
    [Math.PI / 2, 32_768],
  ])('maps camera yaw %f to the same domain firing direction', (yaw, aim) => {
    const frame = domainInput({ ...neutralInput(), yaw }, 1, 20)
    expect(frame.aim).toBe(aim)
  })
  it('retains integer pitch and every gameplay button in the shared input intent', () => {
    const buttons = Object.values(Buttons).reduce((all, bit) => all | bit, 0)
    const frame = domainInput(
      { ...neutralInput(), buttons, pitch: ((1.6 / 127) * Math.PI) / 2, moveX: 0.5 },
      31,
      200,
    )
    expect(frame.pitch).toBe(2)
    expect(frame.buttons).toBe(buttons)
    expect(frame.seq).toBe(31)
    expect(frame.viewTime).toBe(200)
    expect(frame.moveX).toBe(64)
  })
})
