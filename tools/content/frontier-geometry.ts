/** Standard glTF offline authoring. No procedural geometry is shipped to the browser. */
import { readFile } from 'node:fs/promises'
import { type Document, type Material, type Mesh, type Node, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  dequantize,
  getBounds,
  mergeDocuments,
  prune,
  unpartition,
} from '@gltf-transform/functions'
import { MeshoptDecoder } from 'meshoptimizer'
import { calculateNormals, calculateTangents } from 'playcanvas'
import sharp from 'sharp'
import { projectedUv, surfaceMaterial } from './animal-prop-surfaces.ts'
import type { CollisionMesh } from './frontier-collision.ts'
import { fitCells, fitPrefab, hash01, type PrefabFit } from './frontier-fit.ts'
import { frontierGroundTransform } from './frontier-ground.ts'
import { scanMaterial } from './frontier-surfaces.ts'
import { addCactusPrefabs, type Saguaro, splitVegetation } from './frontier-vegetation.ts'
import { repairFrontierWinding } from './frontier-winding.ts'

export type { PrefabFit } from './frontier-fit.ts'
export type Rgb = readonly [number, number, number]
export interface Placement {
  x: number
  z: number
  w: number
  d: number
  y0?: number
  top: number
}
interface Geometry {
  positions: number[]
  indices: number[]
  uvs: number[]
  colors: number[]
}
export const frontierIO = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const textureRoot = 'public/experiments/out-west/3d/tex'
const libraryPath = 'tools/art/environments/frontier-library.glb'

async function texture(doc: Document, name: string) {
  return doc
    .createTexture(name)
    .setImage(await readFile(`${textureRoot}/${name}.webp`))
    .setMimeType('image/webp')
}
async function pbr(doc: Document, role: string, prefix: string, metallic = 0) {
  const [albedo, normal, arm] = await Promise.all(
    ['diff', 'nor', 'arm'].map((kind) => texture(doc, `${prefix}_${kind}`)),
  )
  if (!(albedo && normal && arm)) {
    throw new Error(`Missing ${role} PBR maps`)
  }
  return doc
    .createMaterial(role)
    .setBaseColorTexture(albedo)
    .setNormalTexture(normal)
    .setMetallicRoughnessTexture(arm)
    .setOcclusionTexture(arm)
    .setMetallicFactor(metallic)
    .setRoughnessFactor(1)
    .setNormalScale(0.75)
}

function retainVegetation(foliage: Document): void {
  const keep = new Set<Node>()
  for (const node of foliage
    .getRoot()
    .listNodes()
    .filter((entry) => entry.getName().startsWith('flora-'))) {
    let parent: Node | null = node
    while (parent) {
      keep.add(parent)
      parent = parent.getParentNode()
    }
  }
  for (const node of foliage.getRoot().listNodes()) {
    if (!keep.has(node)) {
      node.dispose()
    }
  }
  for (const animation of foliage.getRoot().listAnimations()) {
    if (animation.listChannels().some((channel) => !channel.getTargetNode())) {
      animation.dispose()
    }
  }
}

/** Bootstrap migration only. Normal bakes read the small checked-in canonical library. */
export async function seedFrontierLibrary(original: string): Promise<void> {
  await MeshoptDecoder.ready
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  const props = await io.read('public/experiments/out-west/3d/models/props.glb')
  props
    .getRoot()
    .listExtensionsUsed()
    .find((extension) => extension.extensionName === 'EXT_meshopt_compression')
    ?.dispose()
  await props.transform(dequantize())
  const kit = await pbr(props, 'Kit', 'kit', 1)
  for (const material of props.getRoot().listMaterials()) {
    if (material !== kit && material.getName() === 'Kit') {
      for (const mesh of props.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          if (primitive.getMaterial() === material) {
            primitive.setMaterial(kit)
          }
        }
      }
    }
  }
  const scene = props.createScene('Perdition reusable library')
  for (const source of props
    .getRoot()
    .listScenes()
    .filter((entry) => entry !== scene)) {
    for (const node of source.listChildren()) {
      node.setName(`prefab.${source.getName()}`)
      scene.addChild(node)
    }
    source.dispose()
  }
  props.getRoot().setDefaultScene(scene)
  const foliage = await io.read(original)
  retainVegetation(foliage)
  await foliage.transform(prune())
  mergeDocuments(props, foliage)
  for (const extra of props.getRoot().listScenes().slice(1)) {
    for (const child of extra.listChildren()) {
      child.setName('frontier-desert-vegetation')
      scene.addChild(child)
    }
    extra.dispose()
  }
  await props.transform(prune(), unpartition())
  await io.write(libraryPath, props)
}

