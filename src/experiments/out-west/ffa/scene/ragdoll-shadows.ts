/** One bounded contact-shadow draw follows actual physical corpses on tiers without shadows. */
import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  type Texture,
  Vector3,
} from 'three'
import { markRole, ROLE } from '../../scene/roles.ts'
import { contactShadowTexture } from './contact-shadow.ts'
import type { CorpseGround } from './crowd/corpse-rig.ts'
import type { CorpsePhysics } from './ragdoll-body.ts'

const CAPACITY = 32
const UP = new Vector3(0, 1, 0)

export class CorpseShadows {
  readonly mesh: InstancedMesh<PlaneGeometry, MeshBasicMaterial>
  private readonly alpha = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1)
  private readonly ground: CorpseGround
  private readonly matrix = new Matrix4()
  private readonly position = new Vector3()
  private readonly scale = new Vector3()
  private readonly normal = new Vector3()
  private readonly rotation = new Quaternion()
  private readonly tilt = new Quaternion()

  constructor(root: Object3D, ground: CorpseGround, texture: Texture = contactShadowTexture()) {
    this.ground = ground
    const geometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
    geometry.setAttribute('shadeAlpha', this.alpha)
    this.alpha.setUsage(DynamicDrawUsage)
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })
    material.name = 'corpse-contact-shadow'
    material.onBeforeCompile = (shader) => {
      shader.vertexShader =
        `attribute float shadeAlpha; varying float vShadeAlpha;\n${shader.vertexShader}`.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvShadeAlpha = shadeAlpha;',
        )
      shader.fragmentShader = `varying float vShadeAlpha;\n${shader.fragmentShader}`.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.a *= vShadeAlpha;',
      )
    }
    material.customProgramCacheKey = () => 'corpse-contact-shadow1'
    this.mesh = new InstancedMesh(geometry, material, CAPACITY)
    this.mesh.name = 'physical-corpse-contact-shadows'
    markRole(this.mesh, ROLE.Decal)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1
    root.add(this.mesh)
  }

  update(corpses: readonly CorpsePhysics[]): void {
    this.mesh.count = 0
    if (!this.mesh.visible) {
      return
    }
    for (const corpse of corpses) {
      if (!corpse.visible || this.mesh.count >= CAPACITY) {
        continue
      }
      const center = corpse.center()
      const support = this.ground(center.x, center.y, center.z)
      const opacity = Math.max(0, Math.min(1, 1 - Math.max(0, center.y - support - 0.4) / 2))
      if (!Number.isFinite(support) || opacity <= 0) {
        continue
      }
      const head = corpse.parts.find((part) => part.link.key === 'Head')?.body.interpolatedPosition
      const hips = corpse.parts.find((part) => part.link.key === 'Hips')?.body.interpolatedPosition
      const dx = head && hips ? head.x - hips.x : 0
      const dz = head && hips ? head.z - hips.z : 0
      const left = this.ground(center.x - 0.1, center.y, center.z)
      const right = this.ground(center.x + 0.1, center.y, center.z)
      const back = this.ground(center.x, center.y, center.z - 0.1)
      const front = this.ground(center.x, center.y, center.z + 0.1)
      // Never tilt across a roof/deck edge down to a different storey.
      this.normal
        .set(
          Math.abs(left - right) < 0.3 ? (left - right) / 0.2 : 0,
          1,
          Math.abs(back - front) < 0.3 ? (back - front) / 0.2 : 0,
        )
        .normalize()
      this.tilt.setFromUnitVectors(UP, this.normal)
      this.rotation.setFromAxisAngle(UP, Math.atan2(dx, dz)).premultiply(this.tilt)
      this.position.set(center.x, support + 0.012, center.z)
      this.scale.set(0.85, 1, Math.max(1, Math.min(2.2, Math.hypot(dx, dz) + 0.8)))
      this.matrix.compose(this.position, this.rotation, this.scale)
      this.alpha.setX(this.mesh.count, opacity)
      this.mesh.setMatrixAt(this.mesh.count++, this.matrix)
    }
    this.alpha.needsUpdate = true
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.map?.dispose()
    this.mesh.material.dispose()
  }
}
