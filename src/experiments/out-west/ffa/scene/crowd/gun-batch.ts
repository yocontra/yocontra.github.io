/**
 * Every skinned rider's revolver, drawn as one instanced draw per gun part (steel, grip) for the
 * whole crowd instead of three draws per rider. Each rider keeps his own gun object (it rides his
 * holster or his hand, and the muzzle and the draw read it); its meshes are hidden, and their
 * world matrices are copied into the instances once the scene's matrices are current for the
 * frame (`sync`, from the scene's `onBeforeRender`, before the renderer culls and uploads).
 */
import { InstancedMesh, type Material, Matrix4, type Mesh, type Object3D } from 'three'

interface Part {
  mesh: InstancedMesh
}

const tmp = new Matrix4()
const inv = new Matrix4()

export class GunBatch {
  private parts: Part[] | null = null
  private readonly guns: Object3D[] = []
  private readonly capacity: number
  private readonly root: Object3D

  constructor(root: Object3D, capacity: number) {
    this.root = root
    this.capacity = capacity
  }

  /** Hand a rider's gun to the batch: its meshes stop drawing themselves. */
  adopt(gun: Object3D): void {
    const meshes = meshesOf(gun)
    if (!this.parts) {
      this.parts = meshes.map((m) => {
        const im = new InstancedMesh(m.geometry, m.material as Material, this.capacity)
        im.count = 0
        im.frustumCulled = false
        im.castShadow = true
        this.root.add(im)
        return { mesh: im }
      })
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
  sync(): void {
    const parts = this.parts
    if (!parts) {
      return
    }
    for (const p of parts) {
      p.mesh.count = 0
    }
    this.root.updateWorldMatrix(true, false)
    inv.copy(this.root.matrixWorld).invert()
    for (const g of this.guns) {
      const meshes = meshesOf(g)
      for (let k = 0; k < parts.length && k < meshes.length; k++) {
        const part = parts[k]
        const m = meshes[k]
        if (!(part && m)) {
          continue
        }
        tmp.multiplyMatrices(inv, m.matrixWorld)
        part.mesh.setMatrixAt(part.mesh.count++, tmp)
      }
    }
    for (const p of parts) {
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
