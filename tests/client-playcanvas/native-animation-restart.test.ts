import { expect, test as it } from 'bun:test'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import { firstPersonFixture } from './first-person-fixture.ts'

it('restarting a one-shot during a blend preserves subsequent native transitions', async () => {
  const f = firstPersonFixture()
  let actor: DuelActor | undefined
  try {
    const loading = DuelActor.create(f.game, '/viewmodels/restart.glb', 'restart test')
    await f.finish()
    actor = await loading
    const anim = actor.model.anim
    if (!anim?.baseLayer) {
      throw new Error('Missing native controller')
    }
    anim.update(0.2)
    actor.play('Gun_Shoot', 0.12)
    anim.update(0.04)
    actor.play('Gun_Shoot', 0)
    expect(() => actor?.play('Walk', 0.12)).not.toThrow()
    anim.update(0.2)
    expect(anim.baseLayer.activeState).toBe('Walk')
    actor.play('Gun_Shoot', 0)
    anim.update(0.5)
    actor.play('Gun_Shoot', 0)
    anim.update(0.05)
    expect(anim.baseLayer.activeStateCurrentTime).toBeCloseTo(0.05)
    expect(() => actor?.play('Run', 0)).not.toThrow()
  } finally {
    actor?.destroy()
    f.dispose()
  }
})
