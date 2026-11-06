#!/usr/bin/env bun
// biome-ignore-all lint/style/noExcessiveLinesPerFile: one offline build script (sources → rebind → simplify → atlas → GLBs); its stages share the recipe and geometry types
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: per-vertex/per-texel loops over typed arrays, kept flat for speed and readability
/**
 * Build the out west character set from Quaternius's CC0 "Universal Base Characters",
 * "Modular Character Outfits – Fantasy" and "Universal Animation Library" (standard, free
 * editions; see CREDITS.md). No Blender: everything is gltf-transform, meshoptimizer and sharp.
 *
 *   bun tools/build-characters.ts <src_dir> [out_root]
 *
 * `<src_dir>` holds the unzipped packs flattened into `base/`, `outfits/`, `hair/`, `ual/` and
 * `swatch/` (Poly Haven fabric sets fetched with tools/polyhaven.ts: brown_leather, caban,
 * scuba_suede, rough_linen, hessian_230 as `<id>_{diff,nor,arm}.webp`). `out_root` defaults to
 * `public/experiments/out-west/3d`.
 *
 * For every base body (the BodyKeys in data/outlaws.ts, plus `player`):
 *  1. Pick the outfit parts (mix-and-match: the parts share one skeleton), the head of the
 *     matching base body (the triangles skinned to Head/neck), eyes, brows, a hairstyle and an
 *     optional beard.
 *  2. Rebind every part to ONE skeleton (the outfit's), so the GLB has one skin. Joints are
 *     renamed to the game's rig names (Hips, Torso, UpperArmR, WristR...) so fit.ts, outfit.ts
 *     and the duel code keep working.
 *  3. Simplify each part with meshoptimizer to the LOD0 budget (~16–19k tris a character).
 *  4. Remap UVs into one shared atlas (scene/atlas.ts) and write geometry-only GLBs
 *     (meshopt-compressed). Each primitive's material is named after the garment (Shirt,
 *     Pants, Boots, Skin, Hair...), which is the key outlaw tints use; its extras carry the
 *     luminance of the garment's main fabric (`lum`) for the recolour and its default tint.
 *
 * The atlas: albedo 2048×3072 (alpha = "main fabric" recolour mask, found per garment by
 * k-means over the texels its UV triangles cover), normal (OpenGL) and ARM at 1024×1536.
 *
 * The player GLB also carries the animation clips, renamed to the game's clip names, with
 * translation tracks dropped except the hips (scaled to this skeleton), so they retarget onto
 * every base unchanged.
 */
import { mkdir, stat } from 'node:fs/promises'
import {
  type Accessor,
  Document,
  type Node as GNode,
  NodeIO,
  type Primitive,
  type Skin,
} from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { quantize, reorder } from '@gltf-transform/functions'
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import sharp, { type Sharp } from 'sharp'
import { Matrix3, Matrix4, Vector3 } from 'three'
import {
  ATLAS_H,
  ATLAS_W,
  INSET,
  REGION,
  type Rect,
  SWATCH,
  type Swatch,
} from '../src/experiments/out-west/scene/atlas.ts'
import { rigName } from './build-characters-rig.ts'

const [SRC = '', OUT = 'public/experiments/out-west/3d'] = process.argv.slice(2)
if (!SRC) {
  throw new Error('usage: bun tools/build-characters.ts <src_dir> [out_root]')
}

await MeshoptSimplifier.ready
await MeshoptEncoder.ready
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder })

// ---------------------------------------------------------------- sources

type Tex =
  | 'ranger'
  | 'peasant'
  | 'skinM'
  | 'skinF'
  | 'handsM'
  | 'handsF'
  | 'hair1'
  | 'hair2'
  | 'eyes'

interface Part {
  /** Garment key (material name in the GLB, the outlaw tint key). */
  name: string
  file: string
  /** Primitive filter: mesh (node) name and material name. */
  mesh: RegExp
  mat?: RegExp
  tex: Tex
  /** Target triangles after simplification (0 = keep). */
  tris: number
  /** Keep only the head (triangles skinned to Head/neck). */
  head?: boolean
  /** Default tint (hex) when the outlaw sets none (e.g. the ranger's green, made western). */
  tint?: number
  /** Optional part: the actor drops it unless asked (beards). */
  optional?: boolean
}

interface Recipe {
  sex: 'M' | 'F'
  parts: Part[]
}

/** Default hair colour (the source hair textures are near-white, made to be tinted). */
const HAIR = 0x4a_34_22

const MO = (n: string) => `outfits/Male_${n}.gltf`
const FO = (n: string) => `outfits/Female_${n}.gltf`
const OUTFIT_MAT = /MI_(?:Ranger|Peasant)/u
const SKIN_MAT = /MI_Regular/u
/** Every mesh in the file (the part is picked out by material instead). */
const ANY_MESH = /./u
const SUPERHERO_MAT = /MI_Superhero/u
const EYES_MAT = /MI_Eyes/u
const HAIR_MAT = /MI_Hair/u
const BRACER_MESH = /_Arms_Bracer$/u
const PAULDRON_MESH = /_Acc_Pauldron/u
const RANGER_LEGS_MESH = /_Ranger_Legs$/u
const RANGER_FEET_MESH = /_Ranger_Feet/u
const PEASANT_BODY_MESH = /_Peasant_Body$/u
const PEASANT_ARMS_MESH = /_Peasant_Arms$/u
const PEASANT_LEGS_MESH = /_Peasant_Legs$/u
const PEASANT_FEET_MESH = /_Peasant_Feet$/u
/** Ranger-set mesh names per sex. */
const RANGER_MESH = {
  M: { body: /^Male_Ranger_Body$/u, belt: /^Male_Ranger_Body_Belt/u, arms: /^Male_Ranger_Arms$/u },
  F: {
    body: /^Female_Ranger_Body$/u,
    belt: /^Female_Ranger_Body_Belt/u,
    arms: /^Female_Ranger_Arms$/u,
  },
} as const

