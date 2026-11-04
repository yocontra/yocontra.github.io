// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
/**
 * The arenas' shared plumbing: one batch per material (the street's planks, trim and night-lit
 * glass, the masonry atlas, adobe, painted signs, the merged kit and the instanced library props),
 * so a whole arena draws in about as many calls as the street does, and frees exactly what it made.
 */
import {
  type BufferGeometry,
  Group,
  InstancedMesh,
  type Material,
  type Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Vector3,
} from 'three'
import { withCloudShadow } from '../atmos.ts'
import { GeoBuilder } from '../geo.ts'
import { addStatic } from '../landmarks.ts'
import { Masonry } from '../masonry.ts'
import {
  instance,
  mergePlaced,
  type PropDef,
  placeMatrix,
  propDef,
  propsLibrary,
} from '../props.ts'
import type { Placed } from '../street.ts'
import { type SignSpec, signAtlas } from '../textures.ts'
import type { ArenaCtx } from './types.ts'

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z)

/** A kit piece in its own metres and origin (null without the props library). */
function kitPiece(name: string): PropDef | null {
  const lib = propsLibrary()
  return lib ? propDef(lib, name, 1, 'y', true) : null
}

/** A painted board: its lettering and the quad it's drawn on (counter-clockwise seen from in front). */
interface Board {
  spec: SignSpec
  quad: [Vector3, Vector3, Vector3, Vector3]
}

/** Which way a board or kit piece faces. */
export type Facing = '+x' | '-x' | '+z' | '-z'

/** A kit piece's yaw to face `f` (kit pieces face +Z). */
export const YAW: Record<Facing, number> = {
  '+z': 0,
  '-z': Math.PI,
  '+x': Math.PI / 2,
  '-x': -Math.PI / 2,
}

export class ArenaParts {
  readonly root = new Group()
  /** Horizontal painted planks (World.wallMat). */
  readonly walls = new GeoBuilder(1.9)
  /** Vertical planks: trim, posts, decks, rolling stock (World.trimMat). */
  readonly trim = new GeoBuilder(1.6)
  /** Night-lit glass (World.windowMat). */
  readonly glass = new GeoBuilder(1)
  /** Earthen walls on the street's dirt texture. */
  readonly adobe = new GeoBuilder(3.2)
  /** Brick, sandstone, slate and tin. */
  readonly m = new Masonry()
  /** Kit pieces (doors, windows, benches...), merged into the kit's one draw. */
  readonly kit: Placed[] = []
  private readonly boards: Board[] = []
  private readonly props = new Map<string, { def: PropDef; mats: Matrix4[]; shadow: boolean }>()
  private readonly owned: { dispose: () => void }[] = []
  private readonly ctx: ArenaCtx

  constructor(ctx: ArenaCtx, name: string) {
    this.ctx = ctx
    this.root.name = `arena-${name}`
  }

  /** Place a kit piece (merged into the kit draw). */
  put(name: string, at: Matrix4): void {
    const def = kitPiece(name)
    if (def) {
      this.kit.push({ def, at })
    }
  }

  /** An instanced library prop (barrel, crate, hay, cart, fence, lantern...), `size` along `axis`. */
  prop(name: string, size: number, axis: 'max' | 'y', at: Matrix4, shadow = true): void {
    const key = `${name}|${size}|${axis}`
    let entry = this.props.get(key)
    if (!entry) {
      const lib = propsLibrary()
      const def = lib ? propDef(lib, name, size, axis) : null
      if (!def) {
        return
      }
      entry = { def, mats: [], shadow }
      this.props.set(key, entry)
    }
    entry.mats.push(at)
  }

