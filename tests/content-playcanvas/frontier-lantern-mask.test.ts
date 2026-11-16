import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import sharp from 'sharp'
import { AMBIENT_ASSETS } from '../../src/experiments/out-west/content/ambient.ts'
import { lanternMask } from '../../tools/content/frontier-lantern-mask.ts'

const published = await readFile(
  'public/experiments/out-west/3d/native-v2/ambient/lantern-glow.png',
)
const { data, info } = await sharp(published).raw().toBuffer({ resolveWithObject: true })

it('reproduces the lossless published mask and its content-addressed descriptor', async () => {
  expect(await lanternMask()).toEqual(published)
  expect(await readFile('tools/art/environments/lantern-glow.png')).toEqual(published)
  expect(info).toMatchObject({ width: 256, height: 256, channels: 4 })
  expect(published.length).toBe(AMBIENT_ASSETS['lantern-glow'].bytes)
  expect(createHash('sha256').update(published).digest('hex')).toBe(
    AMBIENT_ASSETS['lantern-glow'].hash,
  )
})

for (const path of [
  'tools/art/environments/frontier.glb',
  'public/experiments/out-west/3d/native-v2/baked/frontier.glb',
]) {
  it(`isolates all glass faces from iron across their complete bilinear footprints: ${path}`, async () => {
    const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(path)
    const lanterns = doc
      .getRoot()
      .listNodes()
      .filter((node) => node.getName() === 'lantern_hanging')
    expect(lanterns.length).toBe(11)
    const primitive = lanterns[0]?.getMesh()?.listPrimitives()[0]
    const indices = primitive?.getIndices()
    const uvs = primitive?.getAttribute('TEXCOORD_0')
    if (!(indices && uvs)) {
      throw new Error('Missing authored lantern UV triangles')
    }
    for (const lantern of lanterns) {
      const primitives = lantern.getMesh()?.listPrimitives() ?? []
      expect(primitives.length).toBe(1)
      expect(primitives[0]?.getAttribute('TEXCOORD_0')?.getArray()).toEqual(uvs.getArray())
      expect(primitives[0]?.getAttribute('TEXCOORD_0')?.getNormalized()).toBe(uvs.getNormalized())
      expect(primitives[0]?.getIndices()?.getArray()).toEqual(indices.getArray())
      expect(primitives[0]?.getMaterial()).toBe(primitive?.getMaterial())
    }
    expect(primitive?.getMaterial()?.getName()).toBe('HalloweenBits')
    expect(primitive?.getMaterial()?.getEmissiveFactor()).toEqual([0, 0, 0])
    let glass = 0
    let iron = 0
    for (let face = 0; face < indices.getCount(); face += 3) {
      const triangle = [0, 1, 2].map((corner) =>
        uvs.getElement(indices.getScalar(face + corner), []),
      )
      const pane = triangle.every(([u = 0, v = 0]) => u > 0.25 && u < 0.375 && v > 0.75)
      if (pane) {
        glass++
      } else {
        iron++
      }
      // Bilinear taps over the whole UV-AABB cover every possible sample inside the triangle,
      // including its edges and clamped atlas boundaries. This is stronger than vertex samples.
      const bounds = [0, 1].map((axis) => {
        const coordinates = triangle.map((uv) => (uv[axis] ?? 0) * 256 - 0.5)
        return [Math.floor(Math.min(...coordinates)), Math.floor(Math.max(...coordinates)) + 1]
      })
      const [minX = 0, maxX = 0] = bounds[0] ?? []
      const [minY = 0, maxY = 0] = bounds[1] ?? []
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const offset = (Math.max(0, Math.min(255, y)) * 256 + Math.max(0, Math.min(255, x))) * 4
          expect([...data.subarray(offset, offset + 4)]).toEqual(
            pane ? [255, 255, 255, 255] : [0, 0, 0, 255],
          )
        }
      }
    }
    expect({ glass, iron }).toEqual({ glass: 40, iron: 432 })
  })
}
