import { describe, expect, it } from 'bun:test'
import { Scene } from 'three'
import { Renderer } from '../src/experiments/out-west/engine/render.ts'
import { QUALITIES, specFor } from '../src/experiments/out-west/engine/tiers.ts'
import { crowdBudget, weatherFog } from '../src/experiments/out-west/ffa/client/quality.ts'
import { policyFor } from '../src/experiments/out-west/ffa/client/view.ts'

describe('Frontier render policy', () => {
  it('notifies the scene after an adaptive tier change has updated shadow rendering', () => {
    const renderer = Object.create(Renderer.prototype) as Renderer
    const shadow = { enabled: true }
    let notifications = 0
    Object.assign(renderer, {
      tier: 'high',
      mode: 'ffa',
      spec: specFor('high', 'ffa'),
      scene: new Scene(),
      gl: { shadowMap: shadow },
      baseDpr: () => 1,
      resize: () => undefined,
      applyPostForTier: () => {
        shadow.enabled = renderer.spec.fullPost
      },
      onTierChange: () => {
        notifications++
        expect(renderer.tier).toBe('legacy')
        expect(crowdBudget(renderer.tier, shadow.enabled).casters).toBe(0)
      },
    })
    renderer.setTier('legacy')
    expect(notifications).toBe(1)
    renderer.setTier('legacy')
    expect(notifications).toBe(1)
  })

  it('uses blobs for every rider whenever real shadow rendering is off', () => {
    for (const tier of QUALITIES) {
      expect(crowdBudget(tier, false).casters).toBe(0)
      expect(crowdBudget(tier, true).casters).toBeGreaterThan(0)
    }
    const near = QUALITIES.map((tier) => crowdBudget(tier, false).near)
    expect(near).toEqual([...near].sort((a, b) => b - a))
    expect(crowdBudget('legacy', false).near).toBeLessThan(crowdBudget('floor', false).near)
  })

  it('keeps clear and storm fog within every view and tier clipping distance', () => {
    const fog = { near: 0, far: 0 }
    for (const tier of QUALITIES) {
      for (const mode of ['top', 'first', 'third'] as const) {
        const policy = policyFor(mode, tier)
        weatherFog(policy, 0, fog)
        const clear = fog.far
        expect(fog.near).toBeLessThan(fog.far)
        expect(fog.far).toBeLessThan(policy.far)
        weatherFog(policy, 1, fog)
        expect(fog.near).toBeLessThan(fog.far)
        expect(fog.far).toBeLessThan(clear)
      }
    }
  })

  it('does not replace low-tier shooter fog with top-down weather distances', () => {
    const fog = { near: 0, far: 0 }
    weatherFog(policyFor('first', 'floor'), 0, fog)
    expect(fog).toEqual({ near: 30, far: 92 })
    weatherFog(policyFor('third', 'high'), 0, fog)
    expect(fog).toEqual({ near: 70, far: 225 })
  })

  it('fits top-down fog to its resized lens rather than only the nominal policy distance', () => {
    const fog = { near: 0, far: 0 }
    weatherFog(policyFor('top', 'high'), 0, fog, 110)
    expect(fog.far).toBe(108)
    expect(fog.near).toBeLessThan(fog.far)
  })
})
