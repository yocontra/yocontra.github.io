import { expect, test as it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Document } from '@gltf-transform/core'
import { unpartition } from '@gltf-transform/functions'
import {
  AnimComponentSystem,
  type AnimTrack,
  AppBase,
  AppOptions,
  Asset,
  ContainerHandler,
  type ContainerResource,
  Entity,
  Mat4,
  NullGraphicsDevice,
  RenderComponentSystem,
  Vec3,
} from 'playcanvas'
import { animateRider } from '../../src/experiments/out-west/client/actor-animation.ts'
import { createRiderPose } from '../../src/experiments/out-west/client/actor-pose.ts'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import type { PlayerState } from '../../src/experiments/out-west/runtime/protocol.ts'
import { appendClips, bakeCharacterClips } from '../../tools/content/character-clips.ts'
import { withContentOutput } from '../../tools/content/content-output.ts'
import { appendCrouchClips } from '../../tools/content/crouch-character-clips.ts'
import { resampleNative } from '../../tools/content/native-resample.ts'
import { completeCharacterClips } from '../../tools/content/normalize-character-clips.ts'
import { uprightPosture } from '../../tools/content/upright-posture.ts'
import {
  channels,
  clipHash,
  find,
  frame,
  io,
  root,
  times,
  world,
} from './paired-grip-test-helpers.ts'

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Missing paired-crouch fixture')
  }
  return value
}
const PAIRED = ['Idle_Gun_Pointing_Pair', 'Gun_Shoot_Pair']
async function candidate(seed?: Document): Promise<Document> {
  const doc = seed ?? (await io.read('public/experiments/out-west/3d/native-v2/baked/moves.glb'))
  for (const clip of doc.getRoot().listAnimations()) {
    if (PAIRED.some((name) => clip.getName() === `Crouch_${name}`)) {
      clip.dispose()
    }
  }
  const grips = await io.read(`${root}/paired-grips/body.glb`)
  completeCharacterClips(grips)
  uprightPosture(grips)
  await grips.transform(resampleNative())
  appendClips(doc, grips)
  appendCrouchClips(doc, PAIRED)
  return doc
}

