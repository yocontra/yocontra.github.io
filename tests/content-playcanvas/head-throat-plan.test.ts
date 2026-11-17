import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { NodeIO } from '@gltf-transform/core'
import { Mat4, Vec3 } from 'playcanvas'
import { EQUIPMENT } from '../../src/experiments/out-west/content/equipment.ts'
import family from '../../tools/content/head-throat-family.json' with { type: 'json' }
import {
  constrainedThroatRecipe,
  planHeadThroat,
  THROAT_BODY_IDS,
  THROAT_CONSTRAINED_RECIPES,
  THROAT_CONTROL_IDS,
  THROAT_GEOMETRY_IDS,
  THROAT_NORMAL_IDS,
  THROAT_PROOF_IDS,
  throatRecipe,
  throatRegionInteriors,
  validateConstrainedThroatFan,
} from '../../tools/content/head-throat-plan.ts'
import { body, primitive } from './facial-hair-test-helpers.ts'
import { throatValue } from './head-throat-quantization-helpers.ts'

const io = new NodeIO()
for (const id of THROAT_GEOMETRY_IDS) {
  it(`${id} isolates the folded fan without changing its fixed boundary or attributes`, async () => {
    const doc = await io.read(`tools/art/characters/${id}.gltf`)
    const before = await io.writeBinary(doc)
    const plan = planHeadThroat(doc, id)
    const chin = family.chinFanOverrides[id as keyof typeof family.chinFanOverrides]
    const chinInterior = chin?.interior ?? [495, 503, 504, 506]
    const constrained = constrainedThroatRecipe(id)
    const expectedInterior =
      constrained?.fans.map((fan) => fan.interior) ??
      (throatRecipe(id) === 'merged'
        ? [chinInterior, [19, 21, 23, 25, 27, 30, 32, 34, 36]]
        : [chinInterior, [19, 21, 23, 25], [30, 32, 34, 36]])
    expect(plan.fans.map((fan) => fan.interior)).toEqual(expectedInterior)
    expect(plan.fans.map((fan) => fan.removeTriangles.length)).toEqual(
      constrained?.fans.map((fan) => fan.removeOriginalPrimitiveTriangles.length) ??
        (throatRecipe(id) === 'merged'
          ? [chin?.triangles ?? 17, 38]
          : [chin?.triangles ?? 17, 18, 18]),
    )
    expect(plan.fans.map((fan) => fan.boundary.length)).toEqual(
      constrained?.fans.map((fan) => fan.boundary.length) ??
        (throatRecipe(id) === 'merged'
          ? [chin?.boundary ?? 11, 22]
          : [chin?.boundary ?? 11, 12, 12]),
    )
    const removed = plan.fans.flatMap((fan) => fan.removeTriangles)
    expect(new Set(removed).size).toBe(
      constrained?.fans.reduce(
        (sum, fan) => sum + fan.removeOriginalPrimitiveTriangles.length,
        0,
      ) ?? (chin?.triangles ?? 17) + (throatRecipe(id) === 'merged' ? 38 : 36),
    )
    expect(plan.shape.unownedFolds).toBe(0)
    expect(plan.positionEdits.map((edit) => edit.sourceVertex)).toEqual(
      id === 'outlaw-15' ? [83, 84] : [],
    )
    for (const edit of plan.positionEdits) {
      const head = new Mat4()
        .set(plan.headInverseBind)
        .transformPoint(new Vec3(...edit.sourceTarget))
        .divScalar(plan.headScale)
      expect(head.x).toBeCloseTo(edit.normalizedHeadBefore[0] ?? 0, 10)
      expect(head.z).toBeCloseTo(edit.normalizedHeadBefore[2] ?? 0, 10)
      expect(head.y - (edit.normalizedHeadBefore[1] ?? 0)).toBeCloseTo(
        edit.sourceVertex === 83 ? -0.0048 : -0.0036,
        10,
      )
    }
    expect(plan.fans.every((fan) => new Set(fan.boundary).size === fan.boundary.length)).toBe(true)
    expect(plan.fans.some((fan) => fan.boundary.some((i) => fan.interior.includes(i)))).toBe(false)
    expect(await io.writeBinary(doc)).toEqual(before)
  })
}
for (const id of ['outlaw-7', 'outlaw-9', 'outlaw-8', 'outlaw-10']) {
  it(`${id} remains an untouched healthy control`, async () => {
    const doc = await io.read(`tools/art/characters/${id}.gltf`)
    const before = await io.writeBinary(doc)
    expect(() => planHeadThroat(doc, id)).toThrow('healthy controls')
    expect(await io.writeBinary(doc)).toEqual(before)
  })
}

