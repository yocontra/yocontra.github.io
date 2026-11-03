#!/usr/bin/env bun
// biome-ignore-all lint/style/useNamingConvention: BAND_OF keys mirror the kits' texture file names
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: per-vertex loops over typed arrays, kept flat for speed and readability
// biome-ignore-all lint/performance/noAwaitInLoops: an offline build that reads one source file at a time, in order
/**
 * Build `models/props.glb` and its trim atlas (`tex/kit_{diff,nor,arm}.webp`) from Quaternius's
 * CC0 "Medieval Village MegaKit" and "Fantasy Props MegaKit" (standard, free editions; see
 * CREDITS.md): doors, windows, shutters, boardwalk planks, porch posts, balconies, fences, a
 * wagon, barrels, crates, buckets, benches, chests, sacks, coin purses...
 *
 *   bun tools/build-props.ts <kit_dir> [out_root]
 *
 * `<kit_dir>` holds both kits' glTF exports and textures flattened into one folder.
 *
 * The kits are trim sheets: their UVs tile along U and stay inside 0..1 along V. So every sheet
 * is stacked into ONE atlas, one band each (scaled into the band along V, U left to repeat),
 * and every prop draws with ONE material ("Kit", bound to the atlas at runtime by
 * engine/assets.ts): an instanced prop or a merged street is one draw.
 *
 * The props GLB keeps its scene-per-prop layout (scene/props.ts `propDef`): `barrel`, `crate`,
 * `cart` and `fence` are replaced by kit models; the revolver keeps its shape and gains UVs
 * (box-projected onto the atlas's steel and walnut bands); the rest are new `k_*` scenes for the
 * town and street builders.
 */
import { mkdir } from 'node:fs/promises'
import {
  type Document,
  type Node as GNode,
  type Material,
  type Mesh,
  NodeIO,
} from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions'
import { prune, quantize, reorder } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import sharp, { type Sharp } from 'sharp'
import { Matrix3, Matrix4, Vector3 } from 'three'
import {
  KIT_BAND,
  KIT_H,
  KIT_INSET,
  KIT_W,
  type KitBand,
} from '../src/experiments/out-west/scene/kit-atlas.ts'

const [KIT = '', OUT = 'public/experiments/out-west/3d'] = process.argv.slice(2)
if (!KIT) {
  throw new Error('usage: bun tools/build-props.ts <kit_dir> [out_root]')
}

await MeshoptDecoder.ready
await MeshoptEncoder.ready
await MeshoptSimplifier.ready
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder })

// ---------------------------------------------------------------- atlas

interface Sheet {
  band: KitBand
  diff: string
  nor?: string
  /** ARM (R = AO, G = roughness, B = metal) or a roughness-only map. */
  arm?: string
  rough?: string
}

const SHEETS: Sheet[] = [
  {
    band: 'wood',
    diff: 'T_WoodTrim_BaseColor',
    nor: 'T_WoodTrim_Normal',
    rough: 'T_WoodTrim_Roughness',
  },
  {
    band: 'furniture',
    diff: 'T_Trim_Furniture_BaseColor',
    nor: 'T_Trim_Furniture_Normal',
    arm: 'T_Trim_Furniture_ORM',
  },
  {
    band: 'metal',
    diff: 'T_Trim_Metal_BaseColor',
    nor: 'T_Trim_Metal_Normal',
    arm: 'T_Trim_Metal_ORM',
  },
  {
    band: 'props',
    diff: 'T_Trim_Props_BaseColor',
    nor: 'T_Trim_Props_Normal',
    arm: 'T_Trim_Props_ORM',
  },
  { band: 'ornament', diff: 'T_MetalOrnaments_BaseColor', rough: 'T_MetalOrnaments_Roughness' },
  {
    band: 'cloth',
    diff: 'T_Trim_Cloth_BaseColor',
    nor: 'T_Trim_Cloth_Normal',
    arm: 'T_Trim_Cloth_ORM',
  },
]

/** Which band a source texture lives in (keys are the kits' texture file names). */
const BAND_OF: Record<string, KitBand> = {
  T_WoodTrim_BaseColor: 'wood',
  T_Trim_Furniture_BaseColor: 'furniture',
  T_Trim_Metal_BaseColor: 'metal',
  T_Trim_Props_BaseColor: 'props',
  T_MetalOrnaments_BaseColor: 'ornament',
  T_Trim_Cloth_BaseColor: 'cloth',
}

interface Layer {
  input: Buffer
  left: number
  top: number
}

