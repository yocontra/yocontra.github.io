/**
 * Every skinned rider's revolver, drawn as one instanced draw per gun part for the whole crowd
 * instead of a draw per rider. Each rider keeps his own gun object (it rides his holster or his
 * hand, and the muzzle and the draw read it); its meshes are hidden, and their world matrices are
 * copied into the instances once the scene's matrices are current for the frame (`sync`, from the
 * scene's `onBeforeRender`, before the renderer culls and uploads).
 *
 * The Peacemaker (scene/revolver.ts) is one part; with a `far` level a gun past its distance from
 * the camera draws the low level of detail instead (one more instanced draw for the whole crowd).
 */
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

interface Part {
  mesh: InstancedMesh
}

/** A gun's low level of detail, drawn past `distance` metres from the camera. */
export interface FarLevel {
  geometry: BufferGeometry
  distance: number
}

const tmp = new Matrix4()
const inv = new Matrix4()
const eye = new Vector3()
const pos = new Vector3()

export class GunBatch {
  private parts: Part[] | null = null
  private farPart: Part | null = null
  private readonly guns: Object3D[] = []
  private readonly capacity: number
  private readonly root: Object3D
  private readonly far: FarLevel | null

  constructor(root: Object3D, capacity: number, far: FarLevel | null = null) {
    this.root = root
    this.capacity = capacity
    this.far = far
  }

  private instanced(geometry: BufferGeometry, material: Material): InstancedMesh {
    const im = new InstancedMesh(geometry, material, this.capacity)
    im.count = 0
    im.frustumCulled = false
    im.castShadow = true
    // each instance rides a rider's hand or holster: a character's, like a gun parented to a bone
    im.userData.character = true
    this.root.add(im)
    return im
  }

  /** Hand a rider's gun to the batch: its meshes stop drawing themselves. */
  adopt(gun: Object3D): void {
    const meshes = meshesOf(gun)
    if (!this.parts) {
      this.parts = meshes.map((m) => ({ mesh: this.instanced(m.geometry, m.material as Material) }))
      const only = meshes.length === 1 ? meshes[0] : undefined
      if (this.far && only) {
        this.farPart = { mesh: this.instanced(this.far.geometry, only.material as Material) }
      }
    }
    for (const m of meshes) {
      m.visible = false
    }
  }

  /** Start a frame's list. */
  reset(): void {
    this.guns.length = 0
  }

  /** This gun is drawn this frame (its rider is drawn and has it out or holstered). */
  push(gun: Object3D): void {
    if (this.guns.length < this.capacity) {
      this.guns.push(gun)
    }
  }

  /** Copy the guns' current world matrices into the instances (scene matrices must be current). */
  sync(camera?: Camera): void {
    const parts = this.parts
    if (!parts) {
      return
    }
    for (const p of parts) {
      p.mesh.count = 0
    }
    const farPart = this.farPart
    if (farPart) {
      farPart.mesh.count = 0
    }
    const far2 = this.far && camera ? this.far.distance ** 2 : Number.POSITIVE_INFINITY
    if (camera) {
      eye.setFromMatrixPosition(camera.matrixWorld)
    }
    this.root.updateWorldMatrix(true, false)
    inv.copy(this.root.matrixWorld).invert()
    for (const g of this.guns) {
      const meshes = meshesOf(g)
      for (let k = 0; k < parts.length && k < meshes.length; k++) {
        const m = meshes[k]
        const near = parts[k]
        if (!(near && m)) {
          continue
        }
        const part =
          farPart && pos.setFromMatrixPosition(m.matrixWorld).distanceToSquared(eye) > far2
            ? farPart
            : near
        tmp.multiplyMatrices(inv, m.matrixWorld)
        part.mesh.setMatrixAt(part.mesh.count++, tmp)
      }
    }
    for (const p of farPart ? [...parts, farPart] : parts) {
      p.mesh.instanceMatrix.needsUpdate = true
    }
  }
}

const cache = new WeakMap<Object3D, Mesh[]>()

/** A gun's meshes, in a stable order (cached: the gun's structure never changes). */
function meshesOf(gun: Object3D): Mesh[] {
  let list = cache.get(gun)
  if (!list) {
    const found: Mesh[] = []
    gun.traverse((o) => {
      if ((o as Partial<Mesh>).isMesh === true) {
        found.push(o as Mesh)
      }
    })
    list = found
    cache.set(gun, list)
  }
  return list
}
