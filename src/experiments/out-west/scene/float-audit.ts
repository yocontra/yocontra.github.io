// biome-ignore-all lint/style/noExcessiveLinesPerFile: one self-contained dev audit (collect, index, query, classify); nothing here ships
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: geometry queries over flat arrays
// biome-ignore-all lint/complexity/useMaxParams: point/segment/triangle helpers take positional numbers
/**
 * Dev-only floating-object audit. `tools/float-audit.ts` imports this into the running page from
 * the dev server; the game never imports it, so it never ships.
 *
 * It walks a scene and splits every static mesh into pieces: an InstancedMesh instance (all the
 * prop's material parts together), a kit piece inside a merged mesh (`userData.pieces`, set by
 * `mergePlaced`), or a connected component of a merged GeoBuilder mesh. For each piece:
 *
 * - **support**: rays down from its lowest vertices onto everything else (a surface up to 3 cm
 *   above the foot counts: the foot is set into it). More than 3 cm of air under every foot and
 *   not touching anything = `float`.
 * - **contact**: the nearest triangle-to-triangle distance to any other piece (a piece straddling
 *   a triangle's plane inside it counts as touching). Wall-mounted and hanging pieces pass on
 *   contact; a kit facade piece more than 2 cm off every wall is `loose`.
 * - **sunk**: a resting prop or doorway whose foot is buried under a deck it should stand on.
 * - **zfight**: coplanar, overlapping, same-facing triangles from two different pieces.
 *
 * Things that hang or fly by design (lanterns, pickups, money bags) are listed with the distance
 * to their mount instead of being flagged.
 */
import {
  type BufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  Points,
  SkinnedMesh,
  Sprite,
  Vector3,
  type WebGLRenderer,
} from 'three'
import { isFlatMaterial, ROLE, type Role, roleOf, SLOT, slotOf } from './roles.ts'

export interface AuditIssue {
  kind: 'float' | 'loose' | 'sunk' | 'zfight'
  name: string
  mesh: string
  at: [number, number, number]
  size: [number, number, number]
  /** float: air under the foot (m, 1e9 over the void); sunk: depth under the deck. */
  gap: number
  /** Nearest distance to any other piece (m, 1e9 when nothing is near). */
  contact: number
  other?: string
}

export interface AuditReport {
  pieces: number
  triangles: number
  issues: AuditIssue[]
  /** Pieces that hang or fly by design, with the distance to whatever holds them. */
  allowed: { name: string; mount: number; at: [number, number, number] }[]
  ms: number
}

const FLOAT_TOL = 0.03
const WALL_TOL = 0.02
const DEEP = 0.05
const CELL = 1
const FAR = 1e9

/** Props that must stand on something (never just lean on a wall). */
const GROUNDED =
  /^(?:barrel|crate|hay|cart|cactus|rock|fence|coffin|k_bench|k_bucket|k_sack|k_chest|k_barrel_rack|k_table|k_chair|k_stool|k_crate_big|k_workbench|k_anvil|k_door|k_door_braced|k_door_plank|k_doorframe)$/u
/** Doorways and props that stand on a deck when there is one. */
const ON_DECK =
  /^(?:barrel|crate|hay|cart|coffin|fence|k_bench|k_bucket|k_sack|k_chest|k_barrel_rack|k_door|k_door_braced|k_door_plank|k_doorframe)$/u
/** Kit pieces whose back belongs on a wall. */
const WALL_MOUNTED = /^k_(?:window|shutters|door|balcony|support|lantern)/u
/** Hang or fly by design (matched against the piece's own and every ancestor's name). */
const HANGS = /(?:^|\/)(?:lantern|postlantern|pickup|bags|bird|cloud|tumbleweed)(?:\/|$)/u

/** Effects and backdrops (`scene/roles.ts`): never pieces. */
const isEffect = (o: Object3D): boolean => roleOf(o) === ROLE.Effect || roleOf(o) === ROLE.Backdrop

export interface Piece {
  name: string
  mesh: string
  /** World-space vertices, x y z. */
  v: Float32Array
  t0: number
  tn: number
  min: Vector3
  max: Vector3
  hangs: boolean
  decal: boolean
  /** Vertex colour of its first vertex (GeoBuilder boxes are one colour), or -1. */
  color: number
}

