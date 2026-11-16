import { expect, test as it } from 'bun:test'
import { Vec3 } from 'playcanvas'
import { resampleNative } from '../../tools/content/native-resample.ts'
import {
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

it('spin keeps the original keyed gun poses, fixes the between-key pivot and puts the index through it', async () => {
  const skeleton = await io.read(`${root}/player.gltf`)
  const source = await io.read(`${root}/paired-poses/left-arm.glb`)
  const sourceWeapons = await io.read(`${root}/gun-actions.pair.glb`)
  const body = await io.read(`${root}/paired-grips/body.glb`)
  const weapons = await io.read(`${root}/paired-grips/mechanisms.glb`)
  const spin = body.getRoot().getExtras().spin as Spin
  const frames = body.getRoot().getExtras().gunFrames as Record<
    string,
    { old: number[][]; new: number[][] }
  >
  await body.transform(resampleNative())
  await weapons.transform(resampleNative())
  const original = find(source, 'Spin_Pair')
  const final = find(body, 'Spin_Pair')
  let maximumSourceKeyChange = 0
  let maximumPivotError = 0
  let maximumIndexGap = 0
  let maximumReleaseError = 0
  for (const side of ['L', 'R']) {
    const seat = frames[side]
    const values = spin.pivots[side]
    if (!(seat && values)) {
      throw new Error('Missing spin authoring')
    }
    const pivot = new Vec3(values[0], values[1], values[2])
    const mount = `mount.Wrist${side}.drawn`
    const oldWeapon = find(sourceWeapons, `Weapon_Spin_${side}`)
    const newWeapon = find(weapons, `Weapon_Spin_${side}`)
    for (const time of times(oldWeapon).filter((t) => t <= spin.pivotEndTime)) {
      const pose = sample(oldWeapon, time)
      const old = local(
        pose.get(`${mount}.translation`) ?? [0, 0, 0],
        pose.get(`${mount}.rotation`) ?? [0, 0, 0, 1],
        pose.get(`${mount}.scale`) ?? [1, 1, 1],
      )
      const corrected = sourceMount(old.clone(), seat.old, spin, { side, time })
      for (const point of [new Vec3(), new Vec3(0.3, 0.1, 0)]) {
        maximumSourceKeyChange = Math.max(
          maximumSourceKeyChange,
          old.transformPoint(point).distance(corrected.transformPoint(point)),
        )
      }
    }
    for (let i = 0; i <= 600; i++) {
      const time = i / 1000
      const pose = sample(newWeapon, time)
      const actual = world(skeleton, final, time, `Wrist${side}`)
        .mul(
          local(
            pose.get(`${mount}.translation`) ?? [0, 0, 0],
            pose.get(`${mount}.rotation`) ?? [0, 0, 0, 1],
            pose.get(`${mount}.scale`) ?? [1, 1, 1],
          ),
        )
        .mul(frame(seat.new))
        .transformPoint(pivot)
      const expected = world(skeleton, original, time, `Wrist${side}`)
        .mul(frame(seat.old))
        .transformPoint(pivot)
      maximumPivotError = Math.max(maximumPivotError, actual.distance(expected))
      if (time >= 0.07 && time <= 0.47) {
        const a = world(skeleton, final, time, `Index2${side}`).getTranslation()
        const b = world(skeleton, final, time, `Index3${side}`).getTranslation()
        maximumIndexGap = Math.max(maximumIndexGap, a.add(b).mulScalar(0.5).distance(actual))
      }
    }
    const end = times(original).at(-1) ?? 0
    for (const bone of [`Wrist${side}`, `Index4${side}`, `Thumb4${side}`]) {
      maximumReleaseError = Math.max(
        maximumReleaseError,
        world(skeleton, final, end, bone)
          .getTranslation()
          .distance(world(skeleton, original, end, bone).getTranslation()),
      )
    }
  }
  expect(maximumSourceKeyChange).toBeLessThan(0.0003)
  expect(maximumPivotError).toBeLessThan(0.0003)
  expect(maximumIndexGap).toBeLessThan(0.002)
  expect(maximumReleaseError).toBeLessThan(0.000_01)
}, 30_000)