/** A source scaled into its band (inner rows), its first/last rows copied into the gutter. */
async function band(src: Sharp, b: KitBand, k: number): Promise<Layer> {
  const r = KIT_BAND[b]
  const pad = Math.round(KIT_INSET * k)
  const w = Math.round(KIT_W * k)
  const h = Math.round(r.h * k) - 2 * pad
  const body = await src.resize(w, h, { fit: 'fill' }).removeAlpha().png().toBuffer()
  const input = await sharp(body)
    .extend({ top: pad, bottom: pad, extendWith: 'copy' })
    .png()
    .toBuffer()
  return { input, left: 0, top: Math.round(r.y * k) }
}

async function armFrom(s: Sheet): Promise<Sharp> {
  if (s.arm) {
    return sharp(`${KIT}/${s.arm}.png`)
  }
  const { data, info } = await sharp(`${KIT}/${s.rough ?? s.diff}.png`)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const out = Buffer.alloc(info.width * info.height * 3)
  for (let i = 0; i < info.width * info.height; i++) {
    out[i * 3] = 255
    out[i * 3 + 1] = s.rough ? (data[i * info.channels] ?? 200) : 200
    out[i * 3 + 2] = s.band === 'ornament' ? 255 : 0
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } })
}

const flat = (rgb: [number, number, number]) =>
  sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })

