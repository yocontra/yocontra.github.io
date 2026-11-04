// biome-ignore-all lint/complexity/useMaxParams: placement helpers take positional numeric args (x, z, kind, lod, size)
// biome-ignore-all lint/style/noExcessiveClassesPerFile: the atmosphere and its tumbleweeds are one small module
// biome-ignore-all lint/style/noMagicNumbers: scatter densities and bounds, tuned by eye at eye level and from above
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: placement rules are flat checks, kept inline
/**
 * Perdition's sky, atmosphere and plant life: the shared sky dome and aerial perspective, moving
 * cloud shadows on the ground and every town surface, and the desert plants.
 *
 * - Past the playable square (and on the unwalkable bench north of the creek): saguaro stands,
 *   Joshua trees, ocotillo, cholla, prickly pear, barrel cactus, creosote and sage, boulders and
 *   dead snags, in seeded clumps over the outskirts' terrain, thinning out toward the hills.
 * - Nothing grows on the town's walkable ground, and nothing here touches collision.
 *
 * The playable bounds, streets and cover come from the layout data, never hard-coded.
 */
import {
  Color,
  type Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type Scene,
  type Vector3,
} from 'three'
import { ATMOS, tickAtmos, withCloudShadow } from '../../scene/atmos.ts'
import {
  buildFlora,
  clumpScatter,
  floraDensity,
  type Plant,
  type PlantKind,
  pickKind,
} from '../../scene/flora.ts'
import { tumbleweedGeometry } from '../../scene/fx.ts'
import type { Preset } from '../../scene/presets.ts'
import { Sky } from '../../scene/sky.ts'
import type { TownLayout } from '../sim/layout.ts'
import { Rng } from '../sim/rng.ts'
import { type Interior, withInterior } from './interior.ts'
import {
  OUTSKIRTS_SEED,
  outskirtsProps,
  REACH,
  terrainHeight,
  terrainMeshHeight,
} from './outskirts.ts'

const SEED = 0x0f_10_7a_01

const OUT_KINDS: readonly (readonly [PlantKind, number])[] = [
  ['saguaro', 3],
  ['creosote', 4],
  ['sage', 3],
  ['grass', 5],
  ['joshua', 1.2],
  ['ocotillo', 1.1],
  ['cholla', 1.1],
  ['pear', 1.4],
  ['barrel', 1.2],
  ['boulder', 0.8],
  ['snag', 0.3],
]

const FAR_KINDS: readonly (readonly [PlantKind, number])[] = [
  ['saguaro', 5],
  ['joshua', 2],
  ['creosote', 4],
  ['ocotillo', 1],
  ['boulder', 1.2],
  ['snag', 0.3],
]

/** Steepness of the terrain at (x, z): rise per metre. */
function slope(layout: TownLayout, x: number, z: number): number {
  const e = 0.6
  const gx = terrainHeight(layout, x + e, z) - terrainHeight(layout, x - e, z)
  const gz = terrainHeight(layout, x, z + e) - terrainHeight(layout, x, z - e)
  return Math.hypot(gx, gz) / (2 * e)
}

