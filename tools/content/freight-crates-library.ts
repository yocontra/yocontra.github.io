/** Owned freight library/atlas preparation; never deduplicate an existing environment document. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Document,
  type Node,
  type Primitive,
  type Property,
  PropertyType,
} from '@gltf-transform/core'
import { dedup, transformMesh } from '@gltf-transform/functions'
import sharp from 'sharp'
import {
  type FreightCell,
  type FreightPlacement,
  matchFreightPlacements,
  requireClosedFreight,
  triangles,
} from './freight-crates-contract.ts'
import {
  cleanupFreightResources,
  type FreightJoint,
  type FreightPiece,
  freightContactCoordinate,
  freightEndgrainSvg,
  joinFreight,
  removeTree,
  treeDigest,
} from './freight-crates-geometry.ts'

export interface FreightPrototype {
  joints: FreightJoint[]
  pieces: FreightPiece[]
  renderMeshes: number
}
export interface FreightCellReceipt extends FreightPrototype {
  cell: string
  prototype: string
}
function indexCount(primitives: Primitive[]) {
  return primitives.reduce((sum, primitive) => sum + (primitive.getIndices()?.getCount() ?? 0), 0)
}
function bakePiece(doc: Document, node: Node) {
  const original = node.getMesh()
  const role = node.getExtras().freightRole
  if (!original || (role !== 'body' && role !== 'hardware')) {
    throw new Error('Freight piece is missing its geometry/body/hardware provenance')
  }
  const mesh = doc.createMesh()
  for (const primitive of original.listPrimitives()) {
    mesh.addPrimitive(primitive.clone())
  }
  transformMesh(mesh, node.getWorldMatrix())
  const staged = doc.createNode('freight-piece').setMesh(mesh)
  requireClosedFreight(triangles(staged, true))
  return {
    staged,
    role,
    primitives: mesh.listPrimitives(),
    sourceSHA256: treeDigest(node, false),
    bakedSHA256: treeDigest(staged),
  }
}
function localUv1(doc: Document, primitive: Primitive) {
  const positions = primitive.getAttribute('POSITION')
  if (!positions) {
    throw new Error('Missing freight positions')
  }
  const values = new Float32Array(positions.getCount() * 2)
  for (let i = 0; i < positions.getCount(); i++) {
    const point = positions.getElement(i, [0, 0, 0])
    values[i * 2] = (point[0] ?? 0) / 1024
    values[i * 2 + 1] = (point[2] ?? 0) / 1024
  }
  primitive.setAttribute(
    'TEXCOORD_1',
    doc.createAccessor().setType('VEC2').setArray(values).setBuffer(positions.getBuffer()),
  )
}
/** Condense each authored local model once; only this wholly owned document is deduplicated. */
export async function prepareFreightPrototypes(doc: Document) {
  const scene = doc.getRoot().listScenes()[0]
  if (!scene) {
    throw new Error('Missing freight library scene')
  }
  const receipts = new Map<string, FreightPrototype>()
  for (const root of [...scene.listChildren()]) {
    if (!root.getName().startsWith('freight:')) {
      throw new Error('Unowned freight library root')
    }
    const joints = JSON.parse(String(root.getExtras().freightJointPlanes)) as FreightJoint[]
    if (
      joints.length === 0 ||
      joints.some((joint) => joint.length !== 4 || !joint.every(Number.isFinite))
    ) {
      throw new Error('Missing authored freight panel joints')
    }
    const holder = doc
      .createNode(root.getName())
      .setExtras({ ...root.getExtras(), freightPrototype: root.getName() })
    scene.addChild(holder)
    const pieces: FreightPiece[] = []
    const groups = new Map<string, Primitive[]>()
    root.traverse((node) => {
      if (!node.getMesh()) {
        return
      }
      const baked = bakePiece(doc, node)
      const primitives = groups.get(baked.role) ?? []
      pieces.push({
        name: node.getName(),
        role: baked.role,
        sourceSHA256: baked.sourceSHA256,
        bakedSHA256: baked.bakedSHA256,
        firstIndex: indexCount(primitives),
        indexCount: indexCount(baked.primitives),
      })
      groups.set(baked.role, [...primitives, ...baked.primitives])
      baked.staged.dispose()
    })
    removeTree(root)
    for (const [role, primitives] of groups) {
      const primitive = joinFreight(primitives)
      localUv1(doc, primitive)
      holder.addChild(
        doc
          .createNode(`${role === 'hardware' ? 'hardware:' : ''}freight-${role}`)
          .setMesh(doc.createMesh().addPrimitive(primitive))
          .setExtras({ freightRole: role }),
      )
    }
    if (!(groups.size > 0 && groups.size <= 2 && pieces.some((piece) => piece.role === 'body'))) {
      throw new Error('Freight condensation must produce body and at most one hardware mesh')
    }
    receipts.set(holder.getName(), { joints, pieces, renderMeshes: groups.size })
  }
  cleanupFreightResources(doc, new Set())
  await doc.transform(dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH] }))
  return receipts
}
function fallbackPrimitive(
  original: Primitive,
  cell: FreightCell,
  translation: number[],
  center: number[],
) {
  const source = original.getAttribute('POSITION')
  if (!source) {
    throw new Error('Missing fallback positions')
  }
  const position = source.clone().setArray(Float32Array.from(source.getArray() ?? []))
  let correction = 0
  for (let i = 0; i < position.getCount(); i++) {
    const point = position.getElement(i, [0, 0, 0])
    for (let a = 0; a < 3; a++) {
      const value = Math.fround((point[a] ?? 0) + (translation[a] ?? 0))
      point[a] = freightContactCoordinate(value, [
        (cell.min[a] ?? 0) - (center[a] ?? 0),
        (cell.max[a] ?? 0) - (center[a] ?? 0),
      ])
      correction = Math.max(correction, Math.abs(value - (point[a] ?? 0)))
    }
    position.setElement(i, point)
  }
  return { primitive: original.clone().setAttribute('POSITION', position), correction }
}
/** Only an actual failed placement gate may request this position-only fallback. */
export function bakeFreightPositions(
  doc: Document,
  branch: Node,
  placement: FreightPlacement,
  cells: FreightCellReceipt[],
) {
  const center = placement.min.map((v, a) => (v + (placement.max[a] ?? 0)) / 2)
  const corrections: number[] = []
  for (const instance of branch.listChildren()) {
    const cell = placement.cells.find((c) => instance.getName() === `freight-cell:${c.id}`)
    const receipt = cells.find((c) => c.cell === cell?.id)
    if (!(cell && receipt)) {
      throw new Error('Missing freight fallback provenance')
    }
    const translation = instance.getTranslation()
    instance.traverse((node) => {
      const source = node.getMesh()
      if (!source) {
        return
      }
      const mesh = doc.createMesh()
      for (const original of source.listPrimitives()) {
        const moved = fallbackPrimitive(original, cell, translation, center)
        mesh.addPrimitive(moved.primitive)
        corrections.push(moved.correction)
      }
      node.setMesh(mesh)
    })
    instance.setTranslation([0, 0, 0])
    instance.traverse((node) => {
      if (!node.getMesh()) {
        return
      }
      const faces = triangles(node, true)
      for (const piece of receipt.pieces.filter((p) => p.role === node.getExtras().freightRole)) {
        requireClosedFreight(
          faces.slice(piece.firstIndex / 3, (piece.firstIndex + piece.indexCount) / 3),
        )
      }
    })
  }
  return Math.max(0, ...corrections)
}
function nodeSignature(node: Node) {
  const formats = node
    .getMesh()
    ?.listPrimitives()
    .map((p) => [
      p.getMode(),
      p.getExtras(),
      p
        .listSemantics()
        .sort()
        .map((key) => {
          const a = p.getAttribute(key)
          return [key, a?.getType(), a?.getCount(), a?.getComponentType(), a?.getNormalized()]
        }),
      p.getIndices()?.getComponentType(),
    ])
  return JSON.stringify([
    treeDigest(node, false),
    node.getWorldMatrix(),
    node.getParentNode()?.getName(),
    node.getMesh()?.getName(),
    formats,
  ])
}
function sameProperties(before: Property[], after: Property[]) {
  const remaining = [...after]
  for (const property of before) {
    const i = remaining.findIndex((target) => property.equals(target))
    if (i < 0) {
      throw new Error(`Unowned resource changed: ${property.propertyType}:${property.getName()}`)
    }
    remaining.splice(i, 1)
  }
}
/** Actual written canonical AND encoded native readback, including unselected crate trees. */
export function requireFreightReadback(
  before: Document,
  after: Document,
  options: { placements: FreightPlacement[]; selected: number[] },
) {
  const excluded = new Set<Node>()
  const fresh = new Set<Node>()
  const placements = matchFreightPlacements(
    before
      .getRoot()
      .listNodes()
      .filter((n) => n.getName() === 'k_crate_big-placement'),
    options.placements,
  )
  for (const index of options.selected) {
    placements.get(index)?.traverse((node) => excluded.add(node))
  }
  for (const node of after.getRoot().listNodes()) {
    if (
      node.getName().startsWith('model-lod:') &&
      options.selected.some((i) => node.getName().endsWith(`:freight-${i}`))
    ) {
      node.traverse((child) => fresh.add(child))
    }
  }
  const expected = new Map<string, number>()
  for (const node of before
    .getRoot()
    .listNodes()
    .filter((n) => !excluded.has(n))) {
    const key = nodeSignature(node)
    expected.set(key, (expected.get(key) ?? 0) + 1)
  }
  for (const node of after
    .getRoot()
    .listNodes()
    .filter((n) => !fresh.has(n))) {
    const key = nodeSignature(node)
    const count = expected.get(key) ?? 0
    if (!count) {
      throw new Error(`Unowned node/typed stream changed: ${node.getName()}`)
    }
    expected.set(key, count - 1)
  }
  if ([...expected.values()].some((count) => count !== 0)) {
    throw new Error('Unowned node missing')
  }
  const a = before.getRoot()
  const b = after.getRoot()
  sameProperties(a.listMaterials(), b.listMaterials())
  sameProperties(a.listTextures(), b.listTextures())
  sameProperties(a.listMeshes(), b.listMeshes())
  sameProperties(a.listAccessors(), b.listAccessors())
  sameProperties(a.listAnimations(), b.listAnimations())
  sameProperties(a.listSkins(), b.listSkins())
  for (const [i, texture] of a.listTextures().entries()) {
    if (
      !Buffer.from(texture.getImage() ?? []).equals(
        Buffer.from(b.listTextures()[i]?.getImage() ?? []),
      )
    ) {
      throw new Error('Unowned image bytes changed')
    }
  }
  if (
    a.listAnimations().length !== b.listAnimations().length ||
    a.listSkins().length !== b.listSkins().length ||
    a.listScenes().length !== b.listScenes().length
  ) {
    throw new Error('Unowned animation/skin/scene count changed')
  }
  for (const [i, scene] of a.listScenes().entries()) {
    if (
      JSON.stringify([scene.getName(), scene.getExtras()]) !==
      JSON.stringify([b.listScenes()[i]?.getName(), b.listScenes()[i]?.getExtras()])
    ) {
      throw new Error('Unowned scene metadata changed')
    }
  }
  return {
    unaffectedNodes: before.getRoot().listNodes().length - excluded.size,
    materials: a.listMaterials().length,
    images: a.listTextures().length,
    animations: a.listAnimations().length,
    skins: a.listSkins().length,
  }
}

