// biome-ignore-all lint/complexity/useMaxParams: geometry/audio builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: class fields are flags mutated from outside the method; Biome narrows them to their literal initializer
import {
  Box3,
  type BufferGeometry,
  Euler,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export interface Part {
  geometry: BufferGeometry
  material: Material
}

export interface PropDef {
  /** The kit scene it came from (the float audit names pieces by it). */
  name: string
  parts: Part[]
  size: Vector3
}

/** One placed piece inside a merged mesh: its vertex range (the float audit reads these). */
export interface PieceRange {
  name: string
  start: number
  count: number
}

function findScene(gltf: GLTF, name: string): Object3D | null {
  return gltf.scenes.find((s) => s.name === name) ?? null
}

/**
 * Bake a named scene from the merged props GLB (cached: the geometry is shared, never mutate it) into geometry normalised so its
 * largest (or given-axis) dimension equals `size`, resting on y=0 and centred.
 */
export function propDef(
  gltf: GLTF,
  name: string,
  size: number,
  axis: 'x' | 'y' | 'z' | 'max' = 'max',
  native = false,
): PropDef | null {
  const key = `${name}|${size}|${axis}|${native}`
  const cache = defs.get(gltf) ?? new Map<string, PropDef | null>()
  defs.set(gltf, cache)
  if (cache.has(key)) {
    return cache.get(key) ?? null
  }
  const def = makeDef(gltf, name, size, axis, native)
  cache.set(key, def)
  return def
}

const defs = new WeakMap<GLTF, Map<string, PropDef | null>>()

/**
 * Native kit pieces whose origin isn't where the builders assume. The Medieval Village door leaves
 * hinge at their origin (x -0.05..1.07) while the frame is centred, so every door hung half outside
 * its frame; shift them so x is centred like the frame. (tools/build-props.ts keeps the kit's own
 * origins; this is the one place that corrects them.)
 */
const KIT_PIVOT: Record<string, readonly [number, number, number]> = {
  k_door: [-0.513, 0, 0],
  k_door_plank: [-0.513, 0, 0],
  k_door_braced: [-0.513, 0, 0],
}

/**
 * The GLB's quantized meshes (KHR_mesh_quantization: rock, hay, cactus, cart...) keep positions as
 * normalized Int16 in -1..1 with the scale on the node. Baking a transform into that array wraps
 * every vertex past 1 m round to the other side (a 1.3 m hay bale came out folded through the
 * ground), so positions go to Float32 before anything is baked in.
 */
function dequantized(g: BufferGeometry): BufferGeometry {
  const pos = g.getAttribute('position')
  if (pos && (pos.normalized || !(pos.array instanceof Float32Array))) {
    const out = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      out[i * 3] = pos.getX(i)
      out[i * 3 + 1] = pos.getY(i)
      out[i * 3 + 2] = pos.getZ(i)
    }
    g.setAttribute('position', new Float32BufferAttribute(out, 3))
  }
  return g
}

function makeDef(
  gltf: GLTF,
  name: string,
  size: number,
  axis: 'x' | 'y' | 'z' | 'max',
  native: boolean,
): PropDef | null {
  const scene = findScene(gltf, name)
  if (!scene) {
    return null
  }
  scene.updateMatrixWorld(true)
  const box = new Box3().setFromObject(scene)
  const dims = box.getSize(new Vector3())
  const ref = axis === 'max' ? Math.max(dims.x, dims.y, dims.z) : dims[axis]
  const k = size / Math.max(1e-6, ref)
  const center = box.getCenter(new Vector3())
  // native: the kit's own metres and origin (a door's foot, a window's wall plane)
  const pivot = KIT_PIVOT[name]
  const fix = native
    ? new Matrix4().makeTranslation(pivot?.[0] ?? 0, pivot?.[1] ?? 0, pivot?.[2] ?? 0)
    : new Matrix4()
        .makeScale(k, k, k)
        .multiply(new Matrix4().makeTranslation(-center.x, -box.min.y, -center.z))
  const parts: Part[] = []
  scene.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) {
      return
    }
    const g = dequantized(m.geometry.clone())
    g.applyMatrix4(new Matrix4().multiplyMatrices(fix, m.matrixWorld))
    g.computeBoundingSphere()
    const mat = Array.isArray(m.material) ? m.material[0] : m.material
    if (mat) {
      parts.push({ geometry: g, material: mat })
    }
  })
  return { name, parts, size: native ? dims : dims.multiplyScalar(k) }
}

export function placeMatrix(
  x: number,
  y: number,
  z: number,
  ry: number,
  s = 1,
  rx = 0,
  rz = 0,
): Matrix4 {
  return new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromEuler(new Euler(rx, ry, rz)),
    new Vector3(s, s, s),
  )
}

/** One InstancedMesh per material part; matrices frozen. */
export function instance(
  def: PropDef,
  mats: Matrix4[],
  parent: Object3D,
  shadow = true,
  capacity?: number,
): InstancedMesh[] {
  const out: InstancedMesh[] = []
  const cap = Math.max(capacity ?? mats.length, 1)
  for (const p of def.parts) {
    const im = new InstancedMesh(p.geometry, p.material, cap)
    mats.forEach((m, i) => {
      im.setMatrixAt(i, m)
    })
    im.count = mats.length
    im.castShadow = shadow
    im.receiveShadow = true
    im.matrixAutoUpdate = false
    im.updateMatrix()
    im.computeBoundingSphere()
    // Instances are scattered widely; skip per-mesh culling.
    im.frustumCulled = false
    im.name = def.name
    parent.add(im)
    out.push(im)
  }
  return out
}

/** A plain (non-instanced) object from a prop def, e.g. a gun to attach to a hand. */
export function propObject(def: PropDef): Group {
  const g = new Group()
  for (const p of def.parts) {
    const m = new Mesh(p.geometry, p.material)
    m.castShadow = true
    g.add(m)
  }
  return g
}

/** The loaded props library (engine/assets.ts sets it), for builders constructed without assets. */
let library: GLTF | null = null

export function setPropsLibrary(g: GLTF): void {
  library = g
}

export function propsLibrary(): GLTF | null {
  return library
}

/**
 * Merge many placed props into one static mesh per material (the kit props all share one
 * material, so a whole street of doors, windows and benches is one draw). `swap` replaces a
 * material (e.g. the kit glass by the street's night-lit window material).
 */
export function mergePlaced(
  placed: readonly { def: PropDef; at: Matrix4 }[],
  parent: Object3D,
  swap: ReadonlyMap<string, Material> = new Map(),
  shadow = true,
): Mesh[] {
  const groups = new Map<Material, { geos: BufferGeometry[]; pieces: PieceRange[] }>()
  for (const { def, at } of placed) {
    for (const p of def.parts) {
      const mat = swap.get(p.material.name) ?? p.material
      const g = p.geometry.clone().applyMatrix4(at)
      const list = groups.get(mat) ?? { geos: [], pieces: [] }
      const last = list.pieces.at(-1)
      const start = last ? last.start + last.count : 0
      list.geos.push(g)
      list.pieces.push({ name: def.name, start, count: g.getAttribute('position').count })
      groups.set(mat, list)
    }
  }
  const out: Mesh[] = []
  for (const [mat, list] of groups) {
    const geo = mergeGeometries(list.geos, false)
    if (!geo) {
      continue
    }
    const m = new Mesh(geo, mat)
    m.name = 'kit'
    m.userData.pieces = list.pieces
    m.castShadow = shadow
    m.receiveShadow = true
    m.matrixAutoUpdate = false
    m.updateMatrix()
    parent.add(m)
    out.push(m)
  }
  return out
}