  /** A painted board, `w` × `h`, centred on (x, y, z) and facing `f`. */
  board(spec: SignSpec, x: number, y: number, z: number, f: Facing, w: number, h: number): void {
    const hw = w / 2
    const hh = h / 2
    // left-to-right as seen from in front
    const right: Record<Facing, Vector3> = {
      '+z': V(1, 0, 0),
      '-z': V(-1, 0, 0),
      '+x': V(0, 0, -1),
      '-x': V(0, 0, 1),
    }
    const r = right[f]
    const c = V(x, y, z)
    const at = (u: number, v: number) =>
      c
        .clone()
        .addScaledVector(r, u * hw)
        .add(V(0, v * hh, 0))
    this.boards.push({ spec, quad: [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)] })
  }

  /** Build every batch into the root. */
  finish(): void {
    const ctx = this.ctx
    const named = (m: Mesh | null, name: string) => {
      if (m) {
        m.name = name
      }
      return m
    }
    named(addStatic(this.root, this.walls, ctx.wallMat), 'walls')
    named(addStatic(this.root, this.trim, ctx.trimMat), 'trim')
    const glass = named(addStatic(this.root, this.glass, ctx.windowMat, false), 'windows')
    if (glass) {
      glass.receiveShadow = false
    }
    if (!this.adobe.empty) {
      const mat = new MeshStandardMaterial({
        map: ctx.ground.map,
        normalMap: ctx.ground.normal,
        vertexColors: true,
        roughness: 0.96,
        metalness: 0,
        name: 'Adobe',
      })
      withCloudShadow(mat)
      this.owned.push(mat)
      named(addStatic(this.root, this.adobe, mat), 'adobe')
    }
    const masonry = this.m.build((_p, n) => (n.y < -0.5 ? 0.62 : 1))
    if (masonry) {
      const mesh = new Mesh(masonry, ctx.civic)
      mesh.name = 'masonry'
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.matrixAutoUpdate = false
      this.root.add(mesh)
    }
    this.buildBoards()
    mergePlaced(this.kit, this.root, new Map([['KitGlass', ctx.windowMat]]))
    for (const { def, mats, shadow } of this.props.values()) {
      instance(def, mats, this.root, shadow)
    }
  }

  private buildBoards(): void {
    if (this.boards.length === 0) {
      return
    }
    // one atlas row per lettering (a board hung back to back shares its row)
    const specs: SignSpec[] = []
    const rowOf = (spec: SignSpec): number => {
      const i = specs.findIndex((o) => o.text === spec.text && o.bg === spec.bg && o.fg === spec.fg)
      return i >= 0 ? i : specs.push(spec) - 1
    }
    const rows = this.boards.map((b) => rowOf(b.spec))
    const atlas = signAtlas(specs)
    const street = this.ctx.signMat
    // the street's board relief and roughness, shared (their tiling is the street's)
    const mat = new MeshStandardMaterial({
      map: atlas.tex,
      roughness: street.roughness,
      normalMap: street.normalMap,
      normalScale: street.normalScale.clone(),
      aoMap: street.aoMap,
      roughnessMap: street.roughnessMap,
      name: 'ArenaSigns',
    })
    this.owned.push(mat, atlas.tex)
    const g = new GeoBuilder(1)
    const n = atlas.rows
    this.boards.forEach((b, i) => {
      const row = rows[i] ?? 0
      const v0 = 1 - (row + 1) / n
      const v1 = 1 - row / n
      g.quadUV(b.quad, [0, v0, 1, v0, 1, v1, 0, v1], 0xff_ff_ff)
    })
    const m = addStatic(this.root, g, mat, false)
    if (m) {
      m.name = 'signs'
    }
  }

  /** Free what this arena made: its geometry, its own materials and textures, never the shared ones. */
  dispose(): void {
    this.root.traverse((o: Object3D) => {
      if (o instanceof InstancedMesh) {
        // the instanced geometry is the props library's (cached, shared)
        o.dispose()
      } else if (o instanceof Mesh) {
        ;(o.geometry as BufferGeometry).dispose()
      }
    })
    for (const d of this.owned) {
      d.dispose()
    }
  }

  /** Something extra the arena made that needs freeing with it. */
  own(d: { dispose: () => void } | Material): void {
    this.owned.push(d)
  }
}

// ------------------------------------------------------------------------------- shapes

/**
 * A square-section beam from `a` to `b`, `w` wide and `d` deep (w across, horizontally; d in the
 * plane holding the beam and the vertical).
 */
export function beam(
  g: GeoBuilder,
  a: Vector3,
  b: Vector3,
  w: number,
  d: number,
  color: number,
): void {
  const axis = b.clone().sub(a)
  const len = axis.length()
  if (len < 1e-4) {
    return
  }
  axis.divideScalar(len)
  const ref = Math.abs(axis.y) > 0.95 ? V(1, 0, 0) : V(0, 1, 0)
  const side = new Vector3()
    .crossVectors(axis, ref)
    .normalize()
    .multiplyScalar(w / 2)
  const up = new Vector3()
    .crossVectors(side, axis)
    .normalize()
    .multiplyScalar(d / 2)
  const corner = (p: Vector3, s: number, u: number) =>
    p.clone().addScaledVector(side, s).addScaledVector(up, u)
  const ring = (p: Vector3) => [
    corner(p, -1, -1),
    corner(p, 1, -1),
    corner(p, 1, 1),
    corner(p, -1, 1),
  ]
  const ra = ring(a)
  const rb = ring(b)
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    g.quad(ra[i] as Vector3, ra[j] as Vector3, rb[j] as Vector3, rb[i] as Vector3, color)
  }
  g.quad(ra[3] as Vector3, ra[2] as Vector3, ra[1] as Vector3, ra[0] as Vector3, color)
  g.quad(rb[0] as Vector3, rb[1] as Vector3, rb[2] as Vector3, rb[3] as Vector3, color)
}

