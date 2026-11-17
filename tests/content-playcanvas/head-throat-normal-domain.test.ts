import { expect, test as it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { Mat4, Vec3 } from 'playcanvas'
import domain from '../../tools/content/head-throat-normal-domain.json' with { type: 'json' }
import {
  anteriorNormalPoint,
  normalPixelHash,
  strictUVPixels,
  type UVTriangle,
} from '../../tools/content/head-throat-normal-domain.ts'
import recipes from '../../tools/content/head-throat-recipes.json' with { type: 'json' }
import { body, primitive } from './facial-hair-test-helpers.ts'
import { throatValue } from './head-throat-quantization-helpers.ts'

it('uses strict pixel centres without the previous loose barycentric halo', () => {
  const pixels = strictUVPixels(
    [
      [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
    ],
    4,
    4,
  )
  expect([...pixels].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 9, 12])
  expect(normalPixelHash(pixels)).toBe(normalPixelHash(new Set([...pixels].reverse())))
  expect(anteriorNormalPoint([0, -0.11, 0.03])).toBe(false)
  expect(anteriorNormalPoint([0, -0.03, 0.03])).toBe(true)
})
it('derives the approved strict union from the six canonical fan and normal-ring surfaces', async () => {
  const io = new NodeIO()
  const triangles: UVTriangle[] = []
  for (const recipe of recipes.recipes) {
    const doc = await io.read(`tools/art/characters/${recipe.id}.gltf`)
    const node = body(doc)
    const p = primitive(node)
    const pos = throatValue(p.getAttribute('POSITION'))
    const uv = throatValue(p.getAttribute('TEXCOORD_0'))
    const index = throatValue(p.getIndices())
    const skin = throatValue(node.getSkin())
    const bind = new Mat4().set(
      throatValue(skin.getInverseBindMatrices()).getElement(
        skin.listJoints().findIndex((j) => j.getName() === 'Head'),
        [],
      ),
    )
    const points = Array.from({ length: 1555 }, (_, i) =>
      bind.transformPoint(new Vec3(...pos.getElement(i, []))),
    )
    const scale = Math.max(...points.map((point) => point.y)) / 0.199_726_505_927_274_6
    for (const point of points) {
      point.divScalar(scale)
    }
    const physical = (i: number) =>
      pos
        .getElement(i, [] as number[])
        .map((v) => v.toFixed(7))
        .join(',')
    const boundaries = new Set(recipe.fans.flatMap((f) => f.boundary).map(physical))
    const normalVertices = new Set(
      Array.from({ length: 1555 }, (_, i) => i).filter((i) => boundaries.has(physical(i))),
    )
    const removed = new Set(recipe.fans.flatMap((f) => f.removeOriginalPrimitiveTriangles))
    const faces = recipe.fans.flatMap((f) => f.triangles)
    for (let t = 0; t < index.getCount(); t += 3) {
      const face = [0, 1, 2].map((c) => index.getScalar(t + c))
      if (
        !removed.has(t / 3) &&
        face.every((i) => i < 1555) &&
        face.some((i) => normalVertices.has(i))
      ) {
        faces.push(face)
      }
    }
    for (const face of faces) {
      if (face.every((i) => anteriorNormalPoint(throatValue(points[i]).toArray()))) {
        triangles.push(face.map((i) => uv.getElement(i, [])))
      }
    }
  }
  const pixels = strictUVPixels(triangles, throatValue(domain.size[0]), throatValue(domain.size[1]))
  expect(pixels.size).toBe(3088)
  expect(normalPixelHash(pixels)).toBe(domain.strictPixelSHA256)
  const distance = Math.min(
    ...domain.lowerNeckExcludedPixels.map(([x, y]) =>
      Math.min(
        ...[...pixels].map((pixel) =>
          Math.max(
            Math.abs((pixel % throatValue(domain.size[0])) - throatValue(x)),
            Math.abs(Math.floor(pixel / throatValue(domain.size[0])) - throatValue(y)),
          ),
        ),
      ),
    ),
  )
  expect(distance).toBeGreaterThan(domain.paddingPixels)
  expect(domain.lowerNeckExcludedPixels.length).toBe(15)
  expect(domain.paddingPixels).toBe(2)
})
