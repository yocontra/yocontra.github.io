/** Far hats share the near material response and preserve their defining catalog detail. */
import {
  BufferAttribute,
  BufferGeometry,
  type Color,
  InstancedMesh,
  type Matrix4,
  type Mesh,
} from 'three'
import type { HatKey } from '../../../data/outlaws.ts'
import type { HatDetail } from '../../../scene/hat-detail.ts'
import { makeHat } from '../../../scene/hats.ts'
import { lodGeometry } from '../../../scene/lod.ts'
import { characterMaterial } from '../../../scene/shade.ts'

const FAR_HAT_TRIS = 300

/** One instanced mesh per hat and detail variant, with felt tinted per rider. */
export class VatHats {
  private stopped = false
  private isStopped(): boolean {
    return this.stopped
  }
  readonly meshes = new Map<string, InstancedMesh>()
  private readonly capacity: number
  private readonly root: { add: (o: InstancedMesh) => void }

  constructor(root: { add: (o: InstancedMesh) => void }, capacity: number) {
    this.root = root
    this.capacity = capacity
  }

  mesh(key: HatKey, detail: HatDetail | undefined): InstancedMesh {
    const variant = `${key}/${detail ?? ''}`
    const have = this.meshes.get(variant)
    if (have) {
      return have
    }
    const g = makeHat(key, 0xff_ff_ff, { detail })
    const meshes: Mesh[] = []
    g.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh) {
        meshes.push(o as Mesh)
      }
    })
    const m = meshes[0]
    // mesh-local: VatBake.hatLocal already carries the fitted scale
    const geo = m ? m.geometry.clone() : new BufferGeometry()
    const tint = new Float32Array(geo.getAttribute('position').count)
    const colors = geo.getAttribute('color')
    for (let i = 0; i < tint.length; i++) {
      const spread =
        Math.abs(colors.getX(i) - colors.getY(i)) + Math.abs(colors.getY(i) - colors.getZ(i))
      tint[i] = spread < 1e-5 ? 1 : 0
    }
    geo.setAttribute('hatTintMask', new BufferAttribute(tint, 1))
    const mat = characterMaterial({ value: 0 }, 'FarFelt', { value: 0 })
    const baseShader = mat.onBeforeCompile
    mat.onBeforeCompile = (shader, renderer) => {
      baseShader.call(mat, shader, renderer)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float hatTintMask;')
        .replace('#include <color_vertex>', '')
        .replace(
          'vStyTint = color;',
          `vStyTint = color;
#ifdef USE_INSTANCING_COLOR
vStyTint *= mix(vec3(1.0), instanceColor, hatTintMask);
#endif`,
        )
        .replace('vStyY = (modelMatrix * vec4(transformed, 1.0)).y;', 'vStyY = 2.0;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '')
    }
    mat.customProgramCacheKey = () => 'ow-far-hat2'

    const im = new InstancedMesh(geo, mat, this.capacity)
    im.count = 0
    im.frustumCulled = false
    // a far rider's hat is a few pixels across: the lathe's ~3.5k triangles drop to a few hundred
    lodGeometry(geo, `hat:${variant}:far`, FAR_HAT_TRIS)
      .then((lod) => {
        if (this.isStopped()) {
          lod.dispose()
        } else {
          im.geometry.dispose()
          im.geometry = lod
        }
      })
      .catch(() => undefined)
    this.meshes.set(variant, im)
    this.root.add(im)
    return im
  }

  dispose(): void {
    this.stopped = true
    for (const mesh of this.meshes.values()) {
      mesh.removeFromParent()
      mesh.dispose()
      mesh.geometry.dispose()
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        material.dispose()
      }
    }
    this.meshes.clear()
  }

  reset(): void {
    for (const m of this.meshes.values()) {
      m.count = 0
    }
  }

  push(key: HatKey, matrix: Matrix4, color: Color, detail?: HatDetail): void {
    const m = this.mesh(key, detail)
    const i = m.count++
    m.setMatrixAt(i, matrix)
    m.setColorAt(i, color)
  }

  commit(): void {
    for (const m of this.meshes.values()) {
      m.instanceMatrix.needsUpdate = true
      if (m.instanceColor) {
        m.instanceColor.needsUpdate = true
      }
    }
  }
}