/** Every plant in and around Perdition (seeded), and the ground they stand on. */
export function wildsPlants(
  layout: TownLayout,
  tier: string,
): { plants: Plant[]; heightAt: (x: number, z: number) => number } {
  const rng = new Rng(SEED)
  const k = floraDensity(tier)
  const s = layout.size
  const north = layout.creek.z
  const plants: Plant[] = []
  const add = (x: number, z: number, kind: PlantKind, lod: number, scale = 1) => {
    plants.push({
      kind,
      x,
      z,
      s: scale * (0.8 + rng.next() * 0.45),
      seed: (rng.next() * 4_294_967_296) >>> 0,
      lod,
    })
  }
  // the terrain mesh reaches REACH past the square; beyond it is the flat ground plane
  const inMesh = (x: number, z: number) =>
    x > -REACH + 1 && x < s + REACH - 1 && z > -REACH + 1 && z < s + REACH - 1
  const heightAt = (x: number, z: number) => terrainMeshHeight(layout, x, z)
  // the playable square, less the unwalkable strip north of the creek bed
  const offPlay = (x: number, z: number, m: number) =>
    x < -m || x > s + m || z > s + m || z < north - 0.4 - m
  // the trails that leave town (from the streets' open ends) stay clear
  const onTrail = (x: number, z: number) =>
    layout.streets.some((st) => {
      const wide = st.w > st.d
      if (wide) {
        return Math.abs(z - (st.z + st.d / 2)) < st.d / 2 + 2 && (x < st.x || x > st.x + st.w)
      }
      return Math.abs(x - (st.x + st.w / 2)) < st.w / 2 + 2 && (z < st.z || z > st.z + st.d)
    })
  const bridge = layout.creek.bridge
  const nearBridge = (x: number, z: number) =>
    Math.abs(x - (bridge.x + bridge.w / 2)) < bridge.w / 2 + 3 && z < north + 2

  // 0. the outskirts' own cactus spots (the old GLB cactus): saguaros and Joshua trees now
  for (const m of outskirtsProps(layout, OUTSKIRTS_SEED).cactus) {
    const x = m.elements[12] ?? 0
    const z = m.elements[14] ?? 0
    add(x, z, rng.next() < 0.75 ? 'saguaro' : 'joshua', 0)
  }
  // 1. the outskirts: dense and varied close to the edge, where both cameras see it
  const ring = clumpScatter(
    rng,
    { x0: -40, z0: -40, x1: s + 40, z1: s + 40 },
    Math.round(230 * k),
    [3, 8],
    6,
    1.2,
    (x, z) => {
      if (!offPlay(x, z, 0.8) || onTrail(x, z) || nearBridge(x, z)) {
        return false
      }
      return !inMesh(x, z) || slope(layout, x, z) < 0.8
    },
  )
  for (const p of ring) {
    add(p.x, p.z, pickKind(rng, OUT_KINDS), 0)
  }
  // 1b. brush and stones down the cut bank north of the creek (unwalkable): what the spawn sees
  const bank = clumpScatter(
    rng,
    { x0: 0, z0: north - 7, x1: s, z1: north - 0.5 },
    Math.round(70 * k),
    [2, 5],
    3,
    0.9,
    (x, z) => !nearBridge(x, z) && z < north - 0.5,
  )
  for (const p of bank) {
    add(
      p.x,
      p.z,
      pickKind(rng, [
        ['grass', 4],
        ['sage', 3],
        ['creosote', 2],
        ['boulder', 1.5],
        ['pear', 0.8],
        ['barrel', 0.6],
      ]),
      0,
      0.85,
    )
  }
  // 2. out toward the hills and beyond (what the eye-level camera sees on the horizon)
  const far = clumpScatter(
    rng,
    { x0: -170, z0: -170, x1: s + 170, z1: s + 170 },
    Math.round(70 * k),
    [3, 7],
    14,
    3.5,
    (x, z) => {
      if (offPlay(x, z, 40) === false || onTrail(x, z)) {
        return false
      }
      return !inMesh(x, z)
    },
  )
  for (const p of far) {
    const kind = pickKind(rng, FAR_KINDS)
    add(p.x, p.z, kind, 1, kind === 'boulder' ? 1.5 : 1.1)
  }
  return { plants, heightAt }
}

/** Every plant in and around Perdition, baked into chunked meshes. */
export function buildWilds(layout: TownLayout, tier: string): Group {
  const { plants, heightAt } = wildsPlants(layout, tier)
  const s = layout.size
  const near = (x: number, z: number) => x > -45 && x < s + 45 && z > -45 && z < s + 45
  return buildFlora(plants, {
    heightAt,
    chunk: 36,
    chunkKey: (x, z) => {
      if (near(x, z)) {
        return `g${Math.floor(x / 36)},${Math.floor(z / 36)}`
      }
      const a = Math.atan2(z - s / 2, x - s / 2)
      return `w${Math.floor(((a + Math.PI) / (Math.PI * 2)) * 8)}`
    },
    // no real-time shadows: the plants all stand outside the square, past the shadow map's reach
  })
}

/** Plank-faced town materials (boards vary one by one). */
const BOARDS = new Set(['town-wall', 'town-roof', 'town-wood'])

/**
 * Moving cloud shadows and interior light on every lit, static town surface under `root`; window
 * glass gets the indoor/outdoor look.
 */