/** A vertical faceted cylinder or frustum (r0 at the foot, r1 at the top), with caps. */
export function cyl(
  g: GeoBuilder,
  cx: number,
  y0: number,
  cz: number,
  r0: number,
  r1: number,
  h: number,
  n: number,
  color: number,
  caps = true,
): void {
  const top = y0 + h
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    const p0 = V(cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0)
    const p1 = V(cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0)
    const q0 = V(cx + Math.cos(a0) * r1, top, cz + Math.sin(a0) * r1)
    const q1 = V(cx + Math.cos(a1) * r1, top, cz + Math.sin(a1) * r1)
    g.quad(p1, p0, q0, q1, color)
    if (caps && r1 > 1e-3) {
      g.tri(V(cx, top, cz), q1, q0, color)
    }
    if (caps && r0 > 1e-3) {
      g.tri(V(cx, y0, cz), p0, p1, color)
    }
  }
}

/** A faceted cylinder along `a`→`b` (wheels, spouts, pipes), with caps. */
export function rod(g: GeoBuilder, a: Vector3, b: Vector3, r: number, n: number, color: number) {
  const axis = b.clone().sub(a).normalize()
  const ref = Math.abs(axis.y) > 0.95 ? V(1, 0, 0) : V(0, 1, 0)
  const s = new Vector3().crossVectors(axis, ref).normalize()
  const u = new Vector3().crossVectors(s, axis).normalize()
  const at = (p: Vector3, k: number) =>
    p
      .clone()
      .addScaledVector(s, Math.cos((k / n) * Math.PI * 2) * r)
      .addScaledVector(u, Math.sin((k / n) * Math.PI * 2) * r)
  for (let i = 0; i < n; i++) {
    g.quad(at(a, i), at(a, i + 1), at(b, i + 1), at(b, i), color)
    g.tri(a, at(a, i + 1), at(a, i), color)
    g.tri(b, at(b, i), at(b, i + 1), color)
  }
}

/** A kit lantern hung from (x, roof, z) on a short chain: the flame's height. */
export function hangLantern(p: ArenaParts, x: number, roof: number, z: number): number {
  p.trim.box(x, roof - 0.09, z, 0.02, 0.18, 0.02, 0x2a_2a_2a)
  p.prop('lantern', 0.45, 'y', placeAt(x, roof - 0.18 - 0.45, z), false)
  return roof - 0.18 - 0.45 + 0.19
}

/** A prop standing at (x, y, z), turned `ry`, scaled `s`. */
export function placeAt(x: number, y: number, z: number, ry = 0, s = 1): Matrix4 {
  return placeMatrix(x, y, z, ry, s)
}

/** A hitching rail: two posts and the rail, `len` long along `along`, centred at (x, z). */
export function hitchRail(
  g: GeoBuilder,
  x: number,
  z: number,
  along: 'x' | 'z',
  len = 2.6,
  color = 0x5a_44_30,
): void {
  const h = len / 2 - 0.1
  const [dx, dz] = along === 'z' ? [0, h] : [h, 0]
  g.box(x - dx, 0.53, z - dz, 0.14, 1.06, 0.14, color)
  g.box(x + dx, 0.53, z + dz, 0.14, 1.06, 0.14, color)
  g.box(x, 0.95, z, along === 'x' ? len : 0.1, 0.1, along === 'z' ? len : 0.1, color)
}

/** A telegraph pole with its crossarm and insulators; returns the insulator tips (for the wires). */
export function telegraphPole(p: ArenaParts, x: number, z: number, h = 7.2): Vector3[] {
  const wood = 0x5a_4a_3a
  cyl(p.trim, x, 0, z, 0.14, 0.11, h, 6, wood, false)
  p.trim.box(x, h - 0.45, z, 1.8, 0.12, 0.12, wood)
  const tips: Vector3[] = []
  for (const dx of [-0.75, -0.3, 0.3, 0.75]) {
    p.glass.box(x + dx, h - 0.3, z, 0.07, 0.16, 0.07, 0x5a_8a_7a)
    tips.push(V(x + dx, h - 0.24, z))
  }
  return tips
}

/** Sagging wires between two poles' insulators (three segments a span). */
export function wires(g: GeoBuilder, a: readonly Vector3[], b: readonly Vector3[]): void {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const p = a[i] as Vector3
    const q = b[i] as Vector3
    const pts = [0, 1 / 3, 2 / 3, 1].map((t) => {
      const v = p.clone().lerp(q, t)
      v.y -= Math.sin(t * Math.PI) * 0.45
      return v
    })
    for (let k = 0; k < 3; k++) {
      beam(g, pts[k] as Vector3, pts[k + 1] as Vector3, 0.025, 0.025, 0x1e_1c_1a)
    }
  }
}
