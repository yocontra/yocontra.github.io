/** Native fitted-asset inspection, used by the character visual regression harness. */
import { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { DEFAULT_LOADOUT, type Loadout } from '../../src/experiments/out-west/data/catalog.ts'
import type { Dyes } from '../../src/experiments/out-west/data/dye.ts'
import type { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import { equippedActor } from '../../src/experiments/out-west/scene/native-equipment.ts'

import { assertNativeCharacter } from './character-bindings.ts'
import { characterTextureSnapshot, probeCharacterOwnership } from './character-ownership.ts'

let game: GameApplication | null = null
let actor: DuelActor | null = null
export async function previewCharacter(
  loadout: Partial<Loadout> = {},
  dyes: Dyes = {},
  clip = 'Idle',
  yaw = -20,
): Promise<void> {
  if (!game) {
    document.body.replaceChildren()
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;background:#29241f'
    const canvas = document.createElement('canvas')
    document.body.append(canvas)
    game = await GameApplication.create({ canvas, viewport: document.body, pixelRatio: 1 })
    game.camera.camera?.clearColor.set(0.17, 0.15, 0.13)
    const sky = game.app.scene.layers?.getLayerByName('Skybox')
    if (sky) {
      sky.enabled = false
    }
    game.camera.setPosition(2.0, 1.25, 3.5)
    game.camera.lookAt(0, 0.95, 0)
    if (game.camera.camera) {
      game.camera.camera.fov = 35
      game.camera.camera.nearClip = 0.01
    }
  }
  game.camera.setPosition(2.0, 1.25, 3.5)
  game.camera.lookAt(0, 0.95, 0)
  actor?.destroy()
  actor = await equippedActor(game, { ...DEFAULT_LOADOUT, ...loadout }, dyes)
  actor.face(yaw)
  actor.play(clip, 0)
  actor.model.anim?.update(0.2)
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}
export function previewStats(): unknown {
  if (!(game && actor)) {
    return null
  }
  const textures = game.app.assets
    .filter((asset) => asset.type === 'texture' && Boolean(asset.resource))
    .map((asset) => {
      const texture = asset.resource as {
        width: number
        height: number
        gpuSize: number
        name: string
      }
      return {
        url: (asset.file as { url?: string } | null)?.url,
        width: texture.width,
        height: texture.height,
        bytes: texture.gpuSize,
        name: texture.name,
      }
    })
  return {
    materials: actor.root.findComponents('render').flatMap((c) =>
      c.meshInstances.map((i) => ({
        name: i.material?.name,
        map: (i.material as import('playcanvas').StandardMaterial).diffuseMap?.name,
        vertex: (i.material as import('playcanvas').StandardMaterial).diffuseVertexColor,
        uv: (i.material as import('playcanvas').StandardMaterial).diffuseMapUv,
        channel: (i.material as import('playcanvas').StandardMaterial).diffuseMapChannel,
        diffuse: (i.material as import('playcanvas').StandardMaterial).diffuse.toString(false),
        attributes: i.mesh?.vertexBuffer.format.elements.map((e) => ({
          semantic: e.name,
          components: e.numComponents,
          type: e.dataType,
          normalized: e.normalize,
        })),
        textureSource: String(
          (i.material as import('playcanvas').StandardMaterial).diffuseMap?.getSource(),
        ),
      })),
    ),
    textures,
    draws: actor.root
      .findComponents('render')
      .reduce((n, component) => n + component.meshInstances.length, 0),
    muzzle: actor.muzzle(),
    nodes: actor.root
      .find((node) => node.name.startsWith('mount.'))
      .map((node) => ({
        name: node.name,
        position: node.getPosition().toString(),
        enabled: node.enabled,
      })),
    root: actor.root.name,
  }
}
export function pauseCharacter(time: number): void {
  if (!actor?.model.anim) {
    return
  }
  if (actor.model.anim.baseLayer) {
    actor.model.anim.baseLayer.activeStateCurrentTime = time
  }
  actor.model.anim.playing = false
}

let population: DuelActor[] = []
function textureSnapshot(): ReturnType<typeof characterTextureSnapshot> {
  if (!game) {
    throw new Error('Missing preview application')
  }
  return characterTextureSnapshot(game)
}
export async function clearCharacters(): Promise<ReturnType<typeof textureSnapshot>> {
  actor?.destroy()
  actor = null
  for (const rider of population) {
    rider.destroy()
  }
  population = []
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  return textureSnapshot()
}
export async function packedCharacters(): Promise<ReturnType<typeof textureSnapshot>> {
  await clearCharacters()
  if (!game) {
    throw new Error('Missing preview application')
  }
  const [{ CATALOG }, { DYES }] = await Promise.all([
    import('../../src/experiments/out-west/data/catalog.ts'),
    import('../../src/experiments/out-west/data/dye.ts'),
  ])
  const outfits = CATALOG.filter((item) => item.slot === 'outfit')
  population = await Promise.all(
    Array.from({ length: 32 }, async (_, index) => {
      const outfit = outfits[index % outfits.length]?.id ?? DEFAULT_LOADOUT.outfit
      const dye = DYES[Math.floor(index / outfits.length) + 1]?.id ?? 'natural'
      const rider = await equippedActor(
        game as GameApplication,
        { ...DEFAULT_LOADOUT, outfit },
        { [outfit]: dye },
      )
      rider.place(((index % 8) - 3.5) * 1.4, 0, Math.floor(index / 8) * 1.6)
      rider.face(25)
      rider.play('Idle')
      return rider
    }),
  )
  game.camera.setPosition(13, 10, 22)
  game.camera.lookAt(0, 1, 2)
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  return textureSnapshot()
}
export async function materialLifecycleProbe(): Promise<unknown> {
  await clearCharacters()
  if (!game) {
    throw new Error('Missing preview application')
  }
  const result = await probeCharacterOwnership(game)
  actor = result.actor
  return result.proof
}

export async function animationGraphProbe(): Promise<unknown> {
  if (!game) {
    throw new Error('Missing preview application')
  }
  const [{ DuelActor: NativeActor }, { DYNAMIC_ASSETS }, { AMBIENT_ASSETS }] = await Promise.all([
    import('../../src/experiments/out-west/duel/native-actor.ts'),
    import('../../src/experiments/out-west/content/manifest.ts'),
    import('../../src/experiments/out-west/content/ambient.ts'),
  ])
  const results: unknown[] = []
  for (const [name, url] of Object.entries({
    coin: DYNAMIC_ASSETS.coin.url,
    door: DYNAMIC_ASSETS.door.url,
    dog: DYNAMIC_ASSETS.dog.url,
    horse: DYNAMIC_ASSETS.horse.url,
    crow: AMBIENT_ASSETS.crow.url,
    shingles: AMBIENT_ASSETS.shingles.url,
  })) {
    const subject = await NativeActor.create(game, url, `probe-${name}`)
    subject.play('Idle')
    for (let i = 0; i < 3; i++) {
      subject.model.anim?.update(1 / 30)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    const layer = subject.model.anim?.baseLayer
    if (layer && !layer.states.includes(layer.activeState)) {
      throw new Error(`Invalid native active state: ${name}/${layer.activeState}`)
    }
    results.push({
      name,
      clips: subject.tracks.map((track) => track.name),
      active: layer?.activeState ?? null,
    })
    subject.destroy()
  }
  if (actor) {
    for (const track of actor.tracks) {
      actor.play(track.name, 0)
      actor.model.anim?.update(0.1)
    }
  }
  return results
}
export function poseMetrics(): unknown {
  if (!actor) {
    return null
  }
  return {
    mounts: actor.root
      .find((node) => ['Head', 'FootL', 'FootR'].includes(node.name))
      .map((node) => ({
        name: node.name,
        path: node.path,
        scale: node.getLocalScale().toString(),
      })),
    bones: ['Root', 'Hips', 'Abdomen', 'Head', 'WristR'].map((name) => {
      const node = actor?.model.findByName(name)
      return {
        name,
        scale: node?.getLocalScale().toString(),
        position: node?.getPosition().toString(),
      }
    }),
    bounds: actor.root.findComponents('render').flatMap((render) =>
      render.meshInstances.map((instance) => ({
        center: instance.aabb.center.toString(),
        half: instance.aabb.halfExtents.toString(),
      })),
    ),
    clip: actor.model.anim?.baseLayer?.activeState,
    muzzle: actor.muzzle(),
  }
}

export function assertCharacterBindings(): void {
  if (!actor) {
    throw new Error('No preview character')
  }
  assertNativeCharacter(actor)
}
export async function previewHeldWeapon(
  weapon: 'rifle' | 'shotgun',
  shot = false,
  yaw = -55,
): Promise<void> {
  await previewCharacter({}, {}, `Hold_${weapon}`, yaw)
  if (!(game && actor)) {
    throw new Error('Missing held preview')
  }
  const [{ attachHeldWeapon }, { DYNAMIC_ASSETS }] = await Promise.all([
    import('../../src/experiments/out-west/scene/native-equipment.ts'),
    import('../../src/experiments/out-west/content/manifest.ts'),
  ])
  await attachHeldWeapon(game, actor, weapon, DYNAMIC_ASSETS[`held-${weapon}`].url)
  actor.hold(weapon, true)
  if (shot) {
    actor.shoot()
  } else {
    actor.play(`Hold_${weapon}`, 0)
  }
  actor.model.anim?.update(0.12)
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}

export async function nativeRateProbe(): Promise<unknown> {
  await previewCharacter()
  if (!(actor && game && actor.model.anim)) {
    throw new Error('Missing native gait fixture')
  }
  const animation = actor.model.anim
  animation.playing = false
  const layer = animation.baseLayer
  const track = actor.tracks.find((clip) => clip.name === 'Stride_Walk_0')
  if (!(layer && track)) {
    throw new Error('Missing authored stride')
  }
  layer.assignAnimation('RateReference', track, 1, true)
  const pose = () =>
    actor?.model
      .find((node) => ['Root', 'Hips', 'FootL', 'FootR', 'WristR'].includes(node.name))
      .flatMap((node) => [
        ...node.getLocalPosition().toArray(),
        ...node.getLocalRotation().toArray(),
      ]) ?? []
  layer.play('Stride_Walk_0')
  layer.activeStateCurrentTime = 0
  actor.speed(0.5)
  animation.update(0.2)
  actor.speed(2)
  animation.update(0.2)
  const variable = pose()
  layer.play('RateReference')
  layer.activeStateCurrentTime = 0.5
  animation.update(0)
  const reference = pose()
  const error = Math.max(
    ...variable.map((value, index) => Math.abs(value - (reference[index] ?? 0))),
  )
  if (error > 1e-4) {
    throw new Error(`Native synchronized stride phase differs from reference:${error}`)
  }
  const assign = layer.assignAnimation.bind(layer)
  let assignments = 0
  layer.assignAnimation = (...args) => {
    assignments++
    assign(...args)
  }
  for (const rate of [0.5, 0.75, 1, 1.25, 2, 3, 6, 0.8]) {
    actor.speed(rate)
  }
  if (assignments) {
    throw new Error('Stride rate rebound an immutable native track')
  }
  layer.assignAnimation = assign
  const path = '../../src/experiments/out-west/client/actor-pose.ts'
  const { createRiderPose } = await import(path)
  const presentation = createRiderPose(game, actor)
  const upper = presentation.weapon
  const upperAnim = presentation.root.anim
  if (!upperAnim) {
    throw new Error('Missing independent upper controller')
  }
  upperAnim.playing = false
  upper.play('Gun_Shoot')
  layer.play('Stride_Walk_0')
  actor.speed(6)
  const lowerNames = new Set(['Root', 'Hips', 'FootL', 'FootR'])
  const upperNames = new Set(['Abdomen', 'Head', 'WristR'])
  const local = (names: Set<string>) =>
    actor?.model
      .find((node) => names.has(node.name))
      .flatMap((node) => [
        ...node.getLocalPosition().toArray(),
        ...node.getLocalRotation().toArray(),
      ]) ?? []
  const beforeLower = local(lowerNames)
  upperAnim.update(0.1)
  const afterLower = local(lowerNames)
  if (JSON.stringify(beforeLower) !== JSON.stringify(afterLower)) {
    throw new Error('Upper controller wrote locomotion bones')
  }
  const beforeUpper = local(upperNames)
  animation.update(0.1)
  const afterUpper = local(upperNames)
  if (JSON.stringify(beforeUpper) !== JSON.stringify(afterUpper)) {
    throw new Error('Locomotion controller wrote upper bones')
  }
  const shotTime = upper.activeStateCurrentTime
  const shotDuration = actor.animationTrack('Gun_Shoot')?.duration ?? 0
  if (Math.abs(shotTime - shotDuration / 2) > 0.001) {
    throw new Error(`Upper action scaled with stride rate:${shotTime}`)
  }
  return { phaseError: error, rateAssignments: assignments, upperShotTime: shotTime }
}

export async function attachmentLifecycleProbe(): Promise<unknown> {
  await previewCharacter({}, {}, 'Gun_Shoot', -35)
  if (!actor) {
    throw new Error('Missing attachment fixture')
  }
  const { assertAttachmentLifecycle } = await import('./attachment-probe.ts')
  const result = assertAttachmentLifecycle(actor)
  actor = null
  return result
}