function head(sex: 'M' | 'F'): Part[] {
  const f = `base/Superhero_${sex === 'M' ? 'Male' : 'Female'}_FullBody.gltf`
  return [
    {
      name: 'Skin',
      file: f,
      mesh: ANY_MESH,
      mat: SUPERHERO_MAT,
      tex: sex === 'M' ? 'skinM' : 'skinF',
      tris: 3600,
      head: true,
    },
    { name: 'Eye', file: f, mesh: ANY_MESH, mat: EYES_MAT, tex: 'eyes', tris: 400 },
    {
      name: 'Brows',
      file: f,
      mesh: ANY_MESH,
      mat: HAIR_MAT,
      tex: sex === 'M' ? 'hair1' : 'hair2',
      tris: 500,
      tint: HAIR,
    },
  ]
}

const hair = (style: string, tex: Tex, tris: number): Part => ({
  name: 'Hair',
  file: `hair/Hair_${style}.gltf`,
  mesh: ANY_MESH,
  tex,
  tris,
  tint: HAIR,
})
const beard: Part = {
  name: 'Beard',
  file: 'hair/Hair_Beard.gltf',
  mesh: ANY_MESH,
  tex: 'hair1',
  tris: 700,
  optional: true,
  tint: HAIR,
}

/** Western defaults for the ranger set (its source fabric is forest green). */
const RANGER_SHIRT = 0x7a_62_44
const RANGER_PANTS = 0x4a_40_34

function ranger(sex: 'M' | 'F', o: { bracer?: boolean; pauldron?: boolean } = {}): Part[] {
  const f = sex === 'M' ? MO('Ranger') : FO('Ranger')
  const S = RANGER_MESH[sex]
  const parts: Part[] = [
    {
      name: 'Shirt',
      file: f,
      mesh: S.body,
      tex: 'ranger',
      tris: 2200,
      tint: RANGER_SHIRT,
    },
    {
      name: 'Belt',
      file: f,
      mesh: S.belt,
      tex: 'ranger',
      tris: 450,
    },
    {
      name: 'Sleeves',
      file: f,
      mesh: S.arms,
      mat: OUTFIT_MAT,
      tex: 'ranger',
      tris: 1900,
      tint: RANGER_SHIRT,
    },
    {
      name: 'Skin',
      file: f,
      mesh: S.arms,
      mat: SKIN_MAT,
      tex: sex === 'M' ? 'handsM' : 'handsF',
      tris: 1300,
    },
  ]
  if (o.bracer ?? true) {
    parts.push({
      name: 'Bracer',
      file: f,
      mesh: BRACER_MESH,
      tex: 'ranger',
      tris: 1200,
    })
  }
  if (o.pauldron) {
    parts.push({ name: 'Pauldron', file: f, mesh: PAULDRON_MESH, tex: 'ranger', tris: 800 })
  }
  return parts
}

function rangerLegs(sex: 'M' | 'F'): Part[] {
  const f = sex === 'M' ? MO('Ranger') : FO('Ranger')
  return [
    { name: 'Pants', file: f, mesh: RANGER_LEGS_MESH, tex: 'ranger', tris: 0, tint: RANGER_PANTS },
    { name: 'Boots', file: f, mesh: RANGER_FEET_MESH, tex: 'ranger', tris: 2600 },
  ]
}

function peasant(sex: 'M' | 'F'): Part[] {
  const f = sex === 'M' ? MO('Peasant') : FO('Peasant')
  const parts: Part[] = [
    { name: 'Shirt', file: f, mesh: PEASANT_BODY_MESH, tex: 'peasant', tris: 2600 },
    {
      name: 'Sleeves',
      file: f,
      mesh: PEASANT_ARMS_MESH,
      mat: OUTFIT_MAT,
      tex: 'peasant',
      tris: sex === 'M' ? 0 : 2600,
    },
  ]
  if (sex === 'M') {
    parts.push({
      name: 'Skin',
      file: f,
      mesh: PEASANT_ARMS_MESH,
      mat: SKIN_MAT,
      tex: 'handsM',
      tris: 1800,
    })
  }
  return parts
}

function peasantLegs(sex: 'M' | 'F'): Part[] {
  const f = sex === 'M' ? MO('Peasant') : FO('Peasant')
  return [
    { name: 'Pants', file: f, mesh: PEASANT_LEGS_MESH, tex: 'peasant', tris: 0 },
    { name: 'Boots', file: f, mesh: PEASANT_FEET_MESH, tex: 'peasant', tris: 1800 },
  ]
}

const rangerBoots = (sex: 'M' | 'F'): Part[] => rangerLegs(sex).filter((p) => p.name === 'Boots')
const peasantPants = (sex: 'M' | 'F'): Part[] => peasantLegs(sex).filter((p) => p.name === 'Pants')

