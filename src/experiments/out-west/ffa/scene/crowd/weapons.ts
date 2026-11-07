/** Far weapons retain their type and catalog finish through bounded instanced draws. */
import { type BufferGeometry, InstancedMesh, type Matrix4, type Object3D } from 'three'
import { WEAPON_REVOLVER, WEAPON_RIFLE, WEAPON_SHOTGUN } from '../../../contract/town.ts'
import type { ItemId } from '../../../data/catalog.ts'
import { gunMaterial } from '../../../scene/gunsmith.ts'
import { gunFinish } from '../../../scene/loadout.ts'
import { revolverGeometry } from '../../../scene/revolver.ts'
import { rifleGeometry } from '../../../scene/rifle.ts'
import { shotgunGeometry } from '../shotgun.ts'

export class VatWeapons {
  private readonly meshes = new Map<string, InstancedMesh>()
  private readonly root: Object3D
  private readonly capacity: number
  constructor(root: Object3D, capacity: number) {
    this.root = root
    this.capacity = capacity
  }

  private mesh(kind: number, gun: ItemId | undefined): InstancedMesh {
    const key = `${kind}/${kind === WEAPON_REVOLVER ? (gun ?? 'gun.rusty-six') : ''}`
    const have = this.meshes.get(key)
    if (have) {
      return have
    }
    let geo: BufferGeometry
    if (kind === WEAPON_RIFLE) {
      geo = rifleGeometry('lo')
    } else if (kind === WEAPON_SHOTGUN) {
      geo = shotgunGeometry()
    } else {
      geo = revolverGeometry(0.32, 'lo', gunFinish(gun))
    }
    const mesh = new InstancedMesh(geo, gunMaterial(), this.capacity)
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.receiveShadow = true
    mesh.userData.character = true
    this.root.add(mesh)
    this.meshes.set(key, mesh)
    return mesh
  }

  reset(): void {
    for (const mesh of this.meshes.values()) {
      mesh.count = 0
    }
  }

  push(kind: number, matrix: Matrix4, gun?: ItemId): void {
    const mesh = this.mesh(kind, gun)
    if (mesh.count < mesh.instanceMatrix.count) {
      mesh.setMatrixAt(mesh.count++, matrix)
    }
  }

  commit(): void {
    for (const mesh of this.meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true
    }
  }
}
