// biome-ignore-all lint/complexity/useMaxParams: geometry/audio builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
import { Box3, type InstancedMesh, Matrix4, type Object3D, Vector3 } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Rng } from '../ffa/sim/rng.ts'
import { instance, type PropDef, placeMatrix, propDef } from './props.ts'
import { AWNING, deckAt, LANTERNS, STREET } from './street.ts'

/** The street is dressed the same on every load (the float audit and screenshots depend on it). */
const DRESSING_SEED = 0x0d_e5_51_e7
/** Clearance kept between two props' footprints, m. */
const PROP_GAP = 0.04

/** A placed prop's footprint on the ground plane: a circle that bounds it at any yaw. */
interface Footprint {
  x: number
  z: number
  r: number
}

/** Bounding radius of a prop's footprint at scale `s` (half its XZ diagonal). */
const footprintRadius = (def: PropDef | null, s: number, fallback: number): number =>
  def ? (Math.hypot(def.size.x, def.size.z) / 2) * s : fallback * s

/**
 * Nudge (x, z) along the boardwalk (z) until its footprint clears every placed one, trying
 * alternately further either way. Returns null if nothing within 1.5 m is clear.
 */
function clearSpot(
  placed: readonly Footprint[],
  x: number,
  z: number,
  radius: number,
): [number, number] | null {
  for (let step = 0; step <= 30; step++) {
    const dz = (step % 2 === 0 ? 1 : -1) * Math.ceil(step / 2) * 0.05
    const zz = z + dz
    if (placed.every((f) => Math.hypot(f.x - x, f.z - zz) >= f.r + radius + PROP_GAP)) {
      return [x, zz]
    }
  }
  return null
}

/**
 * A coffin stood on end in front of the undertaker: the kit coffin lies flat (long along Z, lid up,
 * 2:3 wide), so narrow it to a coffin's proportions, stand it up with the lid to the street, and
 * seat its foot on the floor and its back clear of the window sills.
 */
function coffinAt(def: PropDef, z: number): Matrix4 {
  const turn = new Matrix4()
    .makeRotationY(-Math.PI / 2)
    .multiply(new Matrix4().makeRotationX(-Math.PI / 2))
    .multiply(new Matrix4().makeScale(0.5, 1, 1))
  const box = new Box3()
  for (const p of def.parts) {
    p.geometry.computeBoundingBox()
    if (p.geometry.boundingBox) {
      box.union(p.geometry.boundingBox)
    }
  }
  box.applyMatrix4(turn)
  // the undertaker's false front is at -(half + boardwalk - 0.25); its windows stand 0.42 proud
  const back = -(STREET.half + STREET.boardwalk) + 0.25 + 0.43
  const x = back - box.min.x
  const at = new Vector3(x, deckAt(back + 0.4, z) - box.min.y, z)
  return new Matrix4().makeTranslation(at.x, at.y, at.z).multiply(turn)
}

