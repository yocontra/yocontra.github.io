// biome-ignore-all lint/style/noExcessiveClassesPerFile: the part builder and the instanced herd are one small rig
// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, y, z, size…), mirroring three.js APIs
/**
 * Rigid-part vertex animation for the town's animals, crows and hanging signs: one instanced draw
 * per species, no skeleton. Every vertex carries the part it belongs to and up to two hinges (its
 * own, then its parent's: a horse's head nods on its own hinge and rides the neck's), and the
 * species supplies a GLSL `partAngle(part, t, anim)` that turns each hinge. Placement is the
 * instance matrix; per-instance `anim` (phase plus three free channels the CPU drives: a lunge, a
 * flap, a head toss) and `coat` (the coat colour, on vertices marked as coat) make each one
 * itself.
 */
import {
  type BufferGeometry,
  Color,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** Shared clock for every rig (seconds, advanced by the town). */
export const RIG_TIME = { value: 0 }

/** A hinge: a pivot point and an axis, both in the model's own space. */
export interface Hinge {
  part: number
  pivot: readonly [number, number, number]
  axis: readonly [number, number, number]
}

const NO_HINGE: Hinge = { part: -1, pivot: [0, 0, 0], axis: [1, 0, 0] }

/** Collects shapes tagged with their parts, then merges them into one geometry. */
export class PartBuilder {
  private readonly parts: BufferGeometry[] = []

  /**
   * Add `g` (consumed): coloured `color`, turning on `own` (and `parent` after it). `coat` marks
   * vertices recoloured per instance.
   */
  add(
    g: BufferGeometry,
    color: number,
    own: Hinge = NO_HINGE,
    parent: Hinge = NO_HINGE,
    coat = false,
  ): this {
    const geo = g.index ? g.toNonIndexed() : g
    if (geo !== g) {
      g.dispose()
    }
    geo.deleteAttribute('uv')
    const n = geo.getAttribute('position').count
    const c = new Color(color)
    const fill = (k: number, v: readonly number[]) => {
      const a = new Float32Array(n * k)
      for (let i = 0; i < n; i++) {
        a.set(v, i * k)
      }
      return new Float32BufferAttribute(a, k)
    }
    geo.setAttribute('color', fill(3, [c.r, c.g, c.b]))
    geo.setAttribute('rigA', fill(4, [...own.pivot, own.part]))
    geo.setAttribute('rigAxisA', fill(3, own.axis))
    geo.setAttribute('rigB', fill(4, [...parent.pivot, parent.part]))
    geo.setAttribute('rigAxisB', fill(4, [...parent.axis, coat ? 1 : 0]))
    this.parts.push(geo)
    return this
  }

  build(): BufferGeometry {
    const g = mergeGeometries(this.parts)
    for (const p of this.parts) {
      p.dispose()
    }
    if (!g) {
      throw new Error('critter-rig: nothing to merge')
    }
    g.computeBoundingSphere()
    return g
  }
}

/** Place a shape: scale, then rotate (Euler XYZ), then move. Returns it for chaining. */
export function placed(
  g: BufferGeometry,
  at: readonly [number, number, number],
  rot: readonly [number, number, number] = [0, 0, 0],
  scale: readonly [number, number, number] = [1, 1, 1],
): BufferGeometry {
  const m = new Matrix4().compose(
    new Vector3(...at),
    new Quaternion()
      .setFromAxisAngle(new Vector3(1, 0, 0), rot[0])
      .multiply(
        new Quaternion()
          .setFromAxisAngle(new Vector3(0, 1, 0), rot[1])
          .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), rot[2])),
      ),
    new Vector3(...scale),
  )
  g.applyMatrix4(m)
  return g
}

const RIG_VERTEX = /* glsl */ `
attribute vec4 rigA;
attribute vec3 rigAxisA;
attribute vec4 rigB;
attribute vec4 rigAxisB;
attribute vec4 rigAnim;
attribute vec3 rigCoat;
uniform float rigTime;
varying vec3 vRigP;
vec3 rigTurn(vec3 v, vec3 k, float a) {
  float c = cos(a);
  float s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
`