export const RECIPES: Record<string, Recipe> = {
  player: {
    sex: 'M',
    parts: [
      ...head('M'),
      hair('SimpleParted', 'hair1', 1100),
      beard,
      ...peasant('M'),
      ...peasantPants('M'),
      ...rangerBoots('M'),
    ],
  },
  casual: {
    sex: 'M',
    parts: [
      ...head('M'),
      hair('SimpleParted', 'hair1', 1100),
      beard,
      ...peasant('M'),
      ...peasantLegs('M'),
    ],
  },
  worker: {
    sex: 'M',
    parts: [...head('M'), hair('Buzzed', 'hair1', 700), beard, ...peasant('M'), ...rangerLegs('M')],
  },
  suit: {
    sex: 'M',
    parts: [
      ...head('M'),
      hair('SimpleParted', 'hair1', 1100),
      beard,
      ...ranger('M', { bracer: false }),
      ...peasantLegs('M'),
    ],
  },
  rugged: {
    sex: 'M',
    parts: [...head('M'), hair('Buzzed', 'hair1', 700), beard, ...ranger('M'), ...rangerLegs('M')],
  },
  king: {
    sex: 'M',
    parts: [
      ...head('M'),
      hair('Long', 'hair2', 1800),
      beard,
      ...ranger('M', { pauldron: true }),
      ...rangerLegs('M'),
    ],
  },
  punk: {
    sex: 'M',
    parts: [
      ...head('M'),
      hair('Buzzed', 'hair1', 700),
      beard,
      ...ranger('M'),
      ...peasantPants('M'),
      ...rangerBoots('M'),
    ],
  },
  woman: {
    sex: 'F',
    parts: [...head('F'), hair('Long', 'hair2', 1800), ...peasant('F'), ...peasantLegs('F')],
  },
}

const TEX_FILES: Record<Tex, { diff: string; nor: string; arm?: string; rough?: string }> = {
  ranger: {
    diff: 'outfits/T_Ranger_BaseColor.png',
    nor: 'outfits/T_Ranger_Normal.png',
    arm: 'outfits/T_Ranger_ORM.png',
  },
  peasant: {
    diff: 'outfits/T_Peasant_BaseColor.png',
    nor: 'outfits/T_Peasant_Normal.png',
    arm: 'outfits/T_Peasant_ORM.png',
  },
  skinM: {
    diff: 'base/T_Superhero_Male_Dark.png',
    nor: 'base/T_Superhero_Male_Normal.png',
    rough: 'base/T_Superhero_Male_Roughness.png',
  },
  skinF: {
    diff: 'base/T_Superhero_Female_Dark_BaseColor.png',
    nor: 'base/T_Superhero_Female_Normal.png',
    rough: 'base/T_Superhero_Female_Roughness.png',
  },
  handsM: {
    diff: 'outfits/T_Regular_Male_Dark_BaseColor.png',
    nor: 'outfits/T_Regular_Male_Normal.png',
    rough: 'outfits/T_Regular_Male_Roughness.png',
  },
  handsF: {
    diff: 'outfits/T_Regular_Female_Dark_BaseColor.png',
    nor: 'outfits/T_Regular_Female_Normal.png',
    rough: 'outfits/T_Regular_Female_Roughness.png',
  },
  hair1: { diff: 'hair/T_Hair_1_BaseColor.png', nor: 'hair/T_Hair_1_Normal.png' },
  hair2: { diff: 'hair/T_Hair_2_BaseColor.png', nor: 'hair/T_Hair_2_Normal.png' },
  eyes: { diff: 'base/T_Eye_Brown.png', nor: 'base/T_Eye_Normal.png' },
}

/** Constant roughness (0..1) for sources without a roughness map. */
const FLAT_ROUGH: Partial<Record<Tex, number>> = { hair1: 0.55, hair2: 0.55, eyes: 0.12 }

const SWATCH_SRC: Partial<Record<Swatch, string>> = {
  leather: 'brown_leather',
  wool: 'caban',
  felt: 'scuba_suede',
  linen: 'rough_linen',
  hessian: 'hessian_230',
}

// ---------------------------------------------------------------- geometry

interface Geo {
  name: string
  tex: Tex
  pos: Float32Array
  nrm: Float32Array
  uv: Float32Array
  /** Four joint indices (into the master skeleton) per vertex. */
  joints: Uint16Array
  weights: Float32Array
  idx: Uint32Array
  part: Part
}

const docs = new Map<string, Document>()
async function doc(file: string): Promise<Document> {
  const have = docs.get(file)
  if (have) {
    return have
  }
  const d = await io.read(`${SRC}/${file}`)
  docs.set(file, d)
  return d
}

const toM4 = (a: ArrayLike<number>) => new Matrix4().fromArray(Array.from(a))

interface Master {
  names: string[]
  /** Leaf joint → its parent (weights move up). */
  parent: Map<string, string>
  world: Map<string, Matrix4>
  doc: Document
}

async function master(sex: 'M' | 'F'): Promise<Master> {
  const d = await doc(sex === 'M' ? MO('Ranger') : FO('Ranger'))
  const skin = d.getRoot().listSkins()[0]
  if (!skin) {
    throw new Error('no skin')
  }
  const names = skin.listJoints().map((j) => j.getName())
  const world = new Map(skin.listJoints().map((j) => [j.getName(), toM4(j.getWorldMatrix())]))
  const parent = new Map<string, string>()
  for (const j of skin.listJoints()) {
    const up = j.getParentNode()
    if (j.getName().includes('leaf') && up) {
      parent.set(j.getName(), up.getName())
    }
  }
  return { names, parent, world, doc: d }
}

function skinOf(d: Document, p: Primitive): { skin: Skin; node: GNode } | null {
  for (const n of d.getRoot().listNodes()) {
    const mesh = n.getMesh()
    const skin = n.getSkin()
    if (mesh && skin && mesh.listPrimitives().includes(p)) {
      return { skin, node: n }
    }
  }
  return null
}

const arr = (a: Accessor | null): Float32Array =>
  a ? Float32Array.from(a.getArray() ?? []) : new Float32Array()

