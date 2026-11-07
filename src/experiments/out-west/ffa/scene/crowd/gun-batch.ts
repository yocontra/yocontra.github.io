/** Finished guns are instanced by geometry/material, preserving each cosmetic with bounded draws. */
import {
  type BufferGeometry,
  type Camera,
  InstancedMesh,
  type Material,
  Matrix4,
  type Mesh,
  type Object3D,
  Vector3,
} from 'three'
import { actorMaterialSource } from '../../../scene/actor-template.ts'
import { type RevolverLook, revolverGeometry } from '../../../scene/revolver.ts'

interface Part {
  mesh: InstancedMesh
}
export interface FarLevel {
  geometry: BufferGeometry
  distance: number
}
const tmp = new Matrix4()
const inv = new Matrix4()
const eye = new Vector3()
const pos = new Vector3()

export class GunBatch {
  private readonly parts: Part[] = []
  private readonly byGeometry = new Map<BufferGeometry, Map<Material, Part>>()
  private readonly nearPart = new WeakMap<Mesh, Part>()
  private readonly farPart = new WeakMap<Object3D, Part>()
  private readonly guns: Object3D[] = []
  private readonly capacity: number
  private readonly root: Object3D
  private readonly far: FarLevel | null

  constructor(root: Object3D, capacity: number, far: FarLevel | null = null) {
    this.root = root
    this.capacity = capacity
    this.far = far
  }

  private part(geometry: BufferGeometry, material: Material): Part {
    let finishes = this.byGeometry.get(geometry)
    if (!finishes) {
      finishes = new Map()
      this.byGeometry.set(geometry, finishes)
    }
    const have = finishes.get(material)
    if (have) {
      return have
    }
    const mesh = new InstancedMesh(geometry, material, this.capacity)
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.character = true
    this.root.add(mesh)
    const made = { mesh }
    finishes.set(material, made)
    this.parts.push(made)
    return made
  }

  adopt(gun: Object3D): void {
    const meshes = meshesOf(gun)
    for (const mesh of meshes) {
      this.nearPart.set(
        mesh,
        this.part(mesh.geometry, actorMaterialSource(mesh.material as Material)),
      )
      mesh.visible = false
    }
    const only = meshes.length === 1 ? meshes[0] : undefined
    if (this.far && only) {
      const info = gun.userData.revolver as { size: number; look?: RevolverLook } | undefined
      const geo = info ? revolverGeometry(info.size, 'lo', info.look) : this.far.geometry
      this.farPart.set(gun, this.part(geo, actorMaterialSource(only.material as Material)))
    }
  }

  reset(): void {
    this.guns.length = 0
  }

  push(gun: Object3D): void {
    if (this.guns.length < this.capacity) {
      this.guns.push(gun)
    }
  }

  sync(camera?: Camera): void {
    for (const part of this.parts) {
      part.mesh.count = 0
    }
    if (camera) {
      eye.setFromMatrixPosition(camera.matrixWorld)
    }
    const far2 = this.far && camera ? this.far.distance ** 2 : Number.POSITIVE_INFINITY
    this.root.updateWorldMatrix(true, false)
    inv.copy(this.root.matrixWorld).invert()
    for (const gun of this.guns) {
      const far = this.farPart.get(gun)
      if (far && pos.setFromMatrixPosition(gun.matrixWorld).distanceToSquared(eye) > far2) {
        tmp.multiplyMatrices(inv, gun.matrixWorld)
        far.mesh.setMatrixAt(far.mesh.count++, tmp)
        continue
      }
      for (const mesh of meshesOf(gun)) {
        const part = this.nearPart.get(mesh)
        if (part) {
          tmp.multiplyMatrices(inv, mesh.matrixWorld)
          part.mesh.setMatrixAt(part.mesh.count++, tmp)
        }
      }
    }
    for (const part of this.parts) {
      part.mesh.instanceMatrix.needsUpdate = true
    }
  }
}

const cache = new WeakMap<Object3D, Mesh[]>()
function meshesOf(gun: Object3D): Mesh[] {
  const have = cache.get(gun)
  if (have) {
    return have
  }
  const found: Mesh[] = []
  gun.traverse((o) => {
    if ((o as Partial<Mesh>).isMesh === true) {
      found.push(o as Mesh)
    }
  })
  cache.set(gun, found)
  return found
}
