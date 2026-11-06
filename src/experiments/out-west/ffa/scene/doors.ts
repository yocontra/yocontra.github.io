/**
 * Interior doors that swing open as a player walks up and creak when they start moving. Purely
 * cosmetic: the collision grid already leaves the doorway open, so the server never waits on a
 * door. The leaves are one mesh each (vertex-coloured box + panel) under a hinge group.
 */
import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** How close a player must come for a door to swing, metres. */
const OPEN_RADIUS = 2.8
/** How fast a leaf swings, per second. */
const SWING_SPEED = 6
/** Minimum time between creaks from one leaf, seconds. */
const CREAK_GAP = 0.7
const DOOR_WOOD = 0x6a_4c_34
const DOOR_PANEL = 0x7a_56_38

/** One leaf of an interior door, shared by the scene builder and this system. */
export interface DoorSpec {
  /** Hinge world position at the leaf's foot. */
  x: number
  y: number
  z: number
  /** The closed leaf runs along x (true) or z (false). */
  alongX: boolean
  /** +1 if the closed leaf extends in +axis from the hinge. */
  dir: 1 | -1
  length: number
  height: number
  /** Hinge rotation from closed to fully open, radians. */
  swing: number
  /** Centre of the opening, for the creak and the proximity test. */
  cx: number
  cz: number
}

const baseRotation = (d: DoorSpec): number => {
  if (d.alongX) {
    return 0
  }
  return d.dir === 1 ? -Math.PI / 2 : Math.PI / 2
}

/** Tint every vertex of a box a flat colour. */
function tint(geo: BufferGeometry, hex: number): void {
  const c = new Color(hex)
  const n = geo.getAttribute('position').count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r
    col[i * 3 + 1] = c.g
    col[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new Float32BufferAttribute(col, 3))
}

/** A leaf as one mesh: the slab plus its raised panel. */
function leafGeometry(length: number, height: number): BufferGeometry {
  const slab = new BoxGeometry(length, height, 0.055).translate(0, height / 2, 0)
  const panel = new BoxGeometry(length * 0.62, height * 0.62, 0.066).translate(0, height / 2, 0)
  tint(slab, DOOR_WOOD)
  tint(panel, DOOR_PANEL)
  return mergeGeometries([slab, panel]) ?? slab
}

interface Leaf {
  spec: DoorSpec
  group: Group
  mesh: Mesh
  geometry: BufferGeometry
  t: number
  target: number
  cooldown: number
}

export class Doors {
  readonly root = new Group()
  private readonly material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 })
  private readonly leaves: Leaf[] = []
  private time = 0

  constructor(specs: readonly DoorSpec[]) {
    this.root.name = 'interior-doors'
    this.material.userData.procedural = true
    for (const spec of specs) {
      const geometry = leafGeometry(spec.length, spec.height)
      const group = new Group()
      group.position.set(spec.x, spec.y, spec.z)
      group.rotation.y = baseRotation(spec)
      const mesh = new Mesh(geometry, this.material)
      mesh.name = 'k_door_trim'
      mesh.position.x = spec.dir * (spec.length / 2)
      mesh.castShadow = true
      group.add(mesh)
      this.root.add(group)
      this.leaves.push({ spec, group, mesh, geometry, t: 0, target: 0, cooldown: 0 })
    }
  }

  /** Swing nearby doors, and return a creak position on a fresh open or close. */
  update(cx: number, cz: number, dt: number): { x: number; z: number } | null {
    this.time += dt
    let creak: { x: number; z: number } | null = null
    for (const leaf of this.leaves) {
      const near = Math.hypot(cx - leaf.spec.cx, cz - leaf.spec.cz) < OPEN_RADIUS
      const target = near ? 1 : 0
      if (target !== leaf.target) {
        leaf.target = target
        if (this.time >= leaf.cooldown) {
          leaf.cooldown = this.time + CREAK_GAP
          creak ??= { x: leaf.spec.cx, z: leaf.spec.cz }
        }
      }
      leaf.t += (target - leaf.t) * Math.min(1, dt * SWING_SPEED)
      leaf.group.rotation.y = baseRotation(leaf.spec) + leaf.spec.swing * leaf.t
    }
    return creak
  }

  dispose(): void {
    for (const leaf of this.leaves) {
      leaf.geometry.dispose()
    }
    this.material.dispose()
    this.root.removeFromParent()
  }

  attach(parent: Object3D): void {
    parent.add(this.root)
  }
}
