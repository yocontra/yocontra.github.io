import { expect, test as it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { type Animation, type Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
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
  Quat,
  RenderComponentSystem,
  Vec3,
} from 'playcanvas'
import { validateAuthoringInputs } from '../../tools/content/authoring-inputs.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const root = 'tools/art/characters'
const find = (doc: Document, name: string) => {
  const clip = doc
    .getRoot()
    .listAnimations()
    .find((a) => a.getName() === name)
  if (!clip) {
    throw new Error(`Missing ${name}`)
  }
  return clip
}
function channels(clip: Animation) {
  return new Map(
    clip.listChannels().map((c) => [`${c.getTargetNode()?.getName()}.${c.getTargetPath()}`, c]),
  )
}
function times(clip: Animation): number[] {
  return [
    ...new Set(clip.listSamplers().flatMap((s) => Array.from(s.getInput()?.getArray() ?? []))),
  ].sort((a, b) => a - b)
}
function sample(clip: Animation, time: number) {
  return new Map(
    clip.listChannels().map((c) => {
      const sampler = c.getSampler()
      const input = sampler?.getInput()
      const output = sampler?.getOutput()
      if (!(sampler && input && output)) {
        throw new Error('Missing animation data')
      }
      let index = 0
      while (index + 1 < input.getCount() && input.getScalar(index + 1) <= time) {
        index++
      }
      const a = output.getElement(index, [] as number[])
      if (index + 1 < input.getCount() && sampler.getInterpolation() !== 'STEP') {
        const b = output.getElement(index + 1, [] as number[])
        const alpha =
          (time - input.getScalar(index)) / (input.getScalar(index + 1) - input.getScalar(index))
        if (c.getTargetPath() === 'rotation') {
          const sign = a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0) < 0 ? -1 : 1
          const q = new Quat(
            ...(a.map((v, i) => v * (1 - alpha) + (b[i] ?? 0) * sign * alpha) as [
              number,
              number,
              number,
              number,
            ]),
          ).normalize()
          return [`${c.getTargetNode()?.getName()}.${c.getTargetPath()}`, [q.x, q.y, q.z, q.w]]
        }
        return [
          `${c.getTargetNode()?.getName()}.${c.getTargetPath()}`,
          a.map((v, i) => v + ((b[i] ?? 0) - v) * alpha),
        ]
      }
      return [`${c.getTargetNode()?.getName()}.${c.getTargetPath()}`, a]
    }),
  )
}
function local(p: number[], q: number[], s: number[]) {
  return new Mat4().setTRS(
    new Vec3(p[0], p[1], p[2]),
    new Quat(q[0], q[1], q[2], q[3]).normalize(),
    new Vec3(s[0], s[1], s[2]),
  )
}
function world(skeleton: Document, clip: Animation, time: number, bone: string): Mat4 {
  const values = sample(clip, time)
  const node = skeleton
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === bone)
  if (!node) {
    throw new Error(`Missing ${bone}`)
  }
  const chain: (typeof node)[] = []
  for (let n: typeof node | null = node; n; n = n.getParentNode()) {
    chain.unshift(n)
  }
  const result = new Mat4()
  for (const n of chain) {
    result.mul(
      local(
        values.get(`${n.getName()}.translation`) ?? n.getTranslation(),
        values.get(`${n.getName()}.rotation`) ?? n.getRotation(),
        values.get(`${n.getName()}.scale`) ?? n.getScale(),
      ),
    )
  }
  return result
}
function frame(rows: number[][]) {
  return new Mat4().set(Array.from({ length: 16 }, (_, i) => rows[i % 4]?.[Math.floor(i / 4)] ?? 0))
}

it('paired grip authoring retains the rig, action times and every unowned track', async () => {
  const original = await io.read(`${root}/paired-poses/left-arm.glb`)
  const authored = await io.read(`${root}/paired-grips/body.glb`)
  await validateAuthoringInputs(authored)
  const owned = authored.getRoot().getExtras().changedBones as string[]
  expect(owned).toHaveLength(36)
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
    expect(changed).toHaveLength(36)
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

it('paired weapon compensation preserves barrel and grip paths between authored keys', async () => {
  const skeleton = await io.read(`${root}/player.gltf`)
  const original = await io.read(`${root}/paired-poses/left-arm.glb`)
  const authored = await io.read(`${root}/paired-grips/body.glb`)
  const sourceWeapons = await io.read(`${root}/gun-actions.pair.glb`)
  const weapons = await io.read(`${root}/paired-grips/mechanisms.glb`)
  await validateAuthoringInputs(weapons)
  const frames = authored.getRoot().getExtras().gunFrames as Record<
    string,
    { old: number[][]; new: number[][] }
  >
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
        const gun = (body: Animation, mechanism: Animation, child: number[][]) => {
          const pose = sample(mechanism, t)
          return world(skeleton, body, t, `Wrist${side}`)
            .mul(
              local(
                pose.get(`${mount}.translation`) ?? [0, 0, 0],
                pose.get(`${mount}.rotation`) ?? [0, 0, 0, 1],
                pose.get(`${mount}.scale`) ?? [1, 1, 1],
              ),
            )
            .mul(frame(child))
        }
        const was = gun(clip, oldWeapon, seat.old)
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

it('real native graphs retain the paired gun paths at keys and between keys', async () => {
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
      const asset = new Asset(path, 'container', {
        url: path,
        contents: new Uint8Array(await readFile(path)).buffer,
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
          const was = new Mat4()
            .copy(bodyNodeOld.getWorldTransform())
            .mul(mountOld.getLocalTransform())
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