/** One part's primitives, rebound to the master skeleton and merged. */
async function extract(part: Part, m: Master): Promise<Geo | null> {
  const d = await doc(part.file)
  const pos: number[] = []
  const nrm: number[] = []
  const uv: number[] = []
  const joints: number[] = []
  const weights: number[] = []
  const idx: number[] = []
  const acc = new Matrix4()
  const tmp = new Matrix4()
  const v = new Vector3()
  const n3 = new Matrix3()
  const masterIndex = new Map(m.names.map((nm, i) => [nm, i]))
  for (const mesh of d.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      const s = skinOf(d, p)
      const nodeName = s?.node.getName() ?? mesh.getName()
      const matName = p.getMaterial()?.getName() ?? ''
      if (!(s && part.mesh.test(nodeName)) || (part.mat && !part.mat.test(matName))) {
        continue
      }
      const jn = s.skin.listJoints().map((j) => j.getName())
      const ibmA = s.skin.getInverseBindMatrices()?.getArray()
      const ibm = jn.map((_, i) => toM4(ibmA ? ibmA.subarray(i * 16, i * 16 + 16) : []))
      const P = arr(p.getAttribute('POSITION'))
      const N = arr(p.getAttribute('NORMAL'))
      const T = arr(p.getAttribute('TEXCOORD_0'))
      const J = p.getAttribute('JOINTS_0')
      const W = p.getAttribute('WEIGHTS_0')
      const I = p.getIndices()?.getArray()
      if (!(J && W && I)) {
        continue
      }
      const count = P.length / 3
      const base = pos.length / 3
      const keep: boolean[] = []
      const jv: number[] = []
      const wv: number[] = []
      for (let k = 0; k < count; k++) {
        const jj = J.getElement(k, [])
        const ww = W.getElement(k, [])
        acc.elements.fill(0)
        let headW = 0
        for (let c = 0; c < 4; c++) {
          const w = ww[c] ?? 0
          // leaf joints (finger and toe tips) ride their parents: fewer bones to upload
          const own = jn[jj[c] ?? 0] ?? ''
          const name = m.parent.get(own) ?? own
          const at = name === own ? (jj[c] ?? 0) : jn.indexOf(name)
          if (w <= 0) {
            jv.push(0)
            wv.push(0)
            continue
          }
          if (name === 'Head' || name === 'neck_01') {
            headW += w
          }
          tmp.multiplyMatrices(m.world.get(name) ?? new Matrix4(), ibm[at] ?? new Matrix4())
          for (let q = 0; q < 16; q++) {
            acc.elements[q] = (acc.elements[q] ?? 0) + (tmp.elements[q] ?? 0) * w
          }
          jv.push(masterIndex.get(name) ?? 0)
          wv.push(w)
        }
        keep.push(!part.head || headW >= 0.5)
        v.set(P[k * 3] ?? 0, P[k * 3 + 1] ?? 0, P[k * 3 + 2] ?? 0).applyMatrix4(acc)
        pos.push(v.x, v.y, v.z)
        n3.getNormalMatrix(acc)
        v.set(N[k * 3] ?? 0, N[k * 3 + 1] ?? 1, N[k * 3 + 2] ?? 0)
          .applyMatrix3(n3)
          .normalize()
        nrm.push(v.x, v.y, v.z)
        uv.push(
          Math.min(1, Math.max(0, T[k * 2] ?? 0)),
          Math.min(1, Math.max(0, T[k * 2 + 1] ?? 0)),
        )
      }
      joints.push(...jv)
      weights.push(...wv)
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] ?? 0
        const b = I[t + 1] ?? 0
        const c = I[t + 2] ?? 0
        if (keep[a] && keep[b] && keep[c]) {
          idx.push(base + a, base + b, base + c)
        }
      }
    }
  }
  if (idx.length === 0) {
    console.warn(`  ! ${part.name} (${part.file} ${part.mesh}) matched nothing`)
    return null
  }
  return compact({
    name: part.name,
    tex: part.tex,
    pos: Float32Array.from(pos),
    nrm: Float32Array.from(nrm),
    uv: Float32Array.from(uv),
    joints: Uint16Array.from(joints),
    weights: Float32Array.from(weights),
    idx: Uint32Array.from(idx),
    part,
  })
}

/** Drop vertices no triangle uses. */
function compact(g: Geo): Geo {
  const n = g.pos.length / 3
  const remap = new Int32Array(n).fill(-1)
  let next = 0
  for (const i of g.idx) {
    if (remap[i] === -1) {
      remap[i] = next++
    }
  }
  const pick = <T extends Float32Array | Uint16Array>(
    src: T,
    k: number,
    mk: (len: number) => T,
  ) => {
    const out = mk(next * k)
    for (let i = 0; i < n; i++) {
      const r = remap[i] ?? -1
      if (r >= 0) {
        out.set(src.subarray(i * k, i * k + k), r * k)
      }
    }
    return out
  }
  const f32 = (len: number) => new Float32Array(len)
  return {
    ...g,
    pos: pick(g.pos, 3, f32),
    nrm: pick(g.nrm, 3, f32),
    uv: pick(g.uv, 2, f32),
    joints: pick(g.joints, 4, (len) => new Uint16Array(len)),
    weights: pick(g.weights, 4, f32),
    idx: g.idx.map((i) => remap[i] ?? 0),
  }
}

function simplify(g: Geo): Geo {
  const tris = g.idx.length / 3
  if (!g.part.tris || tris <= g.part.tris) {
    return g
  }
  const n = g.pos.length / 3
  const attrs = new Float32Array(n * 5)
  for (let i = 0; i < n; i++) {
    attrs.set(g.nrm.subarray(i * 3, i * 3 + 3), i * 5)
    attrs.set(g.uv.subarray(i * 2, i * 2 + 2), i * 5 + 3)
  }
  const [index] = MeshoptSimplifier.simplifyWithAttributes(
    g.idx,
    g.pos,
    3,
    attrs,
    5,
    [0.25, 0.25, 0.25, 2, 2],
    null,
    g.part.tris * 3,
    0.02,
    [],
  )
  return compact({ ...g, idx: index })
}

