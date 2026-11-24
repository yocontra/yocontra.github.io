import { expect, test as it } from 'bun:test'
import { NodeIO, type Primitive } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { Ray, Tri, Vec3 } from 'playcanvas'
import { EQUIPMENT } from '../../src/experiments/out-west/content/equipment.ts'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import { CATALOG } from '../../src/experiments/out-west/data/catalog.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
async function headSurface(url: string) {
  const { pathname } = new URL(url, 'https://out-west.invalid')
  const doc = await io.read(`public${pathname}`)
  const surfaces = doc
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
  const skin = surfaces.filter(
    (primitive) => primitive.getMaterial()?.getName() === 'Field-worn skin',
  )
  if (skin.length !== 1) {
    throw new Error(`Expected one isolated skin material on ${pathname}, found ${skin.length}`)
  }
  const face = skin[0]
  const indices = face?.getIndices()?.getArray()
  const position = face?.getAttribute('POSITION')
  if (
    !(
      face &&
      indices &&
      position &&
      face.getAttribute('JOINTS_0') &&
      face.getAttribute('WEIGHTS_0')
    )
  ) {
    throw new Error(`Missing skinned head geometry on ${pathname}`)
  }
  const pbr = face.getMaterial()?.getExtras().nativePbr as
    | { albedo?: string; normal?: string; surface?: string }
    | undefined
  if (
    !(
      pbr?.surface === 'skin' &&
      pbr.albedo?.endsWith('.color.ktx2') &&
      pbr.normal?.endsWith('.data.ktx2')
    )
  ) {
    throw new Error(`Missing tagged skin, color texture or normal map on ${pathname}`)
  }
  const styledHair = surfaces.filter(
    (primitive) => primitive.getMaterial()?.getName() === 'Tobacco brown hair',
  )
  const hair = styledHair[0]
  const hairMaterial = hair?.getMaterial()
  const combedScalp = hairMaterial?.getExtras().nativePbr as
    | { albedo?: string; normal?: string; alphaTest?: number }
    | undefined
  if (
    styledHair.length !== 1 ||
    (hair?.getAttribute('POSITION')?.getCount() ?? 0) < 1000 ||
    !hair?.getAttribute('JOINTS_0') ||
    !hair.getAttribute('WEIGHTS_0') ||
    hairMaterial?.getAlphaMode() !== 'MASK' ||
    combedScalp?.alphaTest !== 0.5 ||
    !combedScalp.albedo?.endsWith('.color.ktx2') ||
    !combedScalp.normal?.endsWith('.data.ktx2')
  ) {
    throw new Error(`Missing the skinned groom, coverage or strand maps on ${pathname}`)
  }
  return {
    indexCount: indices.length,
    vertexCount: position.getCount(),
    albedo: pbr.albedo,
    groom: combedScalp.albedo,
  }
}

const starter = headSurface(ASSETS.player.url)
for (const { id, slot } of CATALOG) {
  if (slot === 'outfit' && id !== 'outfit.trail-duds') {
    it(`${id} uses the fitted player head in both weapon configurations`, async () => {
      const fit = EQUIPMENT[id as keyof typeof EQUIPMENT]
      if (!('pair' in fit)) {
        throw new Error(`Missing paired player fit for ${id}`)
      }
      const [expected, single, pair] = await Promise.all([
        starter,
        headSurface(fit.url),
        headSurface(fit.pair.url),
      ])
      expect(single).toEqual(expected)
      expect(pair).toEqual(expected)
    })
  }
}

function weightedVertices(surface: Primitive) {
  const positions = surface.getAttribute('POSITION')
  const joints = surface.getAttribute('JOINTS_0')
  const weights = surface.getAttribute('WEIGHTS_0')
  if (!(positions && joints && weights)) {
    throw new Error('Missing skinned vertex data on the rider')
  }
  const vertices = new Map<string, string>()
  for (let i = 0; i < positions.getCount(); i++) {
    const position = positions.getElement(i, []).join(',')
    const influences = weights.getElement(i, [])
    const binding = joints.getElement(i, []).flatMap((joint, index) => {
      const weight = influences[index]
      return weight ? [`${joint}/${weight}`] : []
    })
    vertices.set(position, binding.sort().join(','))
  }
  return vertices
}

