/** Prepare the actual unfolded reference head and atlas ownership for native normal baking. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { Mat4, Vec3 } from 'playcanvas'
import sharp from 'sharp'
import { integrateGarmentParts } from './garment-parts.ts'
import { repairHeadNape } from './head-nape.ts'
import domain from './head-throat-normal-domain.json' with { type: 'json' }
import {
  anteriorNormalPoint,
  normalPixelHash,
  strictUVPixels,
  type UVTriangle,
} from './head-throat-normal-domain.ts'
import { THROAT_GEOMETRY_IDS, THROAT_NORMAL_IDS } from './head-throat-plan.ts'
import { repairLowerNeckFans } from './lower-neck-fans.ts'

const directory = resolve('.out-west-qa/head-throat/normal-art')
const canonical = 'tools/art/characters/player.gltf'
const doc = await new NodeIO().read(canonical)
await integrateGarmentParts(doc, 'player')
repairLowerNeckFans(doc)
await repairHeadNape(doc)
const node = doc
  .getRoot()
  .listNodes()
  .find((n) => n.getName() === 'Character' && n.getSkin())
const surface = node?.getMesh()?.listPrimitives()[0]
const skin = node?.getSkin()
const position = surface?.getAttribute('POSITION')
const normal = surface?.getAttribute('NORMAL')
const uv = surface?.getAttribute('TEXCOORD_0')
const indices = surface?.getIndices()
const ranges = surface?.getExtras().pieceRanges as
  | { start: number; count: number; name?: string; surface?: string }[]
  | undefined
const head = (node?.getExtras().pieceRanges as { start: number; count: number }[] | undefined)?.[0]
const patch = ranges?.find((range) => range.name === 'AnteriorJaw')
const headJoint = skin?.listJoints().findIndex((joint) => joint.getName() === 'Head')
if (
  !(
    node &&
    skin &&
    position &&
    normal &&
    uv &&
    indices &&
    ranges &&
    head &&
    patch &&
    headJoint !== undefined &&
    headJoint >= 0
  )
) {
  throw new Error('Native normal bake requires the actual UV-safe anterior patch')
}
const inverseBind = skin.getInverseBindMatrices()
if (!inverseBind) {
  throw new Error('Missing accepted Head inverse bind')
}
const bind = new Mat4().set(inverseBind.getElement(headJoint, []))
const crown = Math.max(
  ...Array.from(
    { length: head.count },
    (_, i) => bind.transformPoint(new Vec3(...position.getElement(head.start + i, []))).y,
  ),
)
const scale = crown / 0.199_726_505_927_274_6
const inside = (i: number, range: { start: number; count: number }) =>
  i >= range.start && i < range.start + range.count
const triangles: number[][] = []
const owned: number[][] = []
const other: number[][] = []
const surfaced = ranges.filter((range) => range.surface)
for (let offset = 0; offset < indices.getCount(); offset += 3) {
  const face = [0, 1, 2].map((c) => indices.getScalar(offset + c))
  const isHead = face.every((i) => inside(i, head) || inside(i, patch))
  const narrow = face.every((i) => {
    const p = bind.transformPoint(new Vec3(...position.getElement(i, []))).divScalar(scale)
    return p.z > 0.015 && p.y < 0.025 && p.y > -0.1 && Math.abs(p.x) < 0.07
  })
  if (isHead) {
    triangles.push(face)
  }
  if (isHead && narrow && face.every((i) => inside(i, patch))) {
    owned.push(face)
  } else if (!surfaced.some((range) => face.every((i) => inside(i, range)))) {
    other.push(face)
  }
}
if (owned.length < 29) {
  throw new Error('Anterior normal mask lost its actual fan surface')
}
const raw = JSON.parse(await readFile(canonical, 'utf8'))
const body = raw.nodes.find(
  (n: { name?: string; skin?: number }) => n.name === 'Character' && n.skin !== undefined,
)
const primitive = raw.meshes[body.mesh].primitives[0]
const texture = raw.materials[primitive.material].normalTexture.index
const image = raw.images[raw.textures[texture].source].uri as string
const normalPath = `tools/art/characters/${image}`
const dimensions = await sharp(normalPath).metadata()
if (!(dimensions.width && dimensions.height)) {
  throw new Error('Missing canonical normal atlas dimensions')
}
const lattice = JSON.parse(await readFile('tools/art/characters/head-nape/lattice.json', 'utf8'))
// Every male consumer must use the same actual UV layout and normal source.
// Geometry controls7/9 intentionally have no portable anterior geometry patch.
const canonicalDoc = await new NodeIO().read(canonical)
const canonicalNode = canonicalDoc
  .getRoot()
  .listNodes()
  .find((n) => n.getName() === 'Character' && n.getSkin())
const canonicalSurface = canonicalNode?.getMesh()?.listPrimitives()[0]
const referenceUVs = canonicalSurface?.getAttribute('TEXCOORD_0')
if (!referenceUVs) {
  throw new Error('Missing actual male source UVs')
}
const referenceHeadUV = JSON.stringify(
  Array.from({ length: 1555 }, (_, i) => referenceUVs.getElement(i, [])),
)
const referenceImageSHA = createHash('sha256')
  .update(await readFile(normalPath))
  .digest('hex')
const ownedUVTriangles: UVTriangle[] = []
const consumers: {
  id: string
  surfaces: { head: boolean; uvs: number[][]; points: number[][] }[]
}[] = []
const paths = [
  normalPath,
  ...THROAT_GEOMETRY_IDS.map((id) => `tools/art/characters/head-throats/${id}.glb`),
  'tools/art/characters/head-nape/lattice.json',
  'tools/art/characters/head-nape/neck-normal.png',
  'tools/content/head-nape.ts',
  'tools/content/head-nape-authoring.py',
  'tools/content/head-throat-normal.ts',
  'tools/content/head-throat-plan.ts',
  'tools/content/head-throat-family.json',
  'tools/content/head-throat-recipes.json',
  'tools/content/head-throat-normal-domain.ts',
  'tools/content/head-throat-normal-domain.json',
  'tools/content/garment-parts.ts',
  'tools/content/garment-geometry.ts',
  'tools/content/character-atlas.ts',
  'tools/content/character-materials.ts',
  'tools/content/lower-neck-fans.ts',
  'tools/content/head-throat-normal-authoring.py',
  'tools/content/head-throat-normal-authoring.ts',
]
for (const id of THROAT_NORMAL_IDS) {
  const path = `tools/art/characters/${id}.gltf`
  const source = JSON.parse(await readFile(path, 'utf8')) as { buffers: { uri: string }[] }
  paths.push(path, ...source.buffers.map((buffer) => `tools/art/characters/${buffer.uri}`))
  const sourceDoc = await new NodeIO().read(path)
  repairLowerNeckFans(sourceDoc)
  const sourceNode = sourceDoc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === 'Character' && n.getSkin())
  const sourceSurface = sourceNode?.getMesh()?.listPrimitives()[0]
  const sourceHead = (
    sourceNode?.getExtras().pieceRanges as { start: number; count: number }[] | undefined
  )?.[0]
  const sourceUV = sourceSurface?.getAttribute('TEXCOORD_0')
  const sourceImage = sourceSurface?.getMaterial()?.getNormalTexture()?.getImage()
  const sourceSkin = sourceNode?.getSkin()
  const sourcePos = sourceSurface?.getAttribute('POSITION')
  const sourceBindAccessor = sourceSkin?.getInverseBindMatrices()
  const sourceHeadIndex = sourceSkin?.listJoints().findIndex((joint) => joint.getName() === 'Head')
  if (!(sourceBindAccessor && sourcePos && sourceHeadIndex !== undefined && sourceHeadIndex >= 0)) {
    throw new Error(`Missing normal consumer Head coordinates: ${id}`)
  }
  const sourceBind = new Mat4().set(sourceBindAccessor.getElement(sourceHeadIndex, []))
  const points = Array.from({ length: 1555 }, (_, i) =>
    sourceBind.transformPoint(new Vec3(...sourcePos.getElement(i, []))),
  )
  const sourceScale = Math.max(...points.map((point) => point.y)) / 0.199_726_505_927_274_6
  for (const point of points) {
    point.divScalar(sourceScale)
  }
  const surfaces: { head: boolean; uvs: number[][]; points: number[][] }[] = []
  for (const consumerNode of sourceDoc.getRoot().listNodes()) {
    for (const consumerPrimitive of consumerNode.getMesh()?.listPrimitives() ?? []) {
      const normalImage = consumerPrimitive.getMaterial()?.getNormalTexture()?.getImage()
      if (
        !normalImage ||
        createHash('sha256').update(normalImage).digest('hex') !== referenceImageSHA
      ) {
        continue
      }
      const index = consumerPrimitive.getIndices()
      const coords = consumerPrimitive.getAttribute('TEXCOORD_0')
      if (!(index && coords)) {
        throw new Error('Shared normal surface is missing UV ownership')
      }
      for (let t = 0; t < index.getCount(); t += 3) {
        const face = [0, 1, 2].map((corner) => index.getScalar(t + corner))
        const isHead =
          consumerNode === sourceNode &&
          consumerPrimitive === sourceSurface &&
          face.every((i) => i < 1555)
        surfaces.push({
          head: isHead,
          uvs: face.map((i) => coords.getElement(i, [])),
          points: isHead ? face.map((i) => points[i]?.toArray() ?? []) : [],
        })
      }
    }
  }
  consumers.push({ id, surfaces })
  if (THROAT_GEOMETRY_IDS.includes(id)) {
    const patchDoc = await new NodeIO().read(`tools/art/characters/head-throats/${id}.glb`)
    const authoredPatch = patchDoc.getRoot().listMeshes()[0]?.listPrimitives()[0]
    const patchIndex = authoredPatch?.getIndices()
    const patchUV = authoredPatch?.getAttribute('TEXCOORD_0')
    const patchPos = authoredPatch?.getAttribute('POSITION')
    if (!(patchIndex && patchUV && patchPos)) {
      throw new Error(`Missing authored normal ownership: ${id}`)
    }
    for (let t = 0; t < patchIndex.getCount(); t += 3) {
      const face = [0, 1, 2].map((corner) => patchIndex.getScalar(t + corner))
      if (
        face.every((i) =>
          anteriorNormalPoint(
            sourceBind
              .transformPoint(new Vec3(...patchPos.getElement(i, [])))
              .divScalar(sourceScale)
              .toArray(),
          ),
        )
      ) {
        ownedUVTriangles.push(face.map((i) => patchUV.getElement(i, [])))
      }
    }
  }
  if (
    !(sourceHead?.start === 0 && sourceHead.count === 1555 && sourceUV && sourceImage) ||
    JSON.stringify(Array.from({ length: 1555 }, (_, i) => sourceUV.getElement(i, []))) !==
      referenceHeadUV ||
    createHash('sha256').update(sourceImage).digest('hex') !== referenceImageSHA
  ) {
    throw new Error(
      `Male normal consumer UV/image ownership differs from the accepted reference: ${id}`,
    )
  }
}
const strictPixels = strictUVPixels(ownedUVTriangles, dimensions.width, dimensions.height)
if (
  strictPixels.size !== domain.strictPixelCount ||
  normalPixelHash(strictPixels) !== domain.strictPixelSHA256 ||
  dimensions.width !== domain.size[0] ||
  dimensions.height !== domain.size[1] ||
  referenceImageSHA !== domain.sourceNormalSHA256
) {
  throw new Error('Actual family normal ownership differs from the approved geometric union')
}
const sourceInputs = await Promise.all(
  [...new Set<string>(paths)].map(async (path) => ({
    path,
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  })),
)
await mkdir(directory, { recursive: true })
await writeFile(
  resolve(directory, 'input.json'),
  `${JSON.stringify(
    {
      reference: 'player',
      sourceIds: THROAT_NORMAL_IDS,
      positions: Array.from({ length: position.getCount() }, (_, i) => position.getElement(i, [])),
      normals: Array.from({ length: normal.getCount() }, (_, i) => normal.getElement(i, [])),
      uvs: Array.from({ length: uv.getCount() }, (_, i) => uv.getElement(i, [])),
      triangles,
      owned,
      other,
      ownedUVTriangles,
      consumers,
      domain,
      normalPath,
      size: [dimensions.width, dimensions.height],
      basePatch: lattice.atlas.normal,
      sourceInputs,
    },
    null,
    2,
  )}\n`,
)
console.log(`Prepared native anterior normal input: ${owned.length} owned triangles; no bake ran.`)