export function shadeTown(root: Object3D, inside: Interior): void {
  const seen = new Set<Material>()
  root.traverse((o) => {
    if (o.name === 'outskirts') {
      // the terrain past the edge is ground: plants and rocks stand in it (the float audit)
      o.userData.support = true
    }
    const m = (o as Mesh).material as Material | Material[] | undefined
    if (!m) {
      return
    }
    for (const mat of Array.isArray(m) ? m : [m]) {
      if (!seen.has(mat) && (mat as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial) {
        seen.add(mat)
        withCloudShadow(mat)
        if (mat.name === 'town-windows') {
          withInterior(mat, 'glass', inside)
        } else {
          withInterior(mat, BOARDS.has(mat.name) ? 'boards' : 'surface', inside)
        }
      }
    }
  })
}

/** The Frontier's atmosphere: sky dome, haze, cloud shadows on town surfaces, wind. */
export class Wilds {
  readonly sky: Sky
  private readonly scene: Scene
  private readonly weeds: Roller[] = []

  constructor(scene: Scene, tier: string) {
    this.scene = scene
    this.sky = new Sky(scene, tier === 'high' || tier === 'medium' ? 1 : 0)
  }

  /** Set the time of day's sky and haze; the sun is the scene's own key-light direction. */
  apply(p: Preset, sun: Vector3): void {
    this.sky.set({
      zenith: p.zenith,
      horizon: p.fog,
      sunDir: sun,
      sunColor: new Color().copy(p.sunColor),
      sunGlow: p.sunGlow,
      stars: p.stars,
      moon: p.moon,
    })
    ATMOS.atmCover.value = p.clouds
    ATMOS.atmShadowK.value = p.cloudShadow
    ATMOS.atmGust.value = 0.7
    const ud = this.scene.userData
    ud.owHaze = p.haze
    ud.owRays = p.rays
  }

  tick(dt: number): void {
    tickAtmos(dt)
    for (const t of this.weeds) {
      t.update(dt)
    }
  }

  /** A few tumbleweeds bowling along downwind outside the square (never through the town). */
  roll(layout: TownLayout): void {
    const geo = tumbleweedGeometry()
    const mat = new MeshStandardMaterial({ color: 0x8a_6a_42, roughness: 1 })
    mat.userData.procedural = true
    const s = layout.size
    // lanes: on the bench north of the creek, and out past the west and south edges
    const lanes: Lane[] = [
      { x0: -30, x1: s + 30, z: layout.creek.z - 9, alongX: true },
      { x0: -30, x1: s + 30, z: s + 9, alongX: true },
      { x0: -30, x1: s + 30, z: -12, alongX: false },
    ]
    for (const [i, lane] of lanes.entries()) {
      const m = new Mesh(geo, mat)
      m.name = 'tumbleweed'
      this.scene.add(m)
      this.weeds.push(new Roller(m, lane, layout, i * 23))
    }
  }
}

interface Lane {
  x0: number
  x1: number
  /** The lane's fixed coordinate (z when it runs along x, x otherwise). */
  z: number
  alongX: boolean
}

/** One tumbleweed rolling a lane on the wind, bouncing over the terrain, then round again. */
class Roller {
  private readonly mesh: Mesh
  private readonly lane: Lane
  private readonly layout: TownLayout
  private t: number
  private phase = 0

  constructor(mesh: Mesh, lane: Lane, layout: TownLayout, start: number) {
    this.mesh = mesh
    this.lane = lane
    this.layout = layout
    this.t = start
    mesh.scale.setScalar(0.9 + (start % 7) * 0.08)
  }

  update(dt: number): void {
    const speed = 2.2 + 1.4 * ATMOS.atmGust.value
    const len = this.lane.x1 - this.lane.x0
    this.t = (this.t + speed * dt) % len
    this.phase += dt
    const a = this.lane.x0 + this.t
    const side = this.lane.z + Math.sin(this.phase * 0.4) * 2
    const x = this.lane.alongX ? a : side
    const z = this.lane.alongX ? side : a
    const r = 0.38 * this.mesh.scale.x
    const bounce = Math.abs(Math.sin(this.t * 0.8)) * 0.4
    this.mesh.position.set(x, terrainMeshHeight(this.layout, x, z) + r + bounce, z)
    if (this.lane.alongX) {
      this.mesh.rotation.z -= (speed * dt) / r
    } else {
      this.mesh.rotation.x += (speed * dt) / r
    }
  }
}