it('fits the scanned Trail Duds face to both gameplay rigs', async () => {
  const fit = EQUIPMENT['outfit.trail-duds']
  const faces = await Promise.all(
    [fit, fit.pair].map(async ({ url }) => {
      const doc = await io.read(`public${new URL(url, 'https://out-west.invalid').pathname}`)
      const surfaces = doc
        .getRoot()
        .listMeshes()
        .flatMap((mesh) => mesh.listPrimitives())
      const face = surfaces.find((part) => part.getMaterial()?.getName() === 'Rider beard and skin')
      const neck = surfaces.find(
        (part) => part.getMaterial()?.getName() === 'Scanned nape and hairline',
      )
      if (!(face && neck)) {
        throw new Error('Missing face or neck on Trail Duds')
      }
      expect(surfaces.some((part) => part.getMaterial()?.getName() === 'Scanned skin')).toBe(false)
      const faceVertices = weightedVertices(face)
      const shared = [...weightedVertices(neck)].filter(([position]) => faceVertices.has(position))
      // Each point along the scanned jaw and scalp must stay joined when the head turns.
      expect(shared.length).toBeGreaterThanOrEqual(525)
      expect(shared.every(([position, binding]) => faceVertices.get(position) === binding)).toBe(
        true,
      )
      expect(face?.getMaterial()?.getBaseColorTexture()?.getImage()?.length).toBeGreaterThan(1000)
      return face?.getAttribute('POSITION')?.getArray()
    }),
  )
  expect(faces[0]).toEqual(faces[1])
})

function surfaceHeights(parts: Primitive[], rays: Ray[]): number[] {
  const heights = rays.map(() => -Infinity)
  const tri = new Tri()
  const hit = new Vec3()
  for (const part of parts) {
    const positions = part.getAttribute('POSITION')
    const indices = part.getIndices()
    if (!(positions && indices)) {
      throw new Error('Expected indexed triangles in the packed Blender model')
    }
    // Use millimeters so the ray test can resolve the scan’s smallest triangles.
    for (let i = 0; i < indices.getCount(); i += 3) {
      tri.v0.fromArray(positions.getElement(indices.getScalar(i), [])).mulScalar(1000)
      tri.v1.fromArray(positions.getElement(indices.getScalar(i + 1), [])).mulScalar(1000)
      tri.v2.fromArray(positions.getElement(indices.getScalar(i + 2), [])).mulScalar(1000)
      for (const [index, ray] of rays.entries()) {
        if (tri.intersectsRay(ray, hit)) {
          heights[index] = Math.max(heights[index] ?? -Infinity, hit.y)
        }
      }
    }
  }
  return heights
}

it('keeps the crown above the scanned scalp at the temples and across the top of the head', async () => {
  const doc = await io.read('tools/art/characters/trail-rider/trail-rider.glb')
  const parts = doc
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
  const byMaterial = (...names: string[]) =>
    parts.filter((p) => names.includes(p.getMaterial()?.getName() ?? ''))
  // Vertical probes in Blender export coordinates, including the former left-temple penetration.
  const rays = [-0.085, -0.05, -0.019, 0.015, 0.04].flatMap((x) =>
    [-0.034, -0.008, 0.025].map((z) => new Ray(new Vec3(x, 1.82, z).mulScalar(1000), Vec3.DOWN)),
  )
  const scalp = surfaceHeights(
    byMaterial('Rider beard and skin', 'Scanned nape and hairline'),
    rays,
  )
  const crown = surfaceHeights(byMaterial('Travel-worn felt'), rays)
  for (const [i, height] of scalp.entries()) {
    expect(height).toBeGreaterThan(1500)
    expect(crown[i]).toBeGreaterThan(height)
  }
})