// ---------------------------------------------------------------- atlas

const inner = (r: Rect, k: number) => ({
  w: Math.round(r.w * k) - 2 * Math.round(INSET * k),
  h: Math.round(r.h * k) - 2 * Math.round(INSET * k),
})

/** Rasterise a part's UV triangles into a region-sized label map. */
function rasterise(label: Int16Array, size: { w: number; h: number }, g: Geo, id: number): void {
  const { w, h } = size
  for (let t = 0; t < g.idx.length; t += 3) {
    const ps = [0, 1, 2].map((c) => {
      const i = g.idx[t + c] ?? 0
      return [(g.uv[i * 2] ?? 0) * w, (g.uv[i * 2 + 1] ?? 0) * h] as const
    })
    const [a, b, cc] = ps as [
      readonly [number, number],
      readonly [number, number],
      readonly [number, number],
    ]
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], cc[0])) - 1)
    const x1 = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0], cc[0])) + 1)
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], cc[1])) - 1)
    const y1 = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1], cc[1])) + 1)
    const area = (b[0] - a[0]) * (cc[1] - a[1]) - (b[1] - a[1]) * (cc[0] - a[0])
    if (Math.abs(area) < 1e-9) {
      continue
    }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5
        const py = y + 0.5
        const w0 = ((b[0] - px) * (cc[1] - py) - (b[1] - py) * (cc[0] - px)) / area
        const w1 = ((cc[0] - px) * (a[1] - py) - (cc[1] - py) * (a[0] - px)) / area
        const w2 = 1 - w0 - w1
        // a little slack so edge texels count
        if (w0 >= -0.02 && w1 >= -0.02 && w2 >= -0.02) {
          label[y * w + x] = id
        }
      }
    }
  }
}

const lin = (c: number) => {
  const s = c / 255
  return s <= 0.040_45 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/**
 * The main fabric of one garment: k-means (k = 3) over its texels; the biggest cluster is the
 * fabric. Returns the soft mask contribution per texel and the fabric's mean linear luminance.
 */
function fabricMask(
  rgb: Buffer,
  label: Int16Array,
  id: number,
  mask: Uint8Array,
): { lum: number; share: number } {
  const px: number[] = []
  for (let i = 0; i < label.length; i++) {
    if (label[i] === id) {
      px.push(i)
    }
  }
  if (px.length === 0) {
    return { lum: 0, share: 0 }
  }
  const col = (i: number): [number, number, number] => [
    rgb[i * 3] ?? 0,
    rgb[i * 3 + 1] ?? 0,
    rgb[i * 3 + 2] ?? 0,
  ]
  const step = Math.max(1, Math.floor(px.length / 20_000))
  const sample = px.filter((_, k) => k % step === 0).map(col)
  const sorted = [...sample].sort((p, q) => p[0] + p[1] + p[2] - (q[0] + q[1] + q[2]))
  let centers = [0.2, 0.5, 0.8].map(
    (f) => sorted[Math.floor(f * (sorted.length - 1))] ?? [128, 128, 128],
  ) as [number, number, number][]
  const d2 = (p: readonly number[], q: readonly number[]) =>
    ((p[0] ?? 0) - (q[0] ?? 0)) ** 2 +
    ((p[1] ?? 0) - (q[1] ?? 0)) ** 2 +
    ((p[2] ?? 0) - (q[2] ?? 0)) ** 2
  const nearest = (p: readonly number[]) => {
    let best = 0
    for (let c = 1; c < centers.length; c++) {
      if (d2(p, centers[c] ?? []) < d2(p, centers[best] ?? [])) {
        best = c
      }
    }
    return best
  }
  const counts = [0, 0, 0]
  for (let it = 0; it < 10; it++) {
    const sum = centers.map(() => [0, 0, 0, 0])
    for (const p of sample) {
      const s = sum[nearest(p)] ?? [0, 0, 0, 0]
      s[0] = (s[0] ?? 0) + p[0]
      s[1] = (s[1] ?? 0) + p[1]
      s[2] = (s[2] ?? 0) + p[2]
      s[3] = (s[3] ?? 0) + 1
    }
    centers = centers.map((c, k) => {
      const s = sum[k] ?? [0, 0, 0, 0]
      const n = s[3] ?? 0
      counts[k] = n
      return n > 0 ? [(s[0] ?? 0) / n, (s[1] ?? 0) / n, (s[2] ?? 0) / n] : c
    }) as [number, number, number][]
  }
  const dom = counts.indexOf(Math.max(...counts))
  const dc = centers[dom] ?? [128, 128, 128]
  let lumSum = 0
  let lumN = 0
  for (const i of px) {
    const p = col(i)
    const dd = Math.sqrt(d2(p, dc))
    let other = Number.POSITIVE_INFINITY
    centers.forEach((c, k) => {
      if (k !== dom) {
        other = Math.min(other, Math.sqrt(d2(p, c)))
      }
    })
    const ratio = dd / (other + 1e-3)
    const m = Math.min(1, Math.max(0, (1.05 - ratio) / 0.45))
    mask[i] = Math.max(mask[i] ?? 0, Math.round(m * 255))
    if (m > 0.5) {
      lumSum += 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2])
      lumN++
    }
  }
  return { lum: lumN > 0 ? lumSum / lumN : 0.2, share: (counts[dom] ?? 0) / sample.length }
}

