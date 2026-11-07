import { expect, it } from 'bun:test'
import { paletteColor } from '../src/experiments/out-west/ffa/scene/crowd/palette.ts'

const HAND = /^(?:Wrist|Fist|Thumb|Index|Middle|Ring|Pinky)/u
const markers: [number, number, number][] = [
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 0],
  [0, 0, 1],
  [0, 1, 0],
]
it('preserves authored shirt identity and brightness after cotton tint scaling', () => {
  expect(paletteColor(1, [0.58, 0, 0.58], markers)).toEqual([0.58, 0.58, 0.58])
  expect(paletteColor(1, [0.5452, 0, 0.5452], markers)).toEqual([0.5452, 0.5452, 0.5452])
})
it('retains a fixed saturated garment color without inferring an instance palette', () => {
  expect(paletteColor(0, [0.58, 0, 0.58], markers)).toEqual([0.58, 0, 0.58])
  expect(() => paletteColor(6, [0, 0, 0], markers)).toThrow('Missing palette marker')
})

it('carries material IDs through real tailored cotton and fixes painted gloves to palette zero', async () => {
  const { file } = await import('bun')
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
  const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js')
  const { Actor } = await import('../src/experiments/out-west/scene/actor.ts')
  const { markCharacterSlots } = await import('../src/experiments/out-west/engine/assets.ts')
  const { SLOT } = await import('../src/experiments/out-west/scene/roles.ts')
  const { boneKey } = await import('../src/experiments/out-west/scene/fit.ts')
  const source = await new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .parseAsync(
      await file(
        new URL('../public/experiments/out-west/3d/models/player.glb', import.meta.url),
      ).arrayBuffer(),
      '',
    )
  markCharacterSlots(source)
  const actor = new Actor(source, {
    base: 'casual',
    gloves: 0x3a_24_14,
    skin: 'dark',
    coat: 0x6a_50_38,
    tint: { Shirt: 0xff_00_ff, Sleeves: 0x00_ff_00, Skin: 0x00_00_ff },
    paletteSlots: { [SLOT.Shirt]: 1, [SLOT.Sleeves]: 5, [SLOT.Skin]: 4 },
  })
  const mesh = actor.meshes[0]
  if (!mesh) {
    throw new Error('Missing real body')
  }
  const palette = mesh.geometry.getAttribute('paletteSlot')
  const cuffIds = mesh.geometry.userData.cuffs as { vertices: number[] }[]
  expect(
    new Set(cuffIds.flatMap((cuff) => cuff.vertices.map((vertex) => palette.getX(vertex)))),
  ).toEqual(new Set([1]))
  const skin = mesh.geometry.getAttribute('skinIndex')
  const weights = mesh.geometry.getAttribute('skinWeight')
  const handSlots: number[] = []
  const skinScales: number[] = []
  for (let vertex = 0; vertex < palette.count; vertex++) {
    let dominant = 0
    for (let influence = 1; influence < 4; influence++) {
      if (weights.getComponent(vertex, influence) > weights.getComponent(vertex, dominant)) {
        dominant = influence
      }
    }
    const bone = mesh.skeleton.bones[skin.getComponent(vertex, dominant)]
    if (bone && HAND.test(boneKey(bone.name))) {
      handSlots.push(palette.getX(vertex))
    }
    if (palette.getX(vertex) === 4) {
      const color = mesh.geometry.getAttribute('color')
      skinScales.push(
        paletteColor(4, [color.getX(vertex), color.getY(vertex), color.getZ(vertex)], markers)[0],
      )
    }
  }
  expect(handSlots.length).toBeGreaterThan(100)
  expect(new Set(handSlots)).toEqual(new Set([0]))
  expect(Math.min(...skinScales)).toBeGreaterThan(0.9)
  expect(Math.max(...skinScales)).toBeLessThan(1.1)
  const cloth = mesh.geometry.userData.clothRanges as { start: number; count: number }[]
  expect(
    new Set(
      cloth.flatMap((range) =>
        Array.from({ length: range.count }, (_, i) => palette.getX(range.start + i)),
      ),
    ),
  ).toEqual(new Set([0]))
  actor.dispose()
})

it('bakes neutral skin once while retaining defining fixed glove colors', async () => {
  const { silhouetteLook, silhouetteKey } = await import(
    '../src/experiments/out-west/ffa/scene/crowd/silhouette.ts'
  )
  const look = {
    base: 'casual' as const,
    tint: {},
    scale: 1,
    skin: 'dark' as const,
    gloves: 0x3a_24_14,
  }
  expect(silhouetteLook(look).skin).toBe('tan')
  expect(silhouetteLook(look).gloves).toBe(look.gloves)
  expect(silhouetteKey(look)).not.toBe(silhouetteKey({ ...look, gloves: 0x22_18_10 }))
})
