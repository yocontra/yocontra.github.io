/**
 * The town's sky on the view model's guns. The view model is its own scene, lit by its own lights
 * (ffa/client/viewmodel.ts), with no environment: a metal there (blued steel, case colour, brass,
 * all metalness 1) mirrors nothing but the sun's highlight and reads black. Its guns draw with
 * twins of their world materials that carry the world's environment (the town probe,
 * engine/probe.ts), turned into the lens's frame every frame, so a barrel in the hands shines
 * like the same barrel on a rider in the street. The hands keep the view model's own lights.
 */
import {
  Euler,
  type Material,
  MeshStandardMaterial,
  type Object3D,
  type Quaternion,
  type Texture,
} from 'three'

/** The world materials the guns draw with (engine/assets.ts, scene/gunsmith.ts). */
const GUN_MATERIAL = /^Gun/u

const euler = new Euler()

export class VmSky {
  private readonly twins = new Map<Material, MeshStandardMaterial>()
  private env: Texture | null = null

  /** Swap every gun material under `root` for its view-model twin. */
  adopt(root: Object3D): void {
    root.traverse((o) => {
      const m = o as Object3D & { material?: Material | Material[] }
      if (m.material instanceof MeshStandardMaterial && GUN_MATERIAL.test(m.material.name)) {
        m.material = this.twin(m.material)
      }
    })
  }

  private twin(src: MeshStandardMaterial): MeshStandardMaterial {
    let t = this.twins.get(src)
    if (!t) {
      t = src.clone()
      t.onBeforeCompile = src.onBeforeCompile
      t.customProgramCacheKey = src.customProgramCacheKey
      t.envMap = this.env
      this.twins.set(src, t)
    }
    return t
  }

  /**
   * Per frame: the world's environment and its strength, and the world camera's turn (the view
   * model's space is the lens's, so a reflection there is turned by it to find the town).
   */
  update(env: Texture | null, intensity: number, camQ: Quaternion): void {
    // three negates the rotation's angles (it turns the environment, not the lookup): hand it
    // the camera's turn negated, so the lookup is turned by the camera's own
    euler.setFromQuaternion(camQ, 'XYZ')
    const changed = env !== this.env
    this.env = env
    for (const t of this.twins.values()) {
      if (changed) {
        // in or out of an environment is another program; a new capture is only a new texture
        if ((t.envMap === null) !== (env === null)) {
          t.needsUpdate = true
        }
        t.envMap = env
      }
      t.envMapIntensity = intensity
      t.envMapRotation.set(-euler.x, -euler.y, -euler.z, 'XYZ')
    }
  }
}