it('names every actual body and equipped base/pair consumer with four geometry controls', () => {
  expect(THROAT_BODY_IDS.length).toBe(34)
  expect(new Set(THROAT_BODY_IDS).size).toBe(34)
  expect(THROAT_GEOMETRY_IDS.length).toBe(30)
  expect(THROAT_CONTROL_IDS.toSorted()).toEqual(['outlaw-10', 'outlaw-7', 'outlaw-8', 'outlaw-9'])
  expect(THROAT_NORMAL_IDS.length).toBe(32)
  expect(THROAT_NORMAL_IDS).toContain('outlaw-7')
  expect(THROAT_NORMAL_IDS).toContain('outlaw-9')
  expect(THROAT_NORMAL_IDS).not.toContain('outlaw-8')
  expect(THROAT_NORMAL_IDS).not.toContain('outlaw-10')
  const outfits = Object.entries(EQUIPMENT).filter(([id]) => id.startsWith('outfit.'))
  expect(outfits.length).toBe(8)
  for (const [id, asset] of outfits) {
    expect(THROAT_BODY_IDS).toContain(id)
    expect(THROAT_BODY_IDS).toContain(`${id}.pair`)
    expect(asset.url).toContain(`/equipment/${id}.glb?`)
    if (!('pair' in asset)) {
      throw new Error(`Missing actual paired outfit consumer: ${id}`)
    }
    expect(asset.pair.url).toContain(`/equipment/${id}.pair.glb?`)
  }
  expect(THROAT_BODY_IDS).toContain('outfit.trail-duds')
  expect(THROAT_BODY_IDS).toContain('outfit.trail-duds.pair')
  expect(() => throatRecipe('horse')).toThrow('unknown')
})
for (const id of THROAT_PROOF_IDS) {
  it(`${id} preserves the accepted native patch corner bytes independently of metadata`, async () => {
    const bytes = await readFile(`tools/art/characters/head-throats/${id}.glb`)
    const offset = 20 + bytes.readUInt32LE(12)
    expect(bytes.toString('ascii', offset + 4, offset + 8)).toBe('BIN\0')
    const bin = bytes.subarray(offset + 8, offset + 8 + bytes.readUInt32LE(offset))
    const expected =
      family.acceptedPatchBinarySHA256[id as keyof typeof family.acceptedPatchBinarySHA256]
    expect(createHash('sha256').update(bin).digest('hex')).toBe(expected)
  })
}

for (const [sourceID, wrongRecipeID] of [
  ['player', 'outlaw-16'],
  ['outlaw-16', 'player'],
]) {
  it(`rejects applying ${wrongRecipeID}'s fan recipe to ${sourceID}'s different measured folds`, async () => {
    const doc = await io.read(`tools/art/characters/${sourceID}.gltf`)
    expect(() => planHeadThroat(doc, wrongRecipeID ?? '')).toThrow('measured folds')
  })
}

