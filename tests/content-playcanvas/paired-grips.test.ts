import { expect, test as it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import type { Animation } from '@gltf-transform/core'
import {
  AnimComponentSystem,
  type AnimTrack,
  AppBase,
  AppOptions,
  Asset,
  ContainerHandler,
  type ContainerResource,
  Mat4,
  NullGraphicsDevice,
  RenderComponentSystem,
  Vec3,
} from 'playcanvas'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'
import { resampleNative } from '../../tools/content/native-resample.ts'
import {
  channels,
  find,
  frame,
  io,
  local,
  root,
  type Spin,
  sample,
  sourceMount,
  times,
  world,
} from './paired-grip-test-helpers.ts'

const CONTACT = /^Weapon_(?:Draw|Flinch)_[LR]$/u

it('paired grip authoring retains the rig, action times and every unowned track', async () => {
  const original = await io.read(`${root}/paired-poses/left-arm.glb`)
  const authored = await io.read(`${root}/paired-grips/body.glb`)
  await validateAuthoringInputs(authored)
  const inputs = authored.getRoot().getExtras().sourceInputs as { path: string }[]
  expect(inputs.some((input) => input.path === `${root}/gun-actions.pair.glb`)).toBe(true)
  const owned = authored.getRoot().getExtras().changedBones as string[]
  expect(owned).toHaveLength(38)
  expect(
    authored
      .getRoot()
      .listNodes()
      .map((n) => [n.getName(), n.getTranslation(), n.getRotation(), n.getScale()]),
  ).toEqual(
    original
      .getRoot()
      .listNodes()
      .map((n) => [n.getName(), n.getTranslation(), n.getRotation(), n.getScale()]),
  )
  expect(
    authored
      .getRoot()
      .listAnimations()
      .map((a) => a.getName()),
  ).toEqual(
    original
      .getRoot()
      .listAnimations()
      .map((a) => a.getName()),
  )
  for (const clip of original.getRoot().listAnimations()) {
    const final = find(authored, clip.getName())
    const old = channels(clip)
    const next = channels(final)
    expect([...next.keys()]).toEqual([...old.keys()])
    expect(times(final).at(-1)).toBe(times(clip).at(-1))
    const ownedKeys = new Set(owned.map((bone) => `${bone}.rotation`))
    const changed = [...old].filter(([key]) => ownedKeys.has(key))
    const unchanged = [...old].filter(([key]) => !ownedKeys.has(key))
    expect(changed).toHaveLength(38)
    expect(unchanged.length).toBeGreaterThan(0)
    for (const [key, channel] of old) {
      expect(next.get(key)?.getSampler()?.getInterpolation()).toBe(
        channel.getSampler()?.getInterpolation(),
      )
    }
    let maximumNormError = 0
    for (const [key, channel] of changed) {
      const source = channel.getSampler()
      const target = next.get(key)?.getSampler()
      const keys = new Set(target?.getInput()?.getArray())
      expect(Array.from(source?.getInput()?.getArray() ?? []).every((t) => keys.has(t))).toBe(true)
      const values = target?.getOutput()?.getArray() ?? []
      for (let i = 0; i < values.length; i += 4) {
        maximumNormError = Math.max(
          maximumNormError,
          Math.abs(Math.hypot(...Array.from(values.slice(i, i + 4))) - 1),
        )
      }
    }
    expect(maximumNormError).toBeLessThan(0.000_005)
    for (const [key, channel] of unchanged) {
      const source = channel.getSampler()
      const target = next.get(key)?.getSampler()
      expect(Array.from(target?.getInput()?.getArray() ?? [])).toEqual(
        Array.from(source?.getInput()?.getArray() ?? []),
      )
      expect(Array.from(target?.getOutput()?.getArray() ?? [])).toEqual(
        Array.from(source?.getOutput()?.getArray() ?? []),
      )
    }
  }
}, 30_000)

it('optimized paired compensation preserves source gun paths and the corrected spin pivot', async () => {
  const skeleton = await io.read(`${root}/player.gltf`)
  const original = await io.read(`${root}/paired-poses/left-arm.glb`)
  const authored = await io.read(`${root}/paired-grips/body.glb`)
  const sourceWeapons = await io.read(`${root}/gun-actions.pair.glb`)
  const weapons = await io.read(`${root}/paired-grips/mechanisms.glb`)
  await validateAuthoringInputs(weapons)
  await authored.transform(resampleNative())
  await weapons.transform(resampleNative())
  const frames = authored.getRoot().getExtras().gunFrames as Record<
    string,
    { old: number[][]; new: number[][] }
  >
  const spin = authored.getRoot().getExtras().spin as Spin
  const anchors = [new Vec3(0, 0, 0), new Vec3(0.3, 0.12, 0), new Vec3(-0.16, 0, 0)]
  let maximum = 0
  for (const clip of original.getRoot().listAnimations()) {
    const name = clip.getName()
    const final = find(authored, name)
    const actions = new Map([
      ['Idle_Gun_Pointing_Pair', 'Idle'],
      ['Gun_Shoot_Pair', 'Shoot'],
    ])
    const action = actions.get(name) ?? name.replace('_Pair', '')
    const keys = times(final)
    const probes = [...keys, ...keys.slice(1).map((t, i) => (t + (keys[i] ?? 0)) / 2)]
    for (const side of ['L', 'R']) {
      const oldWeapon = find(sourceWeapons, `Weapon_${action}_${side}`)
      const newWeapon = find(weapons, `Weapon_${action}_${side}`)
      expect(times(newWeapon).at(-1)).toBe(times(oldWeapon).at(-1))
      const mount = `mount.Wrist${side}.drawn`
      const seat = frames[side]
      if (!seat) {
        throw new Error('Missing authored gun seat')
      }
      for (const t of probes) {
        const gun = (body: Animation, mechanism: Animation, child: number[][], correct = false) => {
          const pose = sample(mechanism, t)
          let transform = local(
            pose.get(`${mount}.translation`) ?? [0, 0, 0],
            pose.get(`${mount}.rotation`) ?? [0, 0, 0, 1],
            pose.get(`${mount}.scale`) ?? [1, 1, 1],
          )
          if (correct && action === 'Spin') {
            transform = sourceMount(transform, child, spin, { side, time: t })
          }
          return world(skeleton, body, t, `Wrist${side}`).mul(transform).mul(frame(child))
        }
        const was = gun(clip, oldWeapon, seat.old, true)
        const now = gun(final, newWeapon, seat.new)
        for (const point of anchors) {
          const distance = was.transformPoint(point).distance(now.transformPoint(point))
          if (distance > maximum) {
            maximum = distance
          }
        }
      }
    }
  }
  expect(maximum).toBeLessThan(0.0003)
}, 30_000)

it('optimized real native graphs retain the paired gun paths at keys and between keys', async () => {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [AnimComponentSystem, RenderComponentSystem]
  options.resourceHandlers = [ContainerHandler]
  app.init(options)
  const loaded: Asset[] = []
  try {
    const load = async (path: string) => {
      let contents = new Uint8Array(await readFile(path))
      if (path.includes('/paired-grips/')) {
        const doc = await io.readBinary(contents)
        await doc.transform(resampleNative())
        contents = await io.writeBinary(doc)
      }
      const asset = new Asset(path, 'container', {
        url: path,
        contents: new Uint8Array(contents).buffer,
      })
      app.assets.add(asset)
      loaded.push(asset)
      await new Promise<void>((resolve, reject) => {
        asset.once('load', resolve)
        asset.once('error', reject)
        app.assets.load(asset)
      })
      const resource = asset.resource as ContainerResource
      const model = resource.instantiateRenderEntity()
      app.root.addChild(model)
      const tracks = resource.animations.map((a) => a.resource as AnimTrack)
      const initial = tracks[0]?.name
      if (!initial) {
        throw new Error('Native paired tracks missing')
      }
      model.addComponent('anim', { activate: false })
      model.anim?.loadStateGraph({
        layers: [
          {
            name: 'Proof',
            states: [
              { name: 'START' },
              ...tracks.map((t) => ({ name: t.name, speed: 1, loop: false })),
            ],
            transitions: [{ from: 'START', to: initial }],
          },
        ],
        parameters: {},
      })
      for (const track of tracks) {
        model.anim?.baseLayer?.assignAnimation(track.name, track)
      }
      if (!model.anim?.baseLayer) {
        throw new Error('Native paired graph missing')
      }
      model.anim.activate = true
      model.anim.playing = true
      return model
    }
    const oldBody = await load(`${root}/paired-poses/left-arm.glb`)
    const newBody = await load(`${root}/paired-grips/body.glb`)
    const oldWeapon = await load(`${root}/gun-actions.pair.glb`)
    const newWeapon = await load(`${root}/paired-grips/mechanisms.glb`)
    const authored = await io.read(`${root}/paired-grips/body.glb`)
    const frames = authored.getRoot().getExtras().gunFrames as Record<
      string,
      { old: number[][]; new: number[][] }
    >
    const spin = authored.getRoot().getExtras().spin as Spin
    const actions = new Map([
      ['Idle_Gun_Pointing_Pair', 'Idle'],
      ['Gun_Shoot_Pair', 'Shoot'],
    ])
    let maximum = 0
    for (const clip of authored.getRoot().listAnimations()) {
      const name = clip.getName()
      const action = actions.get(name) ?? name.replace('_Pair', '')
      const keys = times(clip)
      const probes = [...keys, ...keys.slice(1).map((t, i) => (t + (keys[i] ?? 0)) / 2)]
      for (const side of ['L', 'R']) {
        const seat = frames[side]
        if (!seat) {
          throw new Error('Missing native gun seat')
        }
        const bodyNodeOld = oldBody.findByName(`Wrist${side}`)
        const bodyNodeNew = newBody.findByName(`Wrist${side}`)
        const mountOld = oldWeapon.findByName(`mount.Wrist${side}.drawn`)
        const mountNew = newWeapon.findByName(`mount.Wrist${side}.drawn`)
        if (!(bodyNodeOld && bodyNodeNew && mountOld && mountNew)) {
          throw new Error('Native proof nodes missing')
        }
        for (const time of probes) {
          oldBody.anim?.baseLayer?.play(name)
          newBody.anim?.baseLayer?.play(name)
          oldWeapon.anim?.baseLayer?.play(`Weapon_${action}_${side}`)
          newWeapon.anim?.baseLayer?.play(`Weapon_${action}_${side}`)
          oldBody.anim?.update(time)
          newBody.anim?.update(time)
          oldWeapon.anim?.update(time)
          newWeapon.anim?.update(time)
          const mount =
            action === 'Spin'
              ? sourceMount(mountOld.getLocalTransform().clone(), seat.old, spin, { side, time })
              : mountOld.getLocalTransform()
          const was = new Mat4()
            .copy(bodyNodeOld.getWorldTransform())
            .mul(mount)
            .mul(frame(seat.old))
          const now = new Mat4()
            .copy(bodyNodeNew.getWorldTransform())
            .mul(mountNew.getLocalTransform())
            .mul(frame(seat.new))
          for (const point of [new Vec3(0, 0, 0), new Vec3(0.3, 0.12, 0), new Vec3(-0.16, 0, 0)]) {
            maximum = Math.max(
              maximum,
              was.transformPoint(point).distance(now.transformPoint(point)),
            )
          }
        }
      }
    }
    expect(maximum).toBeLessThan(0.0003)
  } finally {
    app.root.destroy()
    for (const asset of loaded) {
      asset.unload()
      app.assets.remove(asset)
    }
    app.destroy()
  }
  expect(device.textures.size).toBe(0)
  expect(device.buffers.size).toBe(0)
}, 30_000)

it('draw and false-draw retain a fixed hand grip with bounded clavicle motion', async () => {
  const body = await io.read(`${root}/paired-grips/body.glb`)
  const weapons = await io.read(`${root}/paired-grips/mechanisms.glb`)
  const swings = body.getRoot().getExtras().maximumClavicleSwingDegrees as Record<string, number>
  expect(swings.L).toBeGreaterThan(15)
  expect(Math.max(...Object.values(swings))).toBeLessThanOrEqual(25)
  let maximumPosition = 0
  let maximumRotation = 0
  let maximumScale = 0
  for (const clip of weapons
    .getRoot()
    .listAnimations()
    .filter((c) => CONTACT.test(c.getName()))) {
    const keys = times(clip)
    for (const time of [...keys, ...keys.slice(1).map((t, i) => (t + (keys[i] ?? 0)) / 2)]) {
      const pose = sample(clip, time)
      const side = clip.getName().at(-1)
      const name = `mount.Wrist${side}.drawn`
      const p = pose.get(`${name}.translation`) ?? []
      const q = pose.get(`${name}.rotation`) ?? []
      const s = pose.get(`${name}.scale`) ?? []
      maximumPosition = Math.max(maximumPosition, Math.hypot(...p))
      maximumRotation = Math.max(maximumRotation, Math.hypot(...q.slice(0, 3)))
      maximumScale = Math.max(maximumScale, ...s.map((v) => Math.abs(v - 1)))
    }
  }
  expect(maximumPosition).toBeLessThan(0.0003)
  expect(maximumRotation).toBeLessThan(0.001)
  expect(maximumScale).toBeLessThan(0.0001)
})
