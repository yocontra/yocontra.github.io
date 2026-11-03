// biome-ignore-all lint/complexity/useMaxParams: geometry/audio builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: class fields are flags mutated from outside the method; Biome narrows them to their literal initializer
import {
  Box3,
  type BufferGeometry,
  Euler,
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
  parts: Part[]
  size: Vector3
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
  const fix = native
    ? new Matrix4()
    : new Matrix4()
        .makeScale(k, k, k)
        .multiply(new Matrix4().makeTranslation(-center.x, -box.min.y, -center.z))
  const parts: Part[] = []
  scene.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) {
      return
    }
    const g = m.geometry.clone()
    g.applyMatrix4(new Matrix4().multiplyMatrices(fix, m.matrixWorld))
    g.computeBoundingSphere()
    const mat = Array.isArray(m.material) ? m.material[0] : m.material
    if (mat) {
      parts.push({ geometry: g, material: mat })
    }
  })
  return { parts, size: native ? dims : dims.multiplyScalar(k) }
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
  const groups = new Map<Material, BufferGeometry[]>()
  for (const { def, at } of placed) {
    for (const p of def.parts) {
      const mat = swap.get(p.material.name) ?? p.material
      const g = p.geometry.clone().applyMatrix4(at)
      const list = groups.get(mat) ?? []
      list.push(g)
      groups.set(mat, list)
    }
  }
  const out: Mesh[] = []
  for (const [mat, list] of groups) {
    const geo = mergeGeometries(list, false)
    if (!geo) {
      continue
    }
    const m = new Mesh(geo, mat)
    m.castShadow = shadow
    m.receiveShadow = true
    m.matrixAutoUpdate = false
    m.updateMatrix()
    parent.add(m)
    out.push(m)
  }
  return out
}