/** Instanced props around the street. Returns the coffin instances (count changes with kills). */
export function dressStreet(props: GLTF, parent: Object3D): { coffins: InstancedMesh[] } {
  const add = (
    name: string,
    size: number,
    mats: Matrix4[],
    shadow = true,
    axis: 'max' | 'y' = 'max',
    cap?: number,
  ) => {
    const def = propDef(props, name, size, axis)
    return def ? instance(def, mats, parent, shadow, cap) : []
  }

  const rng = new Rng(DRESSING_SEED)
  const r = (a: number, b: number) => rng.range(a, b)
  const barrelDef = propDef(props, 'barrel', 1.0, 'y')
  const crateDef = propDef(props, 'crate', 0.85, 'y')

  // barrels and crates on and by the boardwalks, seeded and never overlapping (a crate that would
  // sit inside a barrel slides along the boardwalk until both footprints clear)
  const barrels: Matrix4[] = []
  const crates: Matrix4[] = []
  const placed: Footprint[] = []
  const put = (
    into: Matrix4[],
    def: PropDef | null,
    x: number,
    z: number,
    ry: number,
    s: number,
    onDeck: boolean,
  ) => {
    const radius = footprintRadius(def, s, 0.5)
    const spot = clearSpot(placed, x, z, radius)
    if (!spot) {
      return
    }
    const [px, pz] = spot
    placed.push({ x: px, z: pz, r: radius })
    into.push(placeMatrix(px, onDeck ? deckAt(px, pz) : 0, pz, ry, s))
  }
  // every spot on a boardwalk (none in the gaps between buildings, where they stood on air at deck
  // height), clear of the window sills, and set on the floor under it by deckAt
  const spots: [number, number][] = [
    [10.2, -14.5],
    [10.3, -13.6],
    [-10.3, 9.6],
    [10.3, 19.9],
    [-10.3, -24],
    [9.8, -26.4],
    [-9.9, 22.9],
    [10.1, 30.4],
    [-10.2, -35.4],
  ]
  for (const [x, z] of spots) {
    put(barrels, barrelDef, x, z, r(0, 6), r(0.95, 1.1), true)
  }
  put(barrels, barrelDef, -8.3, -15.5, 0.4, 1, false)
  put(barrels, barrelDef, 8.4, 25.2, 1.1, 1, false)
  for (const [x, z] of [
    [10.15, -12.6],
    [-10.15, 10.4],
    [10.2, 23.8],
    [-10.2, 25.8],
    [10.15, -31.2],
    [-10.15, -23],
  ] as const) {
    put(crates, crateDef, x, z, r(-0.3, 0.3), r(0.9, 1.1), true)
  }
  // on the street, clear of the boardwalk's edge (x 9)
  put(crates, crateDef, 8.3, 26.2, 0.3, 1, false)
  add('barrel', 1.0, barrels, true, 'y')
  add('crate', 0.85, crates, true, 'y')
  // hay at the livery
  add(
    'hay',
    1.3,
    [placeMatrix(8.3, 0, -42, 0.2), placeMatrix(8.2, 0, -44, 1.3), placeMatrix(-8.3, 0, 35, 0.6)],
    true,
    'y',
  )
  // broken cart near the end of the street
  add('cart', 4.2, [placeMatrix(-7.1, 0, -30, 0.5), placeMatrix(7, 0, 42, 2.2)])
  // cacti and rocks out in the desert and at the open end
  const cacti: Matrix4[] = []
  for (let i = 0; i < 26; i++) {
    const side = rng.next() < 0.5 ? -1 : 1
    const z = r(-140, 60)
    const x = z < -60 ? r(-60, 60) : side * r(24, 80)
    if (z < -55 && Math.abs(x) < 10) {
      continue
    }
    cacti.push(placeMatrix(x, 0, z, r(0, 6), r(2.5, 4.6), 0, 0))
  }
  add('cactus', 1, cacti, false, 'y')
  const rocks: Matrix4[] = []
  for (let i = 0; i < 14; i++) {
    const side = rng.next() < 0.5 ? -1 : 1
    rocks.push(placeMatrix(side * r(28, 90), -0.2, r(-150, 80), r(0, 6), r(2, 7)))
  }
  add('rock', 1, rocks, false, 'y')
  // fence runs out past the stable
  const fence: Matrix4[] = []
  for (let i = 0; i < 6; i++) {
    fence.push(placeMatrix(22, 0, -52 + i * 5.9, Math.PI / 2))
  }
  for (let i = 0; i < 5; i++) {
    fence.push(placeMatrix(-22, 0, -48 + i * 5.9, Math.PI / 2))
  }
  add('fence', 5.9, fence, true, 'max')
  // hanging lanterns at the lantern lights
  add(
    'lantern',
    0.45,
    // hung from the awning: the ring touches its underside
    LANTERNS.map(([x, z]) => placeMatrix(x, AWNING - 0.45, z, 0)),
    false,
    'y',
  )
  // coffins stood against the undertaker's front, one per kill
  const coffinMats: Matrix4[] = []
  const coffinDef = propDef(props, 'coffin', 1.9, 'max')
  for (let i = 0; coffinDef && i < 18; i++) {
    coffinMats.push(coffinAt(coffinDef, -11.1 + i * 0.68))
  }
  const coffins = add('coffin', 1.9, coffinMats, true, 'max', 18)
  for (const c of coffins) {
    c.count = 2
  }
  return { coffins }
}