function cloneTree(doc: Document, source: Node): Node {
  const node = doc
    .createNode(source.getName())
    .setTranslation(source.getTranslation())
    .setRotation(source.getRotation())
    .setScale(source.getScale())
    .setMesh(source.getMesh())
  for (const child of source.listChildren()) {
    if (!child.getName().endsWith('_glass')) {
      node.addChild(cloneTree(doc, child))
    }
  }
  return node
}

export class FrontierGeometry {
  readonly doc: Document
  readonly root: Node
  readonly materials = new Map<string, Material>()
  /** Outskirts saguaro sites lifted from the legacy vegetation, re-authored on the terrain. */
  readonly saguaros: Saguaro[] = []
  private readonly prototypes = new Map<string, Node>()
  private readonly buffers = new Map<string, { root: Node; material: Material; data: Geometry }>()
  private readonly buffer
  private constructor(doc: Document, size: number) {
    this.doc = doc
    this.buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer('Perdition geometry')
    for (const node of doc.getRoot().listNodes()) {
      if (node.getName().startsWith('prefab.')) {
        this.prototypes.set(node.getName().slice(7), node)
      }
    }
    const vegetation = doc
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === 'frontier-desert-vegetation')
    for (const scene of doc.getRoot().listScenes()) {
      scene.dispose()
    }
    this.root = doc.createNode('town')
    doc.createScene('Perdition').addChild(this.root)
    if (vegetation) {
      const ground = frontierGroundTransform(size)
      vegetation
        .setTranslation(ground.translation)
        .setScale([ground.scale, ground.scale, ground.scale])
      this.root.addChild(vegetation)
    }
  }
  static async create(size = 104): Promise<FrontierGeometry> {
    const result = new FrontierGeometry(await frontierIO.read(libraryPath), size)
    console.log('Authored winding repairs', repairFrontierWinding(result.doc))
    const vegetation = await splitVegetation(result.doc, frontierGroundTransform(size))
    console.log('Vegetation tissues', vegetation.counts, 'saguaros', vegetation.saguaros.length)
    result.saguaros.push(...vegetation.saguaros)
    for (const [name, prefab] of await addCactusPrefabs(
      result.doc,
      await frontierIO.read('tools/art/environments/frontier-cacti.glb'),
    )) {
      result.prototypes.set(name, prefab)
    }
    for (const [name, kind] of [
      ['Hay', 'straw'],
      ['Green', 'cactus'],
    ] as const) {
      const material = await surfaceMaterial(result.doc, kind, name)
      if (name === 'Hay') {
        material.setBaseColorFactor([0.72, 0.56, 0.25, 1])
      }
      for (const mesh of result.doc.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          if (primitive.getMaterial() === material) {
            projectedUv(result.doc, primitive, 6)
          }
        }
      }
    }
    const straw = await scanMaterial(result.doc, 'Perdition baled straw', 'thatch_roof_angled', {
      size: 512,
    })
    result.materials.set('straw', straw.setBaseColorFactor([0.86, 0.8, 0.72, 1]))
    result.materials.set(
      'iron',
      await scanMaterial(result.doc, 'Perdition iron', 'rusty_metal_02', {
        metallic: 1,
        size: 512,
      }),
    )
    result.materials.set(
      'masonry',
      await scanMaterial(result.doc, 'Perdition dressed stone', 'sandstone_cracks', { size: 512 }),
    )
    for (const [role, prefix] of [
      ['wood', 'vplanks'],
      ['floor', 'planks'],
      ['ground', 'ground'],
    ] as const) {
      result.materials.set(role, await pbr(result.doc, `Perdition ${role}`, prefix))
    }
    // One brick tile, not a repeating multi-surface civic atlas.
    const stone = await pbr(result.doc, 'Perdition stone', 'civic')
    for (const image of [
      stone.getBaseColorTexture(),
      stone.getNormalTexture(),
      stone.getMetallicRoughnessTexture(),
    ]) {
      const bytes = image?.getImage()
      if (!(image && bytes)) {
        continue
      }
      const meta = await sharp(bytes).metadata()
      const half = Math.floor((meta.width ?? 0) / 2)
      const gutter = Math.floor(half / 32)
      image.setImage(
        await sharp(bytes)
          .extract({
            left: gutter,
            top: gutter,
            width: half - gutter * 2,
            height: half - gutter * 2,
          })
          .webp({ lossless: true })
          .toBuffer(),
      )
    }
    result.materials.set('stone', stone)
    const kit = result.doc
      .getRoot()
      .listMaterials()
      .find((material) => material.getName() === 'Kit')
    if (!kit) {
      throw new Error('Canonical prop library has no Kit PBR material')
    }
    result.materials.set('kit', kit)
    return result
  }
  group(name: string): Node {
    const node = this.doc.createNode(name)
    this.root.addChild(node)
    return node
  }
  material(role: string): Material {
    const value = this.materials.get(role)
    if (!value) {
      throw new Error(`Missing native material ${role}`)
    }
    return value
  }
  private geometry(root: Node, role: string): Geometry {
    const key = `${root.getName()}:${role}`
    let entry = this.buffers.get(key)
    if (!entry) {
      entry = {
        root,
        material: this.material(role),
        data: { positions: [], indices: [], uvs: [], colors: [] },
      }
      this.buffers.set(key, entry)
    }
    return entry.data
  }
  quad(
    root: Node,
    role: string,
    points: readonly (readonly number[])[],
    appearance: { tint?: Rgb; tile?: number; uvs?: readonly (readonly number[])[] } = {},
  ): void {
    const { tint = [1, 1, 1], tile = 1.8 } = appearance
    const data = this.geometry(root, role)
    const start = data.positions.length / 3
    if (points.length !== 4) {
      throw new Error('A quad needs four authored corners')
    }
    const normal = calculateNormals(points.flat(), [0, 1, 2, 0, 2, 3])
    const nx = Math.abs(normal[0] ?? 0)
    const ny = Math.abs(normal[1] ?? 0)
    const nz = Math.abs(normal[2] ?? 0)
    const horizontal = ny > Math.max(nx, nz)
    const alongZ = nx > nz
    for (const [index, point] of points.entries()) {
      const [x = 0, y = 0, z = 0] = point
      data.positions.push(x, y, z)
      data.uvs.push(
        ...(appearance.uvs?.[index] ?? [(alongZ ? z : x) / tile, (horizontal ? z : y) / tile]),
      )
      data.colors.push(...tint, 1)
    }
    data.indices.push(start, start + 1, start + 2, start, start + 2, start + 3)
  }
  box(root: Node, role: string, area: Placement, tint: Rgb = [1, 1, 1]): void {
    const { x, z, w, d, top } = area
    const y = area.y0 ?? 0
    const a = [x, y, z]
    const b = [x + w, y, z]
    const c = [x + w, y, z + d]
    const e = [x, y, z + d]
    const aa = [x, top, z]
    const bb = [x + w, top, z]
    const cc = [x + w, top, z + d]
    const ee = [x, top, z + d]
    for (const face of [
      [a, aa, bb, b],
      [b, bb, cc, c],
      [c, cc, ee, e],
      [e, ee, aa, a],
      [aa, ee, cc, bb],
      [a, b, c, e],
    ]) {
      this.quad(root, role, face, { tint })
    }
  }
  surface(
    root: Node,
    role: string,
    mesh: CollisionMesh & { uvs?: number[]; colors?: number[] },
    tint: Rgb = [1, 1, 1],
  ): void {
    const data = this.geometry(root, role)
    const offset = data.positions.length / 3
    data.positions.push(...mesh.positions)
    data.indices.push(...mesh.indices.map((index) => index + offset))
    const normals = calculateNormals(mesh.positions, mesh.indices)
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const nx = Math.abs(normals[i] ?? 0)
      const ny = Math.abs(normals[i + 1] ?? 0)
      const nz = Math.abs(normals[i + 2] ?? 0)
      const horizontal = ny > Math.max(nx, nz)
      const alongZ = nx > nz
      data.uvs.push(
        mesh.uvs?.[(i / 3) * 2] ?? (mesh.positions[i + (alongZ ? 2 : 0)] ?? 0) / 1.8,
        mesh.uvs?.[(i / 3) * 2 + 1] ?? (mesh.positions[i + (horizontal ? 2 : 1)] ?? 0) / 1.8,
      )
      data.colors.push(...(mesh.colors?.slice((i / 3) * 4, (i / 3) * 4 + 4) ?? [...tint, 1]))
    }
  }
  /** Authored bounding size of a library prop, in metres. */
  naturalSize(name: string): [number, number, number] {
    const source = this.prototypes.get(name)
    if (!source) {
      throw new Error(`Missing authored prop ${name}`)
    }
    const { min, max } = getBounds(source)
    return [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  }
  /**
   * Place a library prop inside a cover volume without distorting it. Tiled props repeat at
   * near-authored size to fill the volume; any axis departs from uniform scale by at most
   * `anisotropy`, so the visible solid stays inside, and close to, the gameplay collision.
   */
  prefab(root: Node, name: string, area: Placement, fit: PrefabFit = {}): Node {
    const source = this.prototypes.get(name)
    if (!source) {
      throw new Error(`Missing authored prop ${name}`)
    }
    const bounds = getBounds(source)
    const sx = bounds.max[0] - bounds.min[0]
    const sy = bounds.max[1] - bounds.min[1]
    const sz = bounds.max[2] - bounds.min[2]
    if (!(sx > 0 && sy > 0 && sz > 0)) {
      throw new Error(`Invalid prefab bounds ${name}`)
    }
    const swap = sx >= sz !== area.w >= area.d
    const natural = swap ? [sz, sy, sx] : [sx, sy, sz]
    const bottom = area.y0 ?? 0
    const size = [area.w, area.top - bottom, area.d]
    const { counts, scale } = fitPrefab(natural, size, fit)
    const group = this.doc.createNode(`${name}-placement`)
    const pivot: [number, number, number] = [
      -(bounds.min[0] + bounds.max[0]) / 2,
      -bounds.min[1],
      -(bounds.min[2] + bounds.max[2]) / 2,
    ]
    for (const [x, y, z] of fitCells(area, counts, fit.hollow)) {
      const yaw = (fit.jitter ?? 0) * (2 * hash01(x, y, z) - 1) + (swap ? Math.PI / 2 : 0)
      const [wx = 1, wy = 1, wz = 1] = scale
      const center = this.doc.createNode('source-pivot').setTranslation(pivot)
      center.addChild(cloneTree(this.doc, source))
      group.addChild(
        this.doc
          .createNode(`${name}-instance`)
          .setTranslation([x, y, z])
          .setRotation([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)])
          .setScale(swap ? [wz, wy, wx] : [wx, wy, wz])
          .addChild(center),
      )
    }
    root.addChild(group)
    return group
  }
  finish(): void {
    for (const [name, entry] of this.buffers) {
      const { positions, indices, uvs, colors } = entry.data
      const normals = calculateNormals(positions, indices)
      const tangents = calculateTangents(positions, normals, uvs, indices)
      const accessor = (type: 'VEC2' | 'VEC3' | 'VEC4', values: number[]) =>
        this.doc
          .createAccessor()
          .setBuffer(this.buffer)
          .setType(type)
          .setArray(new Float32Array(values))
      const primitive = this.doc
        .createPrimitive()
        .setAttribute('POSITION', accessor('VEC3', positions))
        .setAttribute('NORMAL', accessor('VEC3', normals))
        .setAttribute('TEXCOORD_0', accessor('VEC2', uvs))
        .setAttribute('COLOR_0', accessor('VEC4', colors))
        .setAttribute('TANGENT', accessor('VEC4', tangents))
        .setIndices(
          this.doc
            .createAccessor()
            .setBuffer(this.buffer)
            .setType('SCALAR')
            .setArray(new Uint32Array(indices)),
        )
        .setMaterial(entry.material)
      const mesh: Mesh = this.doc.createMesh(name).addPrimitive(primitive)
      if (entry.material.getName() === 'window-glass') {
        entry.root.setMesh(mesh)
      } else {
        entry.root.addChild(this.doc.createNode(`${name}-mesh`).setMesh(mesh))
      }
    }
  }
}