export function createFreightMaterial(doc: Document, images: Buffer[]) {
  if (images.length !== 3) {
    throw new Error('Missing freight atlas maps')
  }
  const maps = images.map((image, index) =>
    doc
      .createTexture(`Freight ${['albedo', 'normal', 'arm'][index]}`)
      .setImage(image)
      .setMimeType('image/png'),
  )
  const material = doc
    .createMaterial('Freight scanned atlas')
    .setBaseColorTexture(maps[0] ?? null)
    .setNormalTexture(maps[1] ?? null)
    .setMetallicRoughnessTexture(maps[2] ?? null)
    .setOcclusionTexture(maps[2] ?? null)
    .setMetallicFactor(1)
    .setRoughnessFactor(1)
    .setExtras({ freightWorldUv1: true })
  for (const info of [
    material.getBaseColorTextureInfo(),
    material.getNormalTextureInfo(),
    material.getMetallicRoughnessTextureInfo(),
    material.getOcclusionTextureInfo(),
  ]) {
    if (info?.getTexCoord() !== 0) {
      throw new Error('Freight authored maps must remain UV0')
    }
  }
  return material
}

/** Prepare one shared atlas: source pixel density stays1024/m; no albedo mean normalization. */
export async function prepareFreightAtlas(directory: string): Promise<void> {
  await mkdir(join(directory, 'maps'), { recursive: true })
  for (const [kind, source] of [
    ['albedo', 'diff'],
    ['normal', 'nor'],
    ['arm', 'arm'],
  ] as const) {
    let wood = await sharp(join(directory, `source/wood-${kind}.png`))
      .extract({ left: 0, top: 0, width: 1536, height: 2048 })
      .png()
      .toBuffer()
    if (kind === 'albedo') {
      const frames = await Promise.all(
        [0.075, 0.295, 0.52].map(async (u) => ({
          input: await sharp(join(directory, 'source/wood-albedo.png'))
            .extract({ left: Math.round(u * 2048), top: 0, width: 164, height: 2048 })
            .linear(1.08)
            .png()
            .toBuffer(),
          left: Math.round(u * 2048),
          top: 0,
        })),
      )
      wood = await sharp(wood).composite(frames).png().toBuffer()
    }
    const metal = await sharp(join(directory, `source/rusty_metal_02_${source}.webp`))
      .extract({ left: 0, top: 0, width: 512, height: 512 })
      .png()
      .toBuffer()
    const background = kind === 'normal' ? '#8080ff' : '#ffb800'
    const endgrain = await sharp(Buffer.from(freightEndgrainSvg(kind)))
      .png()
      .toBuffer()
    const labelBase = await sharp(join(directory, `source/wood-${kind}.png`))
      .extract({ left: 360, top: 400, width: 512, height: 1024 })
      .png()
      .toBuffer()
    const labelLayers = [{ input: labelBase }]
    if (kind === 'albedo') {
      const label = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="1024">
<g fill="#171913" opacity=".78" font-family="monospace" font-weight="bold" text-anchor="middle" letter-spacing="3">
<text x="256" y="485" font-size="92">P.D.</text>
<text x="256" y="575" font-size="64">NO.42</text></g></svg>`,
      )
      labelLayers.push({ input: label })
    }
    const labels = await sharp({ create: { width: 512, height: 1024, channels: 3, background } })
      .composite(labelLayers)
      .png()
      .toBuffer()
    await sharp({ create: { width: 2048, height: 2048, channels: 3, background } })
      .composite([
        { input: wood, left: 0, top: 0 },
        { input: metal, left: 1536, top: 1536 },
        { input: endgrain, left: 1536, top: 1024 },
        { input: labels, left: 1536, top: 0 },
      ])
      .png()
      .toFile(join(directory, `maps/freight-${kind}.png`))
  }
}

export function freightArtifactBudget(
  baselineBytes: number,
  nativeBeforeBytes: number,
  nativeAfterBytes: number,
) {
  if (
    ![baselineBytes, nativeBeforeBytes, nativeAfterBytes].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  ) {
    throw new Error('Missing actual artifact/native byte counts')
  }
  const projectedBytes = baselineBytes + nativeAfterBytes - nativeBeforeBytes
  if (projectedBytes >= 1_000_000_000) {
    throw new Error(`Freight would exceed Pages budget: ${projectedBytes}`)
  }
  return {
    baselineBytes,
    nativeBeforeBytes,
    nativeAfterBytes,
    projectedBytes,
    limitBytes: 1_000_000_000,
  }
}