export interface Collected {
  pieces: Piece[]
  /** Triangles in world space, 9 numbers each. */
  tri: number[]
  /** Owning piece per triangle (-1: a huge support like the ground plane). */
  owner: number[]
  /** Huge triangles (ground, bluff, mesas): tested on every query, not gridded. */
  large: number[]
}

function chainNames(o: Object3D): string {
  const names: string[] = []
  let n: Object3D | null = o
  while (n) {
    if (n.name) {
      names.push(n.name)
    }
    n = n.parent
  }
  return names.join('/')
}

function firstName(o: Object3D): string {
  let n: Object3D | null = o
  while (n) {
    if (n.name) {
      return n.name
    }
    n = n.parent
  }
  return o.type
}

function shown(o: Object3D): boolean {
  let n: Object3D | null = o
  while (n) {
    if (!n.visible) {
      return false
    }
    n = n.parent
  }
  return true
}

function triIndex(g: BufferGeometry): Uint32Array {
  const idx = g.getIndex()
  if (idx) {
    return Uint32Array.from(idx.array)
  }
  const n = g.getAttribute('position').count
  const out = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = i
  }
  return out
}

/** Connected components over triangles sharing a welded (1 mm) vertex position. */
function components(g: BufferGeometry, idx: Uint32Array): Int32Array {
  const pos = g.getAttribute('position')
  const weld = new Map<string, number>()
  const vid = new Int32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`
    let id = weld.get(k)
    if (id === undefined) {
      id = weld.size
      weld.set(k, id)
    }
    vid[i] = id
  }
  const parent = Int32Array.from({ length: weld.size }, (_, i) => i)
  const find = (a: number): number => {
    let x = a
    while (parent[x] !== x) {
      const up = parent[parent[x] as number] as number
      parent[x] = up
      x = up
    }
    return x
  }
  const nt = idx.length / 3
  for (let t = 0; t < nt; t++) {
    const a = find(vid[idx[t * 3] as number] as number)
    parent[find(vid[idx[t * 3 + 1] as number] as number)] = a
    parent[find(vid[idx[t * 3 + 2] as number] as number)] = a
  }
  const comp = new Int32Array(nt)
  for (let t = 0; t < nt; t++) {
    comp[t] = find(vid[idx[t * 3] as number] as number)
  }
  return comp
}

function addPiece(
  out: Collected,
  name: string,
  mesh: string,
  chain: string,
  verts: number[],
  tris: number[],
  color: number,
  role: Role | undefined,
): void {
  const id = out.pieces.length
  const min = new Vector3(FAR, FAR, FAR)
  const max = new Vector3(-FAR, -FAR, -FAR)
  const p = new Vector3()
  for (let i = 0; i < verts.length; i += 3) {
    p.set(verts[i] as number, verts[i + 1] as number, verts[i + 2] as number)
    min.min(p)
    max.max(p)
  }
  const t0 = out.owner.length
  for (const x of tris) {
    out.tri.push(x)
  }
  for (let i = 0; i < tris.length / 9; i++) {
    out.owner.push(id)
  }
  out.pieces.push({
    name,
    mesh,
    v: Float32Array.from(verts),
    t0,
    tn: out.owner.length - t0,
    min,
    max,
    hangs: HANGS.test(`${name}/${chain}`),
    decal: role === ROLE.Decal,
    color,
  })
}

interface Part {
  name: string
  verts: number[]
  tris: number[]
  color: number
}

/** One mesh (or one instance of it) in world space, split into named parts. */
function meshParts(out: Collected, m: Mesh, world: Matrix4, label: string): Part[] {
  const g = m.geometry
  const pos = g.getAttribute('position')
  if (!pos) {
    return []
  }
  const idx = triIndex(g)
  const v = new Vector3()
  const wp = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(world)
    wp.set([v.x, v.y, v.z], i * 3)
  }
  g.computeBoundingSphere()
  const radius = (g.boundingSphere?.radius ?? 0) * world.getMaxScaleOnAxis()
  const nt = idx.length / 3
  // (by size, or by name: the outskirts terrain's bounding sphere sits right around the cut-off)
  if (radius > 150 || roleOf(m) === ROLE.Land || m.userData.support === true) {
    // the ground plane, the bluff, the mesas, a terrain flagged as ground: support only, never
    // audited
    for (let t = 0; t < nt; t++) {
      out.large.push(out.owner.length)
      for (let k = 0; k < 3; k++) {
        const i = idx[t * 3 + k] as number
        out.tri.push(wp[i * 3] as number, wp[i * 3 + 1] as number, wp[i * 3 + 2] as number)
      }
      out.owner.push(-1)
    }
    return []
  }
  let pieceOf: Int32Array
  let names: string[] = []
  const ranges = m.userData.pieces as { name: string; start: number; count: number }[] | undefined
  if (ranges) {
    names = ranges.map((range) => range.name)
    pieceOf = new Int32Array(nt)
    let r = 0
    for (let t = 0; t < nt; t++) {
      const first = idx[t * 3] as number
      while (r < ranges.length - 1 && first >= (ranges[r]?.start ?? 0) + (ranges[r]?.count ?? 0)) {
        r++
      }
      pieceOf[t] = r
    }
  } else if (m.matrixAutoUpdate === false && !(m instanceof InstancedMesh)) {
    pieceOf = components(g, idx)
  } else {
    pieceOf = new Int32Array(nt)
  }
  const byPiece = new Map<number, number[]>()
  for (let t = 0; t < nt; t++) {
    const p = pieceOf[t] as number
    const list = byPiece.get(p)
    if (list) {
      list.push(t)
    } else {
      byPiece.set(p, [t])
    }
  }
  const parts: Part[] = []
  const col = g.getAttribute('color')
  for (const [p, list] of byPiece) {
    const verts: number[] = []
    const tris: number[] = []
    const seen = new Set<number>()
    for (const t of list) {
      for (let k = 0; k < 3; k++) {
        const i = idx[t * 3 + k] as number
        const x = wp[i * 3] as number
        const y = wp[i * 3 + 1] as number
        const z = wp[i * 3 + 2] as number
        tris.push(x, y, z)
        if (!seen.has(i)) {
          seen.add(i)
          verts.push(x, y, z)
        }
      }
    }
    const first = idx[(list[0] ?? 0) * 3] as number
    const color = col
      ? Math.round(col.getX(first) * 255) * 65_536 +
        Math.round(col.getY(first) * 255) * 256 +
        Math.round(col.getZ(first) * 255)
      : -1
    parts.push({ name: names[p] ?? label, verts, tris, color })
  }
  return parts
}

export function collect(scene: Object3D): Collected {
  const out: Collected = { pieces: [], tri: [], owner: [], large: [] }
  scene.updateMatrixWorld(true)
  const instanced = new Map<
    string,
    { name: string; mesh: string; chain: string; part: Part; role: Role | undefined }
  >()
  scene.traverse((o) => {
    if (
      o instanceof SkinnedMesh ||
      o instanceof Points ||
      o instanceof Sprite ||
      !(o instanceof Mesh) ||
      !shown(o) ||
      isEffect(o)
    ) {
      return
    }
    const mat = Array.isArray(o.material) ? o.material[0] : o.material
    if (mat && !mat.depthWrite) {
      return
    }
    // anything riding a skeleton (a gun in a hand, a hat) is a character's: not audited here,
    // nor the crowd's batched revolvers (each instance rides a rider: ffa/scene/crowd/gun-batch.ts)
    if (o.userData.character === true) {
      return
    }
    for (let p = o.parent; p; p = p.parent) {
      if (p.type === 'Bone' || p instanceof SkinnedMesh) {
        return
      }
    }
    const label = o.name || mat?.name || 'mesh'
    const chain = chainNames(o)
    if (o instanceof InstancedMesh) {
      const im = new Matrix4()
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, im)
        const w = new Matrix4().multiplyMatrices(o.matrixWorld, im)
        const key = `${o.parent?.uuid}|${o.name || o.uuid}|${i}`
        const acc: {
          name: string
          mesh: string
          chain: string
          part: Part
          role: Role | undefined
        } = instanced.get(key) ?? {
          name: label,
          mesh: firstName(o),
          chain,
          part: { name: label, verts: [], tris: [], color: -1 },
          role: roleOf(o),
        }
        for (const part of meshParts(out, o, w, label)) {
          acc.part.verts.push(...part.verts)
          acc.part.tris.push(...part.tris)
        }
        instanced.set(key, acc)
      }
      return
    }
    for (const part of meshParts(out, o, o.matrixWorld, label)) {
      addPiece(out, part.name, firstName(o), chain, part.verts, part.tris, part.color, roleOf(o))
    }
  })
  for (const acc of instanced.values()) {
    if (acc.part.verts.length > 0) {
      addPiece(out, acc.name, acc.mesh, acc.chain, acc.part.verts, acc.part.tris, -1, acc.role)
    }
  }
  return out
}

/** XZ grid: cell -> triangle ids. */
class Grid {
  private readonly cells = new Map<number, number[]>()
  private static key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096)
  }
  constructor(c: Collected, skip: Set<number>) {
    const d = c.tri
    for (let t = 0; t < c.owner.length; t++) {
      if (skip.has(t)) {
        continue
      }
      const o = t * 9
      const x0 = Math.min(d[o] as number, d[o + 3] as number, d[o + 6] as number)
      const x1 = Math.max(d[o] as number, d[o + 3] as number, d[o + 6] as number)
      const z0 = Math.min(d[o + 2] as number, d[o + 5] as number, d[o + 8] as number)
      const z1 = Math.max(d[o + 2] as number, d[o + 5] as number, d[o + 8] as number)
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
        for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
          const k = Grid.key(i, j)
          const list = this.cells.get(k)
          if (list) {
            list.push(t)
          } else {
            this.cells.set(k, [t])
          }
        }
      }
    }
  }
  near(x0: number, z0: number, x1: number, z1: number, r: number): number[] {
    const out = new Set<number>()
    for (let i = Math.floor((x0 - r) / CELL); i <= Math.floor((x1 + r) / CELL); i++) {
      for (let j = Math.floor((z0 - r) / CELL); j <= Math.floor((z1 + r) / CELL); j++) {
        for (const t of this.cells.get(Grid.key(i, j)) ?? []) {
          out.add(t)
        }
      }
    }
    return [...out]
  }
  lists(): IterableIterator<number[]> {
    return this.cells.values()
  }
}

// ---------------------------------------------------------------- geometry (plain numbers)

type V3 = [number, number, number]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const len = (a: V3) => Math.sqrt(dot(a, a))
const lerp = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

function triAt(d: number[], t: number): [V3, V3, V3] {
  const o = t * 9
  return [
    [d[o] as number, d[o + 1] as number, d[o + 2] as number],
    [d[o + 3] as number, d[o + 4] as number, d[o + 5] as number],
    [d[o + 6] as number, d[o + 7] as number, d[o + 8] as number],
  ]
}

/** Closest distance from p to triangle abc (Ericson 5.1.5). */
function ptTri(p: V3, a: V3, b: V3, c: V3): number {
  const ab = sub(b, a)
  const ac = sub(c, a)
  const ap = sub(p, a)
  const d1 = dot(ab, ap)
  const d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) {
    return len(ap)
  }
  const bp = sub(p, b)
  const d3 = dot(ab, bp)
  const d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) {
    return len(bp)
  }
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    return len(sub(p, lerp(a, b, d1 / (d1 - d3))))
  }
  const cp = sub(p, c)
  const d5 = dot(ab, cp)
  const d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) {
    return len(cp)
  }
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    return len(sub(p, lerp(a, c, d2 / (d2 - d6))))
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return len(sub(p, lerp(b, c, (d4 - d3) / (d4 - d3 + (d5 - d6)))))
  }
  const den = 1 / (va + vb + vc)
  const v = vb * den
  const w = vc * den
  const q: V3 = [
    a[0] + ab[0] * v + ac[0] * w,
    a[1] + ab[1] * v + ac[1] * w,
    a[2] + ab[2] * v + ac[2] * w,
  ]
  return len(sub(p, q))
}

/** Closest distance between segments p1q1 and p2q2 (Ericson 5.1.9). */
function segSeg(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1 = sub(q1, p1)
  const d2 = sub(q2, p2)
  const r = sub(p1, p2)
  const a = dot(d1, d1)
  const e = dot(d2, d2)
  const f = dot(d2, r)
  let s = 0
  let t = 0
  if (a <= 1e-12 && e <= 1e-12) {
    return len(r)
  }
  if (a <= 1e-12) {
    t = Math.min(1, Math.max(0, f / e))
  } else {
    const c = dot(d1, r)
    if (e <= 1e-12) {
      s = Math.min(1, Math.max(0, -c / a))
    } else {
      const b = dot(d1, d2)
      const den = a * e - b * b
      s = den === 0 ? 0 : Math.min(1, Math.max(0, (b * f - c * e) / den))
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = Math.min(1, Math.max(0, -c / a))
      } else if (t > 1) {
        t = 1
        s = Math.min(1, Math.max(0, (b - c) / a))
      }
    }
  }
  return len(sub(lerp(p1, q1, s), lerp(p2, q2, t)))
}

function triTri(t: [V3, V3, V3], u: [V3, V3, V3]): number {
  let best = FAR
  for (const p of t) {
    best = Math.min(best, ptTri(p, u[0], u[1], u[2]))
  }
  for (const p of u) {
    best = Math.min(best, ptTri(p, t[0], t[1], t[2]))
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      best = Math.min(
        best,
        segSeg(t[i] as V3, t[(i + 1) % 3] as V3, u[j] as V3, u[(j + 1) % 3] as V3),
      )
    }
  }
  return best
}

/** Height of triangle abc over (x, z) and its normal's y, or null outside / near-vertical. */
function heightAt(t: [V3, V3, V3], x: number, z: number): { h: number; ny: number } | null {
  const [a, b, c] = t
  const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
  if (Math.abs(d) < 1e-9) {
    return null
  }
  const wa = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d
  const wb = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d
  const wc = 1 - wa - wb
  if (wa < -1e-4 || wb < -1e-4 || wc < -1e-4) {
    return null
  }
  const n = cross(sub(b, a), sub(c, a))
  const ny = n[1] / Math.max(1e-12, len(n))
  if (Math.abs(ny) < 0.2) {
    return null
  }
  return { h: wa * a[1] + wb * b[1] + wc * c[1], ny }
}

/** Does point set v straddle triangle t's plane inside the triangle (a window set into a wall)? */
function straddles(v: Float32Array, t: [V3, V3, V3]): boolean {
  const [a, b, c] = t
  const ab = sub(b, a)
  const ac = sub(c, a)
  const n = cross(ab, ac)
  const nl = len(n)
  if (nl < 1e-9) {
    return false
  }
  const d00 = dot(ab, ab)
  const d01 = dot(ab, ac)
  const d11 = dot(ac, ac)
  const den = d00 * d11 - d01 * d01
  let pos = false
  let neg = false
  for (let i = 0; i < v.length; i += 3) {
    const p: V3 = [
      (v[i] as number) - a[0],
      (v[i + 1] as number) - a[1],
      (v[i + 2] as number) - a[2],
    ]
    const s = dot(p, n) / nl
    const d20 = dot(p, ab)
    const d21 = dot(p, ac)
    const wb = (d11 * d20 - d01 * d21) / den
    const wc = (d00 * d21 - d01 * d20) / den
    if (wb < -0.01 || wc < -0.01 || wb + wc > 1.01) {
      continue
    }
    if (Math.abs(s) <= 0.002) {
      return true
    }
    if (s > 0) {
      pos = true
    } else {
      neg = true
    }
    if (pos && neg) {
      return true
    }
  }
  return false
}

function triBox(t: [V3, V3, V3]): [V3, V3] {
  return [
    [
      Math.min(t[0][0], t[1][0], t[2][0]),
      Math.min(t[0][1], t[1][1], t[2][1]),
      Math.min(t[0][2], t[1][2], t[2][2]),
    ],
    [
      Math.max(t[0][0], t[1][0], t[2][0]),
      Math.max(t[0][1], t[1][1], t[2][1]),
      Math.max(t[0][2], t[1][2], t[2][2]),
    ],
  ]
}

function boxGap(a0: V3, a1: V3, b0: V3, b1: V3): number {
  const dx = Math.max(0, a0[0] - b1[0], b0[0] - a1[0])
  const dy = Math.max(0, a0[1] - b1[1], b0[1] - a1[1])
  const dz = Math.max(0, a0[2] - b1[2], b0[2] - a1[2])
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** The piece's lowest vertices (within 2 cm of its foot), nudged 5% inward, plus their middle. */
function feet(p: Piece, max = 24): V3[] {
  const low: V3[] = []
  for (let i = 0; i < p.v.length; i += 3) {
    if ((p.v[i + 1] as number) < p.min.y + 0.02) {
      low.push([p.v[i] as number, p.v[i + 1] as number, p.v[i + 2] as number])
    }
  }
  const cx = low.reduce((s, q) => s + q[0], 0) / Math.max(1, low.length)
  const cz = low.reduce((s, q) => s + q[2], 0) / Math.max(1, low.length)
  const step = Math.max(1, Math.floor(low.length / max))
  const out: V3[] = [[cx, p.min.y, cz]]
  for (let i = 0; i < low.length; i += step) {
    const q = low[i] as V3
    out.push([q[0] + (cx - q[0]) * 0.05, p.min.y, q[2] + (cz - q[2]) * 0.05])
  }
  return out
}

// ---------------------------------------------------------------- the audit

export function auditScene(scene: Object3D): AuditReport {
  const start = performance.now()
  const col = collect(scene)
  const { pieces, tri, owner, large } = col
  const grid = new Grid(col, new Set(large))
  const issues: AuditIssue[] = []
  const allowed: AuditReport['allowed'] = []
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  const where = (p: Piece): [number, number, number] => [
    r3((p.min.x + p.max.x) / 2),
    r3(p.min.y),
    r3((p.min.z + p.max.z) / 2),
  ]
  const size = (p: Piece): [number, number, number] => [
    r3(p.max.x - p.min.x),
    r3(p.max.y - p.min.y),
    r3(p.max.z - p.min.z),
  ]
  const nearOf = (p: Piece, r: number) => grid.near(p.min.x, p.min.z, p.max.x, p.max.z, r)

  /** Air under the piece: its best-supported foot to the highest surface under it. */
  const airUnder = (id: number, p: Piece, near: number[]): number => {
    let gap = FAR
    for (const [x, y, z] of feet(p)) {
      let top = -FAR
      for (const t of near) {
        const o = owner[t] as number
        if (o === id || pieces[o]?.decal) {
          continue
        }
        const hit = heightAt(triAt(tri, t), x, z)
        if (hit && hit.h <= y + FLOAT_TOL && hit.h > top) {
          top = hit.h
        }
      }
      for (const t of large) {
        // the ground is support wherever the foot is, even sunk under it
        const hit = heightAt(triAt(tri, t), x, z)
        if (hit && hit.h > top) {
          top = Math.min(hit.h, y)
        }
      }
      gap = Math.min(gap, y - top)
    }
    return gap
  }

  /** How far the foot is buried under a deck (an up-facing static surface) it should stand on. */
  const buried = (id: number, p: Piece, near: number[]): number => {
    let sunk = FAR
    for (const [x, y, z] of feet(p)) {
      let deck = FAR
      for (const t of near) {
        const o = owner[t] as number
        const q = pieces[o]
        if (o === id || !q || GROUNDED.test(q.name) || WALL_MOUNTED.test(q.name)) {
          continue
        }
        const hit = heightAt(triAt(tri, t), x, z)
        if (hit && hit.ny > 0.7 && hit.h > y + 0.005 && hit.h < Math.min(p.max.y, y + 0.6)) {
          deck = Math.min(deck, hit.h)
        }
      }
      if (deck < FAR) {
        sunk = Math.min(sunk, deck - y)
      } else {
        // nothing over this foot: the piece isn't wholly under a deck
        return FAR
      }
    }
    return sunk
  }

  /** Nearest distance from the piece to any other piece (0 when they interpenetrate). */
  const contact = (id: number, p: Piece, near: number[]): { dist: number; other: string } => {
    let best = FAR
    let other = ''
    const pMin: V3 = [p.min.x, p.min.y, p.min.z]
    const pMax: V3 = [p.max.x, p.max.y, p.max.z]
    const own: { t: [V3, V3, V3]; box: [V3, V3] }[] = []
    const stride = Math.max(1, Math.floor(p.tn / 400))
    for (let t = p.t0; t < p.t0 + p.tn; t += stride) {
      const tt = triAt(tri, t)
      own.push({ t: tt, box: triBox(tt) })
    }
    for (const u of near) {
      const o = owner[u] as number
      if (o === id || o < 0) {
        continue
      }
      const ut = triAt(tri, u)
      const [u0, u1] = triBox(ut)
      if (boxGap(pMin, pMax, u0, u1) > Math.min(best, 0.6)) {
        continue
      }
      const name = pieces[o]?.name ?? ''
      if (straddles(p.v, ut)) {
        return { dist: 0, other: name }
      }
      for (const { t, box } of own) {
        if (boxGap(box[0], box[1], u0, u1) >= best) {
          continue
        }
        const d = triTri(t, ut)
        if (d < best) {
          best = d
          other = name
          if (best < 1e-4) {
            return { dist: 0, other }
          }
        }
      }
    }
    return { dist: best, other }
  }

  const issue = (
    kind: AuditIssue['kind'],
    p: Piece,
    gap: number,
    c: { dist: number; other: string },
  ): AuditIssue => ({
    kind,
    name: p.name,
    mesh: p.mesh,
    at: where(p),
    size: size(p),
    gap: gap >= FAR ? FAR : r3(gap),
    contact: c.dist >= FAR ? FAR : r3(c.dist),
    other: c.other,
  })

  for (const [id, p] of pieces.entries()) {
    if (p.decal) {
      continue
    }
    const near = nearOf(p, 0.06)
    const gap = airUnder(id, p, near)
    if (p.hangs) {
      const c = gap <= FLOAT_TOL ? { dist: 0 } : contact(id, p, nearOf(p, 0.6))
      allowed.push({ name: p.name, mount: r3(Math.min(gap, c.dist)), at: where(p) })
      continue
    }
    if (ON_DECK.test(p.name)) {
      const sunk = buried(id, p, near)
      if (sunk > DEEP && sunk < FAR) {
        issues.push(issue('sunk', p, sunk, { dist: 0, other: 'deck' }))
      } else if (p.min.y < -DEEP) {
        issues.push(issue('sunk', p, -p.min.y, { dist: 0, other: 'ground' }))
      }
    }
    const mounted = WALL_MOUNTED.test(p.name)
    if (gap <= FLOAT_TOL && !mounted) {
      continue
    }
    const c = contact(id, p, near)
    if (c.dist <= WALL_TOL && (!GROUNDED.test(p.name) || gap <= FLOAT_TOL)) {
      continue
    }
    issues.push(issue(gap <= FLOAT_TOL ? 'loose' : 'float', p, gap, c))
  }
  issues.push(...zFights(col, grid, where, size))
  return {
    pieces: pieces.length,
    triangles: owner.length,
    issues,
    allowed,
    ms: Math.round(performance.now() - start),
  }
}

/** Coplanar, same-facing, overlapping triangles from two different pieces. */
function zFights(
  col: Collected,
  grid: Grid,
  where: (p: Piece) => [number, number, number],
  size: (p: Piece) => [number, number, number],
): AuditIssue[] {
  const { pieces, tri, owner } = col
  const seen = new Set<string>()
  const out: AuditIssue[] = []
  /** p strictly inside abc (4 mm in from every edge); n is abc's unit normal. */
  const inside = (p: V3, [a, b, c]: [V3, V3, V3], n: V3) => {
    const edge = (u: V3, v: V3) => {
      const e = sub(v, u)
      return dot(cross(e, sub(p, u)), n) / Math.max(1e-9, len(e)) > 0.004
    }
    return edge(a, b) && edge(b, c) && edge(c, a)
  }
  const unit = (t: [V3, V3, V3]): { n: V3; area: number } => {
    const n = cross(sub(t[1], t[0]), sub(t[2], t[0]))
    const l = len(n)
    return { n: [n[0] / l, n[1] / l, n[2] / l], area: l / 2 }
  }
  const mid = (t: [V3, V3, V3]): V3 => [
    (t[0][0] + t[1][0] + t[2][0]) / 3,
    (t[0][1] + t[1][1] + t[2][1]) / 3,
    (t[0][2] + t[1][2] + t[2][2]) / 3,
  ]
  for (const list of grid.lists()) {
    for (let i = 0; i < list.length; i++) {
      const ta = list[i] as number
      const oa = owner[ta] as number
      const pa = pieces[oa]
      if (!pa || pa.decal) {
        continue
      }
      const a = triAt(tri, ta)
      const ua = unit(a)
      if (ua.area < 1e-4) {
        continue
      }
      for (let j = i + 1; j < list.length; j++) {
        const tb = list[j] as number
        const ob = owner[tb] as number
        const pb = pieces[ob]
        if (!pb || ob === oa || pb.decal) {
          continue
        }
        const key = oa < ob ? `${oa}|${ob}` : `${ob}|${oa}`
        if (seen.has(key)) {
          continue
        }
        const b = triAt(tri, tb)
        const ub = unit(b)
        if (ub.area < 1e-4 || dot(ua.n, ub.n) < 0.999) {
          continue
        }
        if (Math.abs(dot(ua.n, sub(b[0], a[0]))) > 0.002) {
          continue
        }
        // invisible: identical surfaces (one mesh, one colour, world-space UVs), or both facing
        // down into the ground
        if (pa.mesh === pb.mesh && pa.color >= 0 && pa.color === pb.color) {
          continue
        }
        if (ua.n[1] < -0.9 && a[0][1] < 0.002) {
          continue
        }
        if (!(inside(mid(b), a, ua.n) || inside(mid(a), b, ua.n))) {
          continue
        }
        seen.add(key)
        out.push({
          kind: 'zfight',
          name: pa.name,
          mesh: pa.mesh,
          at: where(pa),
          size: size(pa),
          gap: 0,
          contact: 0,
          other: `${pb.name} (${pb.mesh}) at ${where(pb).join(', ')}`,
        })
      }
    }
  }
  return out
}

/** A lit surface drawn with no texture (flat colour only): the "untextured model" check. */
export interface Untextured {
  mesh: string
  material: string
  color: string
  triangles: number
}

/**
 * Every visible, lit mesh whose material has no colour map and no procedural surface
 * (`userData.procedural`, set by scene/surface.ts and the plant material). Unlit effect materials,
 * and the glass, water, sky, effect and decal roles, are skipped.
 */
export function textureAudit(scene: Object3D): Untextured[] {
  const out = new Map<string, Untextured>()
  scene.traverse((o) => {
    if (!(o instanceof Mesh && shown(o))) {
      return
    }
    const mats = (Array.isArray(o.material) ? o.material : [o.material]) as {
      type: string
      name: string
      map?: unknown
      userData: Record<string, unknown>
      color?: { getHexString: () => string }
      emissiveIntensity?: number
    }[]
    const role = roleOf(o)
    const chain = chainNames(o)
    if (role === ROLE.Effect || role === ROLE.Backdrop || role === ROLE.Decal) {
      return
    }
    for (const m of mats) {
      const lit =
        m.type === 'MeshStandardMaterial' ||
        m.type === 'MeshPhysicalMaterial' ||
        m.type === 'MeshLambertMaterial' ||
        m.type === 'MeshPhongMaterial'
      if (
        !lit ||
        m.map ||
        m.userData.procedural ||
        isFlatMaterial(m) ||
        slotOf(m) === SLOT.Iron ||
        slotOf(m) === SLOT.Glass
      ) {
        continue
      }
      const pos = o.geometry.getAttribute('position')
      const idx = o.geometry.getIndex()
      const key = `${chain}|${m.name}`
      out.set(key, {
        mesh: chain || o.type,
        material: m.name || '(unnamed)',
        color: m.color?.getHexString() ?? '',
        triangles: Math.round((idx ? idx.count : (pos?.count ?? 0)) / 3),
      })
    }
  })
  return [...out.values()]
}

/**
 * Render one view through the page's own renderer (no post) and return it as a PNG data URL:
 * the visual pass flies this camera along the frontages and down to the ground contacts.
 */
export function snapshot(
  renderer: WebGLRenderer,
  scene: Object3D,
  from: [number, number, number],
  to: [number, number, number],
  fov = 50,
): string {
  const canvas = renderer.domElement
  const cam = new PerspectiveCamera(fov, canvas.width / Math.max(1, canvas.height), 0.05, 900)
  cam.position.set(...from)
  cam.lookAt(new Vector3(...to))
  cam.updateMatrixWorld()
  const target = renderer.getRenderTarget()
  renderer.setRenderTarget(null)
  renderer.render(scene, cam)
  renderer.setRenderTarget(target)
  return canvas.toDataURL('image/png')
}