it('the real isolated producer emits77 unique clips with68 golden legacy streams and final paired crouch curves', async () => {
  const publicPath = 'public/experiments/out-west/3d/native-v2/baked/moves.glb'
  const originalPublic = await readFile(publicPath)
  const temporary = await mkdtemp(join(tmpdir(), 'out-west-crouch-'))
  try {
    await mkdir(join(temporary, 'baked'))
    await withContentOutput(temporary, bakeCharacterClips)
    const doc = await io.read(join(temporary, 'baked', 'moves.glb'))
    const names = doc
      .getRoot()
      .listAnimations()
      .map((clip) => clip.getName())
    expect(names).toHaveLength(77)
    expect(new Set(names).size).toBe(77)
    const golden = JSON.parse(
      await readFile('tests/fixtures/paired-legacy-clips.json', 'utf8'),
    ) as { clips: Record<string, string> }
    const legacy = Object.fromEntries(
      doc
        .getRoot()
        .listAnimations()
        .filter(
          (clip) =>
            !(clip.getName().endsWith('_Pair') || clip.getName().endsWith('Throw_Dynamite')),
        )
        .map((clip) => [clip.getName(), clipHash(clip)]),
    )
    expect(Object.keys(legacy)).toHaveLength(68)
    expect(legacy).toEqual(golden.clips)
    expect((await readFile(publicPath)).equals(originalPublic)).toBe(true)
    // Rebuilding an already-generated77-clip seed must replace these two names.
    const expected = await candidate(await io.read(join(temporary, 'baked', 'moves.glb')))
    expect(expected.getRoot().listAnimations()).toHaveLength(77)
    for (const name of PAIRED) {
      expect(clipHash(find(doc, `Crouch_${name}`))).toBe(clipHash(find(expected, `Crouch_${name}`)))
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}, 30_000)

it('paired crouch preserves legacy streams, rig and every corrected arm/finger curve', async () => {
  const before = await io.read('public/experiments/out-west/3d/native-v2/baked/moves.glb')
  const legacy = before
    .getRoot()
    .listAnimations()
    .filter((a) => !(a.getName().endsWith('_Pair') || a.getName().endsWith('Throw_Dynamite')))
  expect(legacy).toHaveLength(68)
  const doc = await candidate()
  for (const clip of legacy) {
    expect(clipHash(find(doc, clip.getName()))).toBe(clipHash(clip))
  }
  const rig = (d: Document) =>
    d
      .getRoot()
      .listNodes()
      .map((n) => [
        n.getName(),
        n.getParentNode()?.getName(),
        n.getTranslation(),
        n.getRotation(),
        n.getScale(),
      ])
  expect(rig(doc)).toEqual(rig(before))
  for (const name of PAIRED) {
    const standing = find(doc, name)
    const crouched = find(doc, `Crouch_${name}`)
    expect(times(crouched)).toEqual(times(standing))
    expect(channels(crouched).size).toBe(channels(standing).size)
    const unchangedOutputs = (clip: typeof standing) =>
      [...channels(clip)]
        .filter(([key]) => key !== 'Abdomen.rotation')
        .map(([key, channel]) => [
          key,
          Array.from(channel.getSampler()?.getOutput()?.getArray() ?? []),
        ])
    expect(unchangedOutputs(crouched)).toEqual(unchangedOutputs(standing))
    for (const [key, channel] of channels(standing)) {
      const a = required(channel.getSampler())
      const b = channels(crouched).get(key)?.getSampler()
      expect(b?.getInterpolation()).toBe(a.getInterpolation())
      expect(Array.from(b?.getInput()?.getArray() ?? [])).toEqual(
        Array.from(a.getInput()?.getArray() ?? []),
      )
    }
  }
  expect(
    doc
      .getRoot()
      .listAnimations()
      .some((a) => a.getName() === 'Crouch_Reload_Pair'),
  ).toBe(false)
})

it('actual native crouch layers retain both corrected seats and complete 200ms recoil', async () => {
  const doc = await candidate()
  const skeleton = doc
  const authored = await io.read(`${root}/paired-grips/body.glb`)
  const seats = authored.getRoot().getExtras().gunFrames as Record<string, { new: number[][] }>
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [AnimComponentSystem, RenderComponentSystem]
  options.resourceHandlers = [ContainerHandler]
  app.init(options)
  const stage = new Entity('stage', app)
  app.root.addChild(stage)
  await doc.transform(unpartition())
  const bytes = await io.writeBinary(doc)
  const asset = new Asset('paired-crouch', 'container', {
    url: 'paired-crouch.glb',
    contents: new Uint8Array(bytes).buffer,
  })
  app.assets.add(asset)
  let actor: DuelActor | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      asset.once('load', resolve)
      asset.once('error', reject)
      app.assets.load(asset)
    })
    const resource = asset.resource as ContainerResource
    const tracks = resource.animations.map((a) => a.resource as AnimTrack)
    const game = { app, stage, loadContainer: async () => asset } as unknown as GameApplication
    actor = await DuelActor.create(game, '/fixture/crouch.glb', 'crouch', {
      enabled: true,
      humanoid: true,
      tracks,
    })
    actor.paired = true
    actor.hold('revolver', true)
    const pose = createRiderPose(game, actor)
    const player = {
      hp: 100,
      grounded: true,
      crouched: true,
      vx: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
    } as PlayerState
    const rider = {
      actor,
      clip: 'Crouch_Idle',
      aim: undefined,
      weaponLayer: pose.weapon,
      firingUntil: 0,
    }
    actor.play('Crouch_Idle', 0)
    // Physical Frontier carry stays single; the arms presentation draws both guns.
    expect(actor.shotClip(true)).toBe('Crouch_Gun_Shoot')
    animateRider(rider, player, { first: false, domain: undefined })
    expect(pose.weapon.activeState).toBe('Crouch_Idle_Gun_Pointing')
    actor.pairedDrawn = true
    expect(actor.shotClip(true)).toBe('Crouch_Gun_Shoot_Pair')
    animateRider(rider, player, { first: true, domain: undefined })
    expect(pose.weapon.activeState).toBe('Crouch_Idle_Gun_Pointing_Pair')
    const lower = required(required(actor.model.anim).baseLayer)
    const upper = required(pose.root.anim)
    let maximum = 0
    for (const name of PAIRED) {
      const standing = find(doc, name)
      const sourceTimes = times(standing)
      for (const time of [
        ...sourceTimes,
        ...sourceTimes.slice(1).map((t, i) => (t + required(sourceTimes[i])) / 2),
      ]) {
        lower.play('Crouch_Idle')
        required(actor.model.anim).update(0)
        pose.weapon.play(`Crouch_${name}`)
        pose.weapon.activeStateCurrentTime = time
        upper.update(0)
        app.root.syncHierarchy()
        // Parent-frame compensation must preserve the standing upper-body orientation;
        // crouch changes hip translation, so compare world vectors from Abdomen.
        const origin = required(actor.model.findByName('Abdomen')).getWorldTransform()
        const reference = world(skeleton, standing, time, 'Abdomen')
        for (const side of ['L', 'R']) {
          const wrist = required(actor.model.findByName(`Wrist${side}`)).getWorldTransform()
          const expected = world(skeleton, standing, time, `Wrist${side}`)
          const seat = frame(required(seats[side]).new)
          const actualGun = new Mat4().copy(wrist).mul(seat)
          const expectedGun = expected.clone().mul(seat)
          for (const point of [new Vec3(), new Vec3(0.3, 0.12, 0), new Vec3(-0.16, 0, 0)]) {
            const a = actualGun.transformPoint(point).sub(origin.getTranslation())
            const b = expectedGun.transformPoint(point).sub(reference.getTranslation())
            maximum = Math.max(maximum, a.distance(b))
          }
        }
      }
    }
    expect(maximum).toBeLessThan(0.0003)
    // The action layer uses the real native recoil rate and remains selected through
    // the last authored frame even if the wall deadline is fractionally ahead.
    const shot = actor.shotClip(true)
    pose.weapon.play(shot)
    rider.firingUntil = performance.now() - 1
    upper.update(0.19)
    animateRider(rider, player, { first: true, domain: undefined })
    expect(pose.weapon.activeState).toBe(shot)
    expect(pose.weapon.activeStateCurrentTime / pose.weapon.activeStateDuration).toBeCloseTo(
      0.95,
      4,
    )
    upper.update(0.01)
    expect(pose.weapon.activeStateCurrentTime).toBeCloseTo(pose.weapon.activeStateDuration, 5)
    animateRider(rider, player, { first: true, domain: undefined })
    expect(pose.weapon.activeState).toBe('Crouch_Idle_Gun_Pointing_Pair')
    actor.hold('rifle', true)
    expect(actor.shotClip(true)).toBe('Crouch_Shoot_rifle')
    actor.hold('shotgun', true)
    expect(actor.shotClip(true)).toBe('Crouch_Shoot_shotgun')
  } finally {
    actor?.destroy()
    stage.destroy()
    asset.unload()
    app.assets.remove(asset)
    app.destroy()
  }
  expect(device.textures.size).toBe(0)
  expect(device.buffers.size).toBe(0)
})