/**
 * The ranger set's fabric is forest green and its leather is brown, so its recolour mask is
 * simply "how green": exact, where clustering would mix in the straps. Null when a garment has
 * almost no green (its leather then goes through the clustering instead).
 */
function greenMask(
  rgb: Buffer,
  label: Int16Array,
  id: number,
  mask: Uint8Array,
): { lum: number; share: number } | null {
  let n = 0
  let green = 0
  let lumSum = 0
  const m = new Float32Array(label.length)
  for (let i = 0; i < label.length; i++) {
    if (label[i] !== id) {
      continue
    }
    n++
    const r = rgb[i * 3] ?? 0
    const g = rgb[i * 3 + 1] ?? 0
    const b = rgb[i * 3 + 2] ?? 0
    // green leads both other channels; soft over ~25 levels
    const lead = g - Math.max(r, b)
    const k = Math.min(1, Math.max(0, (lead - 2) / 10))
    m[i] = k
    if (k > 0.5) {
      green++
      lumSum += 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }
  }
  if (n === 0 || green / n < 0.15) {
    return null
  }
  for (let i = 0; i < label.length; i++) {
    if (label[i] === id) {
      mask[i] = Math.max(mask[i] ?? 0, Math.round((m[i] ?? 0) * 255))
    }
  }
  return { lum: lumSum / green, share: green / n }
}

/** Grow a mask into unlabelled texels so bilinear/mip taps at island edges stay masked. */
function dilate(
  mask: Uint8Array,
  o: { label: Int16Array; w: number; h: number; passes: number },
): void {
  const { label, w, h, passes } = o
  for (let p = 0; p < passes; p++) {
    const src = Uint8Array.from(mask)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if ((label[i] ?? -1) >= 0) {
          continue
        }
        let m = src[i] ?? 0
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const xx = x + dx
          const yy = y + dy
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) {
            m = Math.max(m, src[yy * w + xx] ?? 0)
          }
        }
        mask[i] = m
      }
    }
  }
}

interface Layer {
  input: Buffer
  left: number
  top: number
}

/** Resize a source into a rect's inner area, then pad the gutter with copies of its edges. */
async function placed(
  src: Sharp,
  r: Rect,
  k: number,
  raw?: { rgb: Buffer; w: number; h: number },
): Promise<Layer> {
  const { w, h } = inner(r, k)
  const pad = Math.round(INSET * k)
  const from = raw ? sharp(raw.rgb, { raw: { width: raw.w, height: raw.h, channels: 3 } }) : src
  const body = from.resize(w, h, { fit: 'fill' }).removeAlpha()
  const input = await sharp(await body.png().toBuffer())
    .extend({ top: pad, bottom: pad, left: pad, right: pad, extendWith: 'copy' })
    .png()
    .toBuffer()
  return { input, left: Math.round(r.x * k), top: Math.round(r.y * k) }
}

const solid = (rgb: [number, number, number]) =>
  sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })

async function armOf(t: Tex): Promise<Sharp> {
  const f = TEX_FILES[t]
  if (f.arm) {
    return sharp(`${SRC}/${f.arm}`)
  }
  if (f.rough) {
    const { data, info } = await sharp(`${SRC}/${f.rough}`)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const out = Buffer.alloc(info.width * info.height * 3)
    for (let i = 0; i < info.width * info.height; i++) {
      out[i * 3] = 255
      out[i * 3 + 1] = data[i * info.channels] ?? 200
      out[i * 3 + 2] = 0
    }
    return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } })
  }
  return solid([255, Math.round((FLAT_ROUGH[t] ?? 0.6) * 255), 0])
}

/** Fabric luminance (mean, linear) and default tint per garment geometry, keyed by `Geo`. */
const fabricInfo = new Map<Geo, { lum: number }>()

