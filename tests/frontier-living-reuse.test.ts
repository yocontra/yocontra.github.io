import { expect, it, spyOn } from 'bun:test'
import { file } from 'bun'
import { type Group, Scene, Texture } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { ANIM_IDLE, EF_ALIVE } from '../src/experiments/out-west/contract/town.ts'
import { type Assets, markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { Crowd, type CrowdPlayer } from '../src/experiments/out-west/ffa/scene/crowd.ts'
import { lookFor } from '../src/experiments/out-west/ffa/scene/looks.ts'
import type { Actor } from '../src/experiments/out-west/scene/actor.ts'

it('parks actual prepared roster actors without scene or mixer work and reenters with the same independent instances', async () => {
  const look = lookFor(['outfit.striped-poncho', 'gun.hardins-pair'], 701)
  const assets = await realAssets(look.look.base)
  const texture = assets.tex.ground
  const scene = new Scene()
  const previousDocument = Reflect.get(globalThis, 'document')
  Reflect.set(globalThis, 'document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  })
  const crowd = new Crowd(scene, assets, 2)
  // This regression isolates living actor ownership; VAT construction/rendering has its own suite.
  Reflect.set(crowd, 'ensureVat', async () => undefined)
  crowd.setLook(701, look)
  crowd.setLook(702, look)
  await crowd.prepareLooks()
  await crowd.precast(2, 701, (id) => id)
  const members = Reflect.get(crowd, 'members') as Map<number, { actor: Actor; holder: Group }>
  const first = members.get(701)
  const second = members.get(702)
  if (!(first?.actor && second?.actor)) {
    throw new Error('Actual prepared actors did not build')
  }
  const firstUpdate = spyOn(first.actor, 'update')
  const secondUpdate = spyOn(second.actor, 'update')
  const rows: CrowdPlayer[] = [701, 702].map((id) => ({
    id,
    x: id - 701,
    y: 0,
    z: 0,
    aim: 0,
    vx: 0,
    vz: 0,
    anim: ANIM_IDLE,
    stance: 0,
    flags: EF_ALIVE,
    self: id === 701,
  }))
  try {
    crowd.update(rows, 0, 0, 1 / 60, 0)
    crowd.selfFade = 0.4
    crowd.update(rows, 0, 0, 1 / 60, 0)
    expect(Reflect.get(crowd, 'selfFaded')).toBe(0.4)
    crowd.releaseCorpse(702)
    expect(Reflect.get(crowd, 'selfFaded')).toBe(0.4)
    crowd.releaseCorpse(701)
    expect(Reflect.get(crowd, 'selfFaded')).toBe(-1)
    crowd.update(rows, 0, 0, 1 / 60, 0)
    expect(Reflect.get(crowd, 'selfFaded')).toBe(0.4)
    const builds = crowd.stats.builds
    const calls = [firstUpdate.mock.calls.length, secondUpdate.mock.calls.length] as const
    const clocks = [first.actor.mixer.time, second.actor.mixer.time] as const
    expect(first.actor).not.toBe(second.actor)
    expect(first.actor.meshes[0]?.geometry).toBe(second.actor.meshes[0]?.geometry)
    crowd.near = 0
    for (let frame = 1; frame <= 20; frame++) {
      crowd.update(rows, 0, 0, 1 / 60, frame / 60)
    }
    expect(first.holder.parent).toBeNull()
    expect(second.holder.parent).toBeNull()
    expect(firstUpdate.mock.calls.length).toBe(calls[0])
    expect(secondUpdate.mock.calls.length).toBe(calls[1])
    expect(first.actor.mixer.time).toBe(clocks[0])
    expect(second.actor.mixer.time).toBe(clocks[1])
    expect(crowd.stats.near).toBe(0)
    const privateMaterial = first.actor.meshes[0]?.material
    let warmed = 0
    crowd.warmSelf(701, () => {
      warmed++
    })
    expect(warmed).toBe(2)
    crowd.warmSelf(701, () => {
      warmed++
    })
    expect(warmed).toBe(2)
    expect(first.holder.parent).toBeNull()
    expect(first.actor.meshes[0]?.material).toBe(privateMaterial)
    crowd.near = 2
    crowd.update(rows, 0, 0, 1 / 60, 1)
    expect(first.holder.parent).not.toBeNull()
    expect(second.holder.parent).not.toBeNull()
    expect(firstUpdate.mock.calls.length).toBeGreaterThan(calls[0])
    expect(secondUpdate.mock.calls.length).toBeGreaterThan(calls[1])
    expect(members.get(701)?.actor).toBe(first.actor)
    expect(crowd.stats.builds).toBe(builds)
    const retired = first.actor
    const retiredDispose = spyOn(retired, 'dispose')
    crowd.setLook(701, { ...look, key: `${look.key}/pending-look` })
    expect(Reflect.get(crowd, 'selfFaded')).toBe(-1)
    expect(retiredDispose).not.toHaveBeenCalled()
    await crowd.prepareLooks()
    await crowd.precast(2, 701, (id) => id)
    const abandoned = members.get(701)?.actor
    if (!abandoned) {
      throw new Error('Missing pending self replacement')
    }
    const abandonedDispose = spyOn(abandoned, 'dispose')
    crowd.setLook(701, { ...look, key: `${look.key}/final-look` })
    expect(abandonedDispose).toHaveBeenCalledTimes(1)
    expect(retiredDispose).not.toHaveBeenCalled()
    await crowd.prepareLooks()
    await crowd.precast(2, 701, (id) => id)
    expect(() =>
      crowd.warmSelf(701, () => {
        throw new Error('retry warm')
      }),
    ).toThrow('retry warm')
    expect(retiredDispose).not.toHaveBeenCalled()
    crowd.warmSelf(701, () => expect(retiredDispose).not.toHaveBeenCalled())
    expect(retiredDispose).toHaveBeenCalledTimes(1)
    expect(Reflect.get(crowd, 'retiredSelf')).toBeNull()
    crowd.update(rows, 0, 0, 1 / 60, 2)
    const former = members.get(701)?.actor
    crowd.warmSelf(702, () => undefined)
    const formerMaterial = former?.meshes[0]?.material
    if (!formerMaterial || Array.isArray(formerMaterial)) {
      throw new Error('Missing private self material')
    }
    expect(formerMaterial.opacity).toBe(1)
    expect(formerMaterial.alphaHash).toBe(false)
    expect(members.get(702)?.actor).toBe(second.actor)
    expect(former === members.get(701)?.actor).toBe(true)
    const finalRetired = second.actor
    const finalDispose = spyOn(finalRetired, 'dispose')
    crowd.setLook(702, { ...look, key: `${look.key}/dispose-before-warm` })
    expect(finalDispose).not.toHaveBeenCalled()
    crowd.dispose()
    expect(finalDispose).toHaveBeenCalledTimes(1)
    retiredDispose.mockRestore()
    abandonedDispose.mockRestore()
    finalDispose.mockRestore()
  } finally {
    firstUpdate.mockRestore()
    secondUpdate.mockRestore()
    crowd.dispose()
    texture.dispose()
    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis, 'document')
    } else {
      Reflect.set(globalThis, 'document', previousDocument)
    }
  }
})

async function realAssets(base: string): Promise<Assets> {
  const load = async (name: string) =>
    new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(await file(`public/experiments/out-west/3d/models/${name}.glb`).arrayBuffer(), '')
  const [model, player, moves] = await Promise.all([load(base), load('player'), load('moves')])
  if (!(model && player && moves)) {
    throw new Error('Missing real actor assets')
  }
  markCharacterSlots(model)
  const texture = new Texture()
  return {
    player: { ...player, animations: [...player.animations, ...moves.animations] },
    props: player,
    tex: {
      ground: texture,
      groundN: texture,
      planks: texture,
      planksN: texture,
      vplanks: texture,
      vplanksN: texture,
      char: { map: texture, normal: texture, arm: texture },
    },
    bodyNow: () => model,
    body: async () => model,
    lookReady: async () => undefined,
    lookLoaded: () => true,
  }
}
