import { describe, expect, test as it } from 'bun:test'
import { ShowdownInput } from '../../src/experiments/out-west/client/showdown-input.ts'
import { createWorld, newPlayer } from '../../src/experiments/out-west/ffa/sim/state.ts'
import { Buttons, type PlayerInput } from '../../src/experiments/out-west/runtime/protocol.ts'

const intent = (buttons: number): PlayerInput => ({
  seq: 1,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons,
})
function fixture(phase: 'wait' | 'called') {
  const world = createWorld()
  const self = newPlayer(0, { accountId: 'test', name: 'You', level: 1, prestige: 0, bot: false })
  self.showdown = 7
  world.players[0] = self
  world.showdowns.set(7, {
    id: 7,
    a: 0,
    b: 1,
    cx: 72,
    cz: 66,
    startTick: 0,
    callTick: 10,
    fakeTicks: [],
    phase,
  })
  const sent: { type: string; showdownId: number; localMs: number | null }[] = []
  return {
    world,
    sent,
    input: new ShowdownInput({ world, self: 0, send: (text) => sent.push(JSON.parse(text)) }),
  }
}
describe('native Frontier quick draw', () => {
  it('reports a measured wall-clock draw once, independently of simulation input packets', () => {
    const { input, sent } = fixture('called')
    input.control({ type: 'showdown_call', showdownId: 7 })
    input.sample(intent(Buttons.fire))
    input.sample(intent(0))
    input.sample(intent(Buttons.fire))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.type).toBe('showdown_shot')
    expect(sent[0]?.showdownId).toBe(7)
    expect(sent[0]?.localMs).toBeGreaterThanOrEqual(0)
  })
  it('an early held trigger cannot become a valid draw when the bell arrives', () => {
    const { input, world, sent } = fixture('wait')
    input.sample(intent(Buttons.fire))
    const showdown = world.showdowns.get(7)
    if (showdown) {
      showdown.phase = 'called'
    }
    input.control({ type: 'showdown_call', showdownId: 7 })
    input.sample(intent(Buttons.fire))
    expect(sent).toHaveLength(0)
  })
  it('a restored ongoing showdown uses server arrival timing when no live bell was heard', () => {
    const { input, sent } = fixture('called')
    input.sample(intent(Buttons.fire))
    expect(sent[0]?.localMs).toBeNull()
  })
})