async function buildAtlas(all: Geo[], out: string): Promise<void> {
  const diff: Layer[] = []
  const nor: Layer[] = []
  const arm: Layer[] = []
  for (const t of Object.keys(TEX_FILES) as Tex[]) {
    const region = REGION[t]
    const f = TEX_FILES[t]
    const size = inner(region, 1)
    const { data: rgb } = await sharp(`${SRC}/${f.diff}`)
      .resize(size.w, size.h, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const mask = new Uint8Array(size.w * size.h)
    const geos = all.filter((g) => g.tex === t)
    const garments = t === 'ranger' || t === 'peasant'
    if (garments) {
      // one label per garment name (a shirt shared by several bases is one garment)
      const names = [...new Set(geos.map((g) => g.name))]
      for (const [id, name] of names.entries()) {
        const label = new Int16Array(size.w * size.h).fill(-1)
        for (const g of geos.filter((x) => x.name === name)) {
          rasterise(label, size, g, id)
        }
        const info =
          t === 'ranger'
            ? (greenMask(rgb, label, id, mask) ?? fabricMask(rgb, label, id, mask))
            : fabricMask(rgb, label, id, mask)
        console.log(
          `  ${t}/${name}: fabric lum ${info.lum.toFixed(3)}, share ${info.share.toFixed(2)}`,
        )
        for (const g of geos.filter((x) => x.name === name)) {
          fabricInfo.set(g, { lum: info.lum })
        }
      }
      const any = new Int16Array(size.w * size.h).fill(-1)
      for (const g of geos) {
        rasterise(any, size, g, 0)
      }
      dilate(mask, { label: any, w: size.w, h: size.h, passes: 3 })
    } else {
      mask.fill(255)
    }
    // AO is baked into the albedo (stylized, and it frees ARM.r for the recolour mask)
    const { data: orm, info: oi } = await (await armOf(t))
      .resize(size.w, size.h, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const n = size.w * size.h
    const albedo = Buffer.alloc(n * 3)
    const armRaw = Buffer.alloc(n * 3)
    for (let i = 0; i < n; i++) {
      const ao = 0.35 + 0.65 * ((orm[i * oi.channels] ?? 255) / 255)
      for (let c = 0; c < 3; c++) {
        albedo[i * 3 + c] = Math.round((rgb[i * 3 + c] ?? 0) * ao)
      }
      armRaw[i * 3] = mask[i] ?? 255
      armRaw[i * 3 + 1] = orm[i * oi.channels + 1] ?? 200
      armRaw[i * 3 + 2] = orm[i * oi.channels + 2] ?? 0
    }
    diff.push(await placed(sharp(), region, 1, { rgb: albedo, w: size.w, h: size.h }))
    nor.push(await placed(sharp(`${SRC}/${f.nor}`).removeAlpha(), region, 0.5))
    arm.push(await placed(sharp(), region, 0.5, { rgb: armRaw, w: size.w, h: size.h }))
  }
  for (const s of Object.keys(SWATCH) as Swatch[]) {
    const r = SWATCH[s]
    const id = SWATCH_SRC[s]
    if (id) {
      diff.push(await placed(sharp(`${SRC}/swatch/${id}_diff.webp`), r, 1))
      nor.push(await placed(sharp(`${SRC}/swatch/${id}_nor.webp`), r, 0.5))
      const { data, info } = await sharp(`${SRC}/swatch/${id}_arm.webp`)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const a = Buffer.alloc(info.width * info.height * 3)
      for (let i = 0; i < info.width * info.height; i++) {
        a[i * 3] = 255
        a[i * 3 + 1] = data[i * info.channels + 1] ?? 200
        a[i * 3 + 2] = data[i * info.channels + 2] ?? 0
      }
      arm.push(await placed(sharp(), r, 0.5, { rgb: a, w: info.width, h: info.height }))
    } else if (s === 'metal') {
      diff.push(await placed(solid([200, 200, 205]), r, 1))
      nor.push(await placed(solid([128, 128, 255]), r, 0.5))
      arm.push(await placed(solid([255, 90, 255]), r, 0.5))
    } else {
      diff.push(await placed(solid([255, 255, 255]), r, 1))
      nor.push(await placed(solid([128, 128, 255]), r, 0.5))
      arm.push(await placed(solid([255, 255, 0]), r, 0.5))
    }
  }
  const canvas = (k: number, bg: { r: number; g: number; b: number; alpha: number }) =>
    sharp({
      create: { width: ATLAS_W * k, height: ATLAS_H * k, channels: 4, background: bg },
    })
  await canvas(1, { r: 128, g: 110, b: 90, alpha: 1 })
    .composite(diff)
    .removeAlpha()
    .webp({ quality: 90 })
    .toFile(`${out}/tex/char_diff.webp`)
  await canvas(0.5, { r: 128, g: 128, b: 255, alpha: 1 })
    .composite(nor)
    .removeAlpha()
    .webp({ quality: 90 })
    .toFile(`${out}/tex/char_nor.webp`)
  await canvas(0.5, { r: 255, g: 200, b: 0, alpha: 1 })
    .composite(arm)
    .removeAlpha()
    .webp({ quality: 88 })
    .toFile(`${out}/tex/char_arm.webp`)
}

// ---------------------------------------------------------------- output

function skeleton(out: Document, m: Master): { joints: GNode[]; top: GNode } {
  const src = m.doc.getRoot().listSkins()[0]
  if (!src) {
    throw new Error('no skin')
  }
  const map = new Map<GNode, GNode>()
  const joints = src.listJoints().map((j) => {
    const n = out
      .createNode(rigName(j.getName()))
      .setTranslation(j.getTranslation())
      .setRotation(j.getRotation())
      .setScale(j.getScale())
    map.set(j, n)
    return n
  })
  const top = out.createNode('Armature')
  for (const j of src.listJoints()) {
    const parent = j.getParentNode()
    const n = map.get(j)
    if (!n) {
      continue
    }
    const pn = parent ? map.get(parent) : undefined
    ;(pn ?? top).addChild(n)
  }
  return { joints, top }
}

function writeMesh(out: Document, geos: Geo[], m: Master, joints: GNode[]): GNode {
  const buf = out.getRoot().listBuffers()[0] ?? out.createBuffer()
  const mesh = out.createMesh('Character')
  for (const g of geos) {
    const region = REGION[g.tex]
    const uv = new Float32Array(g.uv.length)
    for (let i = 0; i < g.uv.length / 2; i++) {
      uv[i * 2] = (region.x + INSET + (g.uv[i * 2] ?? 0) * (region.w - 2 * INSET)) / ATLAS_W
      uv[i * 2 + 1] = (region.y + INSET + (g.uv[i * 2 + 1] ?? 0) * (region.h - 2 * INSET)) / ATLAS_H
    }
    const acc = (
      type: 'VEC2' | 'VEC3' | 'VEC4' | 'SCALAR',
      a: Float32Array | Uint16Array | Uint32Array,
    ) => out.createAccessor().setType(type).setArray(a.slice()).setBuffer(buf)
    const mat = out.createMaterial(g.name)
    const info = fabricInfo.get(g)
    mat.setExtras({
      lum: info?.lum ?? 0,
      ...(g.part.tint === undefined ? {} : { tint: g.part.tint }),
      ...(g.part.optional ? { optional: true } : {}),
    })
    const prim = out
      .createPrimitive()
      .setAttribute('POSITION', acc('VEC3', g.pos))
      .setAttribute('NORMAL', acc('VEC3', g.nrm))
      .setAttribute('TEXCOORD_0', acc('VEC2', uv))
      .setAttribute('JOINTS_0', acc('VEC4', g.joints))
      .setAttribute('WEIGHTS_0', acc('VEC4', g.weights))
      .setIndices(acc('SCALAR', g.pos.length / 3 > 65_535 ? g.idx : Uint16Array.from(g.idx)))
      .setMaterial(mat)
    mesh.addPrimitive(prim)
  }
  const skin = out.createSkin('Rig')
  const ibm = new Float32Array(joints.length * 16)
  m.names.forEach((n, i) => {
    ibm.set((m.world.get(n) ?? new Matrix4()).clone().invert().toArray(), i * 16)
  })
  skin.setInverseBindMatrices(out.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buf))
  for (const j of joints) {
    skin.addJoint(j)
  }
  return out.createNode('Character').setMesh(mesh).setSkin(skin)
}

/** Game clip name ← Universal Animation Library clip. */
const CLIPS: Record<string, string> = {
  Idle: 'Idle_Loop',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  Idle_Neutral: 'Idle_Talking_Loop',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  Idle_Gun: 'Pistol_Idle_Loop',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  Idle_Gun_Pointing: 'Pistol_Aim_Neutral',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  Idle_Gun_Shoot: 'Pistol_Shoot',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  Gun_Shoot: 'Pistol_Shoot',
  Walk: 'Walk_Loop',
  Run: 'Jog_Fwd_Loop',
  Death: 'Death01',
  HitRecieve: 'Hit_Chest',
  // biome-ignore lint/style/useNamingConvention: the game's clip names
  HitRecieve_2: 'Hit_Head',
  Wave: 'Interact',
}

async function addClips(out: Document, joints: GNode[], m: Master): Promise<void> {
  const ual = await doc('ual/UAL1_Standard.glb')
  const byName = new Map(joints.map((j) => [j.getName(), j]))
  const buf = out.getRoot().listBuffers()[0] ?? out.createBuffer()
  const ualPelvis = ual
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === 'pelvis')
    ?.getWorldTranslation()[1]
  const ourPelvis = m.world.get('pelvis')?.elements[13]
  const hipK = ualPelvis && ourPelvis ? ourPelvis / ualPelvis : 1
  for (const [ours, theirs] of Object.entries(CLIPS)) {
    const src = ual
      .getRoot()
      .listAnimations()
      .find((a) => a.getName() === theirs)
    if (!src) {
      console.warn(`  ! clip ${theirs} missing`)
      continue
    }
    const anim = out.createAnimation(ours)
    for (const ch of src.listChannels()) {
      const node = ch.getTargetNode()
      const path = ch.getTargetPath()
      const s = ch.getSampler()
      if (!(node && s && path)) {
        continue
      }
      const target = byName.get(rigName(node.getName()))
      const hips = node.getName() === 'pelvis'
      if (!target || path === 'scale' || (path === 'translation' && !hips)) {
        continue
      }
      const input = s.getInput()?.getArray()
      const output = s.getOutput()?.getArray()
      if (!(input && output)) {
        continue
      }
      const o = Float32Array.from(output)
      if (path === 'translation') {
        for (let i = 0; i < o.length; i++) {
          o[i] = (o[i] ?? 0) * hipK
        }
      }
      const sampler = out
        .createAnimationSampler()
        .setInput(
          out.createAccessor().setType('SCALAR').setArray(Float32Array.from(input)).setBuffer(buf),
        )
        .setOutput(
          out
            .createAccessor()
            .setType(path === 'rotation' ? 'VEC4' : 'VEC3')
            .setArray(o)
            .setBuffer(buf),
        )
        .setInterpolation(s.getInterpolation())
      anim.addSampler(sampler)
      anim.addChannel(
        out.createAnimationChannel().setTargetNode(target).setTargetPath(path).setSampler(sampler),
      )
    }
  }
}