async function buildAtlas(): Promise<void> {
  const diff: Layer[] = []
  const nor: Layer[] = []
  const arm: Layer[] = []
  for (const s of SHEETS) {
    diff.push(await band(sharp(`${KIT}/${s.diff}.png`), s.band, 1))
    nor.push(await band(s.nor ? sharp(`${KIT}/${s.nor}.png`) : flat([128, 128, 255]), s.band, 0.5))
    arm.push(await band(await armFrom(s), s.band, 0.5))
  }
  diff.push(await band(flat([255, 255, 255]), 'plain', 1))
  nor.push(await band(flat([128, 128, 255]), 'plain', 0.5))
  arm.push(await band(flat([255, 200, 0]), 'plain', 0.5))
  const canvas = (k: number) =>
    sharp({
      create: {
        width: Math.round(KIT_W * k),
        height: Math.round(KIT_H * k),
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
  await canvas(1).composite(diff).webp({ quality: 88 }).toFile(`${OUT}/tex/kit_diff.webp`)
  await canvas(0.5).composite(nor).webp({ quality: 88 }).toFile(`${OUT}/tex/kit_nor.webp`)
  await canvas(0.5).composite(arm).webp({ quality: 86 }).toFile(`${OUT}/tex/kit_arm.webp`)
}

/** V of a source UV, moved into its band's inner rows. */
function bandV(b: KitBand, v: number): number {
  const r = KIT_BAND[b]
  const c = Math.min(1, Math.max(0, v))
  return (r.y + KIT_INSET + c * (r.h - 2 * KIT_INSET)) / KIT_H
}

// ---------------------------------------------------------------- geometry

interface Geo {
  pos: number[]
  nrm: number[]
  uv: number[]
  col: number[]
  idx: number[]
}

const empty = (): Geo => ({ pos: [], nrm: [], uv: [], col: [], idx: [] })

const texName = (m: Material | null): string =>
  (m?.getBaseColorTexture()?.getURI() ?? '').replace(/\.[a-z]+$/u, '').replace(/^.*\//u, '')

/** All of one kit file, in its scene's space, split into the atlas geometry and the glass. */
async function readPiece(file: string): Promise<{ kit: Geo; glass: Geo }> {
  const d = await io.read(`${KIT}/${file}.gltf`)
  const out = { kit: empty(), glass: empty() }
  const v = new Vector3()
  const n3 = new Matrix3()
  for (const node of d.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) {
      continue
    }
    const m = new Matrix4().fromArray(Array.from(node.getWorldMatrix()))
    n3.getNormalMatrix(m)
    for (const p of mesh.listPrimitives()) {
      const mat = p.getMaterial()
      const glass = /Glass/u.test(mat?.getName() ?? '')
      const tn = texName(mat)
      const b: KitBand = BAND_OF[tn] ?? 'plain'
      const g = glass ? out.glass : out.kit
      const P = p.getAttribute('POSITION')?.getArray() ?? new Float32Array()
      const N = p.getAttribute('NORMAL')?.getArray() ?? new Float32Array()
      const T = p.getAttribute('TEXCOORD_0')?.getArray()
      const C = p.getAttribute('COLOR_0')
      const f = mat?.getBaseColorFactor() ?? [1, 1, 1, 1]
      const base = g.pos.length / 3
      for (let k = 0; k < P.length / 3; k++) {
        v.set(P[k * 3] ?? 0, P[k * 3 + 1] ?? 0, P[k * 3 + 2] ?? 0).applyMatrix4(m)
        g.pos.push(v.x, v.y, v.z)
        v.set(N[k * 3] ?? 0, N[k * 3 + 1] ?? 1, N[k * 3 + 2] ?? 0)
          .applyMatrix3(n3)
          .normalize()
        g.nrm.push(v.x, v.y, v.z)
        g.uv.push(T ? (T[k * 2] ?? 0) : 0.5, bandV(b, T ? (T[k * 2 + 1] ?? 0.5) : 0.5))
        const c = C ? C.getElement(k, []) : [1, 1, 1]
        // untextured parts keep their flat colour; textured ones only their vertex tint
        const fk = tn ? [1, 1, 1] : f
        g.col.push(
          (c[0] ?? 1) * (fk[0] ?? 1),
          (c[1] ?? 1) * (fk[1] ?? 1),
          (c[2] ?? 1) * (fk[2] ?? 1),
        )
      }
      const I = p.getIndices()?.getArray()
      const count = I ? I.length : P.length / 3
      for (let t = 0; t < count; t++) {
        g.idx.push(base + (I ? (I[t] ?? 0) : t))
      }
    }
  }
  return out
}

function concat(parts: { g: Geo; m: Matrix4 }[]): Geo {
  const out = empty()
  const v = new Vector3()
  const n3 = new Matrix3()
  for (const { g, m } of parts) {
    n3.getNormalMatrix(m)
    const base = out.pos.length / 3
    for (let k = 0; k < g.pos.length / 3; k++) {
      v.set(g.pos[k * 3] ?? 0, g.pos[k * 3 + 1] ?? 0, g.pos[k * 3 + 2] ?? 0).applyMatrix4(m)
      out.pos.push(v.x, v.y, v.z)
      v.set(g.nrm[k * 3] ?? 0, g.nrm[k * 3 + 1] ?? 0, g.nrm[k * 3 + 2] ?? 0)
        .applyMatrix3(n3)
        .normalize()
      out.nrm.push(v.x, v.y, v.z)
    }
    out.uv.push(...g.uv)
    out.col.push(...g.col)
    out.idx.push(...g.idx.map((i) => i + base))
  }
  return out
}

function simplify(g: Geo, target: number, maxError = 0.02): Geo {
  if (!target || g.idx.length / 3 <= target) {
    return g
  }
  const n = g.pos.length / 3
  const attrs = new Float32Array(n * 5)
  for (let i = 0; i < n; i++) {
    attrs.set(g.nrm.slice(i * 3, i * 3 + 3), i * 5)
    attrs.set(g.uv.slice(i * 2, i * 2 + 2), i * 5 + 3)
  }
  const [index] = MeshoptSimplifier.simplifyWithAttributes(
    Uint32Array.from(g.idx),
    Float32Array.from(g.pos),
    3,
    attrs,
    5,
    [0.3, 0.3, 0.3, 1, 1],
    null,
    target * 3,
    maxError,
    [],
  )
  return { ...g, idx: Array.from(index) }
}

// ---------------------------------------------------------------- pieces

interface PieceSpec {
  /** Scene name in props.glb. */
  scene: string
  /** Kit files with their placement (several make one composite prop). */
  parts: { file: string; at?: Matrix4 }[]
  /** Target triangles (0 = keep). */
  tris: number
  /** Simplifier error bound (relative to the piece's size). */
  err?: number
}

const at = (x: number, y = 0, z = 0, ry = 0) => new Matrix4().makeRotationY(ry).setPosition(x, y, z)

const PIECES: PieceSpec[] = [
  // replacements for the old Quaternius props (same scene names)
  { scene: 'barrel', parts: [{ file: 'Barrel' }], tris: 520 },
  { scene: 'crate', parts: [{ file: 'Prop_Crate' }], tris: 0 },
  { scene: 'cart', parts: [{ file: 'Prop_Wagon' }], tris: 1100 },
  {
    scene: 'fence',
    parts: [
      { file: 'Prop_WoodenFence_Single', at: at(-2) },
      { file: 'Prop_WoodenFence_Extension1', at: at(0) },
      { file: 'Prop_WoodenFence_Extension1', at: at(2) },
    ],
    tris: 0,
  },
  // the street and town builders' kit
  { scene: 'k_door', parts: [{ file: 'Door_1_Flat' }], tris: 0 },
  { scene: 'k_door_plank', parts: [{ file: 'Door_4_Flat' }], tris: 700 },
  { scene: 'k_door_braced', parts: [{ file: 'Door_8_Flat' }], tris: 700 },
  { scene: 'k_doorframe', parts: [{ file: 'DoorFrame_Flat_WoodDark' }], tris: 0 },
  { scene: 'k_window_wide', parts: [{ file: 'Window_Wide_Flat1' }], tris: 0 },
  { scene: 'k_window_thin', parts: [{ file: 'Window_Thin_Flat1' }], tris: 0 },
  { scene: 'k_shutters_wide', parts: [{ file: 'WindowShutters_Wide_Flat_Open' }], tris: 0 },
  { scene: 'k_shutters_thin', parts: [{ file: 'WindowShutters_Thin_Flat_Open' }], tris: 0 },
  { scene: 'k_floor', parts: [{ file: 'Floor_WoodDark' }], tris: 0 },
  { scene: 'k_floor_light', parts: [{ file: 'Floor_WoodLight' }], tris: 0 },
  { scene: 'k_balcony', parts: [{ file: 'Balcony_Simple_Straight' }], tris: 420, err: 0.08 },
  { scene: 'k_support', parts: [{ file: 'Prop_Support' }], tris: 0 },
  { scene: 'k_corner', parts: [{ file: 'Corner_Exterior_Wood' }], tris: 0 },
  { scene: 'k_roof', parts: [{ file: 'Roof_Wooden_2x1_Middle' }], tris: 0 },
  { scene: 'k_bucket', parts: [{ file: 'Bucket_Wooden_1' }], tris: 360 },
  { scene: 'k_bench', parts: [{ file: 'Bench' }], tris: 0 },
  { scene: 'k_chest', parts: [{ file: 'Chest_Wood' }], tris: 800 },
  { scene: 'k_stall', parts: [{ file: 'Stall_Cart_Empty' }], tris: 1400 },
  { scene: 'k_sack', parts: [{ file: 'Bag' }], tris: 380 },
  { scene: 'k_pouch', parts: [{ file: 'Pouch_Large' }], tris: 300 },
  { scene: 'k_coins', parts: [{ file: 'Coin_Pile' }], tris: 400 },
  { scene: 'k_table', parts: [{ file: 'Table_Large' }], tris: 600 },
  { scene: 'k_chair', parts: [{ file: 'Chair_1' }], tris: 0 },
  { scene: 'k_stool', parts: [{ file: 'Stool' }], tris: 0 },
  { scene: 'k_barrel_rack', parts: [{ file: 'Barrel_Holder' }], tris: 900, err: 0.06 },
  { scene: 'k_rope', parts: [{ file: 'Rope_1' }], tris: 500 },
  { scene: 'k_lantern', parts: [{ file: 'Lantern_Wall' }], tris: 900, err: 0.06 },
  { scene: 'k_bottle', parts: [{ file: 'Bottle_1' }], tris: 0 },
  { scene: 'k_crate_big', parts: [{ file: 'Crate_Wooden' }], tris: 700 },
  { scene: 'k_farmcrate', parts: [{ file: 'FarmCrate_Empty' }], tris: 600 },
  { scene: 'k_anvil', parts: [{ file: 'Anvil' }], tris: 0 },
  { scene: 'k_workbench', parts: [{ file: 'Workbench' }], tris: 800 },
  { scene: 'k_bucket_metal', parts: [{ file: 'Bucket_Metal' }], tris: 0 },
]

function addGeo(doc: Document, name: string, g: Geo, mat: Material): GNode {
  const buf = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  const acc = (type: 'VEC2' | 'VEC3' | 'SCALAR', a: Float32Array | Uint16Array | Uint32Array) =>
    doc.createAccessor().setType(type).setArray(a.slice()).setBuffer(buf)
  const n = g.pos.length / 3
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', acc('VEC3', Float32Array.from(g.pos)))
    .setAttribute('NORMAL', acc('VEC3', Float32Array.from(g.nrm)))
    .setAttribute('TEXCOORD_0', acc('VEC2', Float32Array.from(g.uv)))
    .setAttribute('COLOR_0', acc('VEC3', Float32Array.from(g.col)))
    .setIndices(acc('SCALAR', n > 65_535 ? Uint32Array.from(g.idx) : Uint16Array.from(g.idx)))
    .setMaterial(mat)
  const mesh: Mesh = doc.createMesh(name).addPrimitive(prim)
  return doc.createNode(name).setMesh(mesh)
}

/**
 * The old revolver keeps its shape and gains UVs: each part box-projected along its dominant
 * axis onto a band of the atlas (steel for the frame, cylinder and barrel; walnut for the grip).
 */
function textureRevolver(doc: Document, kit: Material): void {
  const scene = doc
    .getRoot()
    .listScenes()
    .find((s) => s.getName() === 'revolver')
  if (!scene) {
    return
  }
  const buf = doc.getRoot().listBuffers()[0] ?? doc.createBuffer()
  scene.traverse((node) => {
    for (const p of node.getMesh()?.listPrimitives() ?? []) {
      const name = p.getMaterial()?.getName() ?? ''
      const wood = /Wood/u.test(name)
      const P = p.getAttribute('POSITION')
      const N = p.getAttribute('NORMAL')
      if (!(P && N)) {
        continue
      }
      const n = P.getCount()
      const uv = new Float32Array(n * 2)
      const col = new Float32Array(n * 3)
      const pos: number[] = []
      const nrm: number[] = []
      for (let k = 0; k < n; k++) {
        const x = P.getElement(k, pos)
        const q = N.getElement(k, nrm)
        const ax = Math.abs(q[0] ?? 0)
        const ay = Math.abs(q[1] ?? 0)
        const az = Math.abs(q[2] ?? 0)
        // project on the plane facing the normal; the revolver model is ~3 units long
        let [a, b] = [x[0], x[1]]
        if (ax >= ay && ax >= az) {
          ;[a, b] = [x[2], x[1]]
        } else if (ay >= az) {
          ;[a, b] = [x[0], x[2]]
        }
        const s = 0.6
        uv[k * 2] = (a ?? 0) * s
        // a narrow V window inside the band so the pattern stays one material
        const v01 = 0.5 + 0.5 * Math.sin((b ?? 0) * s * 3)
        uv[k * 2 + 1] = wood
          ? bandV('furniture', 0.1 + 0.22 * v01)
          : bandV('metal', 0.03 + 0.08 * v01)
        let shade = wood ? 1 : 0.55
        if (name === 'LightMetal') {
          shade = 0.85
        }
        col.set([shade, shade, shade], k * 3)
      }
      p.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(buf))
      p.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(col).setBuffer(buf))
      p.setMaterial(kit)
    }
  })
}

async function main(): Promise<void> {
  await mkdir(`${OUT}/tex`, { recursive: true })
  await buildAtlas()
  // the original merged props (Quaternius/KayKit, see CREDITS.md): revolver, rifle, cactus...
  const doc = await io.read('tools/art/props-src.glb')
  const root = doc.getRoot()
  const kit = doc.createMaterial('Kit')
  const glass = doc.createMaterial('KitGlass').setBaseColorFactor([0.1, 0.09, 0.08, 1])
  for (const spec of PIECES) {
    const old = root.listScenes().find((s) => s.getName() === spec.scene)
    old?.dispose()
    const parts = await Promise.all(
      spec.parts.map(async (p) => ({ ...(await readPiece(p.file)), at: p.at ?? new Matrix4() })),
    )
    const k = simplify(concat(parts.map((p) => ({ g: p.kit, m: p.at }))), spec.tris, spec.err)
    const gl = concat(parts.map((p) => ({ g: p.glass, m: p.at })))
    const scene = doc.createScene(spec.scene)
    const top = doc.createNode('RootNode')
    scene.addChild(top)
    top.addChild(addGeo(doc, `${spec.scene}_kit`, k, kit))
    if (gl.idx.length > 0) {
      top.addChild(addGeo(doc, `${spec.scene}_glass`, gl, glass))
    }
    console.log(
      `${spec.scene}: ${k.idx.length / 3} tris${gl.idx.length ? ` + ${gl.idx.length / 3} glass` : ''}`,
    )
  }
  textureRevolver(doc, kit)
  await doc.transform(
    prune(),
    reorder({ encoder: MeshoptEncoder }),
    // normals and colours only: positions and UVs stay float so builders can transform and
    // merge props freely (tiled trim UVs run past 0..1)
    quantize({ pattern: /^(NORMAL|COLOR)/u, quantizeNormal: 10, quantizeColor: 8 }),
  )
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER })
  await io.write(`${OUT}/models/props.glb`, doc)
}

await main()