it('pins all six sources and rejects reversed UV winding, missing diagonals and collapsed source UV donors', async () => {
  expect(THROAT_CONSTRAINED_RECIPES.map((r) => r.id)).toEqual([
    'outlaw-1',
    'outlaw-11',
    'outlaw-2',
    'outlaw-3',
    'outlaw-5',
    'outlaw-6',
  ])
  for (const recipe of THROAT_CONSTRAINED_RECIPES) {
    for (const pin of recipe.sourcePins) {
      expect(
        createHash('sha256')
          .update(await readFile(pin.path))
          .digest('hex'),
      ).toBe(pin.sha256)
    }
    const doc = await io.read(`tools/art/characters/${recipe.id}.gltf`)
    const surface = primitive(body(doc))
    const fan = throatValue(planHeadThroat(doc, recipe.id).fans[0])
    expect(() => validateConstrainedThroatFan(surface, fan)).not.toThrow()
    const reversed = structuredClone(fan)
    throatValue(throatValue(reversed.triangles)[0]).reverse()
    expect(() => validateConstrainedThroatFan(surface, reversed)).toThrow('UV triangle')
    const missing = structuredClone(fan)
    throatValue(missing.constrainedDiagonals).pop()
    expect(() => validateConstrainedThroatFan(surface, missing)).toThrow('Incomplete')
    const uv = throatValue(surface.getAttribute('TEXCOORD_0'))
    uv.setElement(throatValue(fan.boundary[0]), uv.getElement(throatValue(fan.boundary[1]), []))
    expect(() => validateConstrainedThroatFan(surface, fan)).toThrow('UV triangle')
  }
})

it('owns exactly the 31 approved additional original triangles and adds no position freedom', async () => {
  const expected: Record<string, number[]> = {
    'outlaw-1': [107, 108, 259, 260, 844, 845, 849],
    'outlaw-11': [844, 845, 849],
    'outlaw-2': [107, 108, 257, 258, 259, 260, 275, 276, 844, 845, 849],
    'outlaw-3': [844, 845, 849],
    'outlaw-5': [107, 108, 259, 260],
    'outlaw-6': [800, 801, 805],
  }
  let count = 0
  for (const recipe of THROAT_CONSTRAINED_RECIPES) {
    const doc = await io.read(`tools/art/characters/${recipe.id}.gltf`)
    const surface = primitive(body(doc))
    const index = throatValue(surface.getIndices())
    const chin = family.chinFanOverrides[recipe.id as keyof typeof family.chinFanOverrides]
      ?.interior ?? [495, 503, 504, 506]
    const oldInterior = [...chin, 19, 21, 23, 25, 27, 30, 32, 34, 36]
    const old = new Set<number>()
    for (let t = 0; t < index.getCount(); t += 3) {
      if ([0, 1, 2].some((c) => oldInterior.includes(index.getScalar(t + c)))) {
        old.add(t / 3)
      }
    }
    const plan = planHeadThroat(doc, recipe.id)
    const added = plan.fans
      .flatMap((f) => f.removeTriangles)
      .filter((t) => !old.has(t))
      .sort((a, b) => a - b)
    expect(added).toEqual(throatValue(expected[recipe.id]))
    count += added.length
    expect(plan.positionEdits).toEqual([])
  }
  expect(count).toBe(31)
})

it('outlaw2 bridge84 is already wholly inside the exact owned triangle region', async () => {
  const doc = await io.read('tools/art/characters/outlaw-2.gltf')
  const surface = primitive(body(doc))
  const fan = throatValue(planHeadThroat(doc, 'outlaw-2').fans[0])
  expect(fan.interior).not.toContain(84)
  expect(throatRegionInteriors(surface, fan)).toEqual([...fan.interior, 84].sort((a, b) => a - b))
  expect(fan.boundary).not.toContain(84)
  expect(fan.triangles?.flat()).not.toContain(84)
  const broken = structuredClone(fan)
  broken.removeTriangles = broken.removeTriangles.filter((t) => t !== 106)
  expect(() => throatRegionInteriors(surface, broken)).toThrow('unowned incident face')
})