async function main(): Promise<void> {
  await mkdir(`${OUT}/models`, { recursive: true })
  await mkdir(`${OUT}/tex`, { recursive: true })
  const built = new Map<string, Geo[]>()
  const masters = { M: await master('M'), F: await master('F') }
  for (const [key, r] of Object.entries(RECIPES)) {
    const geos: Geo[] = []
    for (const part of r.parts) {
      const g = await extract(part, masters[r.sex])
      if (g) {
        geos.push(simplify(g))
      }
    }
    built.set(key, geos)
    const tris = geos.reduce((t, g) => t + g.idx.length / 3, 0)
    console.log(
      `${key}: ${tris} tris, ${geos.map((g) => `${g.name}:${g.idx.length / 3}`).join(' ')}`,
    )
  }
  await buildAtlas([...built.values()].flat(), OUT)
  for (const [key, geos] of built) {
    const r = RECIPES[key]
    if (!r) {
      continue
    }
    const m = masters[r.sex]
    const out = new Document()
    out.createBuffer()
    const scene = out.createScene('Scene')
    const { joints, top } = skeleton(out, m)
    scene.addChild(top)
    scene.addChild(writeMesh(out, geos, m, joints))
    if (key === 'player') {
      await addClips(out, joints, m)
    }
    await out.transform(
      reorder({ encoder: MeshoptEncoder }),
      quantize({ quantizeNormal: 10, quantizeTexcoord: 14, quantizePosition: 14 }),
    )
    out
      .createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER })
    await io.write(`${OUT}/models/${key}.glb`, out)
    const { size } = await stat(`${OUT}/models/${key}.glb`)
    console.log(`  wrote models/${key}.glb ${(size / 1024).toFixed(0)} KB`)
  }
}

await main()