const RIG_FRAGMENT = /* glsl */ `
varying vec3 vRigP;
float rigHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float rigNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(rigHash(i), rigHash(i + vec3(1, 0, 0)), f.x),
        mix(rigHash(i + vec3(0, 1, 0)), rigHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(rigHash(i + vec3(0, 0, 1)), rigHash(i + vec3(1, 0, 1)), f.x),
        mix(rigHash(i + vec3(0, 1, 1)), rigHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
`

/**
 * The species' material: lit like the town (vertex colours, matte), its hinges turned by
 * `angleGlsl`, which must define `float partAngle(float part, float t, vec4 anim)`. Its surface
 * is procedural: `grain` (model-space streak frequency, x y z) breaks the flat colour into coat
 * hair, feathers or wood grain.
 */
export function rigMaterial(
  key: string,
  angleGlsl: string,
  grain: readonly [number, number, number],
  roughness = 0.9,
): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0 })
  mat.userData.procedural = true
  const g = grain.map((v) => v.toFixed(1)).join(', ')
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${RIG_FRAGMENT}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.rgb *= 0.78 + 0.22 * rigNoise(vRigP * vec3(${g})) + 0.12 * rigNoise(vRigP * 7.0);`,
      )
    shader.uniforms.rigTime = RIG_TIME
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${RIG_VERTEX}\n${angleGlsl}`)
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 objectNormal = vec3(normal);
float rigAa = rigA.w < 0.0 ? 0.0 : partAngle(rigA.w, rigTime, rigAnim);
float rigAb = rigB.w < 0.0 ? 0.0 : partAngle(rigB.w, rigTime, rigAnim);
objectNormal = rigTurn(rigTurn(objectNormal, rigAxisA, rigAa), rigAxisB.xyz, rigAb);
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = rigTurn(position - rigA.xyz, rigAxisA, rigAa) + rigA.xyz;
transformed = rigTurn(transformed - rigB.xyz, rigAxisB.xyz, rigAb) + rigB.xyz;
vRigP = position;`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
#ifdef USE_COLOR
vColor.rgb = rigAxisB.w > 0.5 ? rigCoat : vColor.rgb;
#endif`,
      )
  }
  mat.customProgramCacheKey = () => `ow-rig-${key}`
  return mat
}

/** An instanced species: its matrices, and per instance the animation channels and coat. */
export class RigHerd {
  readonly mesh: InstancedMesh
  private readonly anim: InstancedBufferAttribute
  private readonly coat: InstancedBufferAttribute

  constructor(geo: BufferGeometry, mat: MeshStandardMaterial, count: number) {
    this.anim = new InstancedBufferAttribute(new Float32Array(count * 4), 4)
    this.coat = new InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3)
    geo.setAttribute('rigAnim', this.anim)
    geo.setAttribute('rigCoat', this.coat)
    this.mesh = new InstancedMesh(geo, mat, count)
    this.mesh.castShadow = false
    this.mesh.receiveShadow = true
    // the instances move (crows fly off): never culled on a stale bound
    this.mesh.frustumCulled = false
    for (let i = 0; i < count; i++) {
      this.anim.setX(i, Math.random() * 100)
    }
  }

  /** Channels y, z, w of one instance (x is its phase). */
  setAnim(i: number, y: number, z: number, w: number): void {
    this.anim.setY(i, y)
    this.anim.setZ(i, z)
    this.anim.setW(i, w)
    this.anim.needsUpdate = true
  }

  setCoat(i: number, hex: number): void {
    const c = new Color(hex)
    this.coat.setXYZ(i, c.r, c.g, c.b)
    this.coat.needsUpdate = true
  }

  setMatrix(i: number, m: Matrix4): void {
    this.mesh.setMatrixAt(i, m)
    this.mesh.instanceMatrix.needsUpdate = true
  }
}
