/**
 * Vertex-animation textures (design doc §9.5 item 8): bake a dressed Actor's
 * clips into position and normal textures, then draw any number of him as ONE
 * instanced mesh whose vertex shader plays the clip. Per instance: clip, phase,
 * speed and a cosmetic tint.
 *
 * SPIKE (stream H, M1): stream G absorbs or replaces this in ffa/scene/.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  type Material,
  type Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RGBAFormat,
  type SkinnedMesh,
  UnsignedByteType,
  Vector3,
} from 'three'
import type { Actor, Clip } from '../../../scene/actor.ts'
import { RIM } from '../../../scene/style.ts'

/** Texture row width; vertex v of frame f lives at (v % W, f * rows + v / W). */
const W = 1024
export const VAT_FPS = 15

export interface VatClip {
  name: Clip
  start: number
  frames: number
}

export interface VatBake {
  /** GPU bytes of both textures. */
  bytes: number
  geometry: BufferGeometry
  pos: DataTexture
  nrm: DataTexture
  clips: VatClip[]
  rows: number
  vertexCount: number
}

interface Part {
  mesh: Mesh
  skinned: boolean
  color: Color
}

function parts(actor: Actor): Part[] {
  const out: Part[] = []
  actor.root.updateMatrixWorld(true)
  actor.root.traverse((o) => {
    const m = o as Mesh
    if (!((o as { isMesh?: boolean }).isMesh && m.visible)) {
      return
    }
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as Material & {
      color?: Color
    }
    out.push({
      mesh: m,
      skinned: Boolean((m as SkinnedMesh).isSkinnedMesh),
      color: mat.color ? mat.color.clone() : new Color(1, 1, 1),
    })
  })
  return out
}

/** One static geometry (rest pose) with vertex colours, indexed, in root space. */
function mergeStatic(ps: Part[]): { geo: BufferGeometry; counts: number[] } {
  let nv = 0
  let ni = 0
  const counts: number[] = []
  for (const p of ps) {
    const g = p.mesh.geometry
    const c = g.getAttribute('position').count
    counts.push(c)
    nv += c
    ni += g.index ? g.index.count : c
  }
  const color = new Float32Array(nv * 3)
  const index = new Uint32Array(ni)
  let vo = 0
  let io = 0
  for (const p of ps) {
    const g = p.mesh.geometry
    const c = g.getAttribute('position').count
    const col = g.getAttribute('color')
    for (let i = 0; i < c; i++) {
      const r = col ? col.getX(i) : 1
      const gg = col ? col.getY(i) : 1
      const b = col ? col.getZ(i) : 1
      color.set([r * p.color.r, gg * p.color.g, b * p.color.b], (vo + i) * 3)
    }
    if (g.index) {
      for (let k = 0; k < g.index.count; k++) {
        index[io++] = g.index.getX(k) + vo
      }
    } else {
      for (let k = 0; k < c; k++) {
        index[io++] = vo + k
      }
    }
    vo += c
  }
  const geo = new BufferGeometry()
  // positions come from the texture; this attribute only sizes the draw and bounds
  geo.setAttribute('position', new BufferAttribute(new Float32Array(nv * 3), 3))
  geo.setAttribute('color', new BufferAttribute(color, 3))
  geo.setIndex(new BufferAttribute(index, 1))
  return { geo, counts }
}

const tmp = new Vector3()

/** Sample every vertex of every part at the actor's current pose (root space). */
function samplePose(ps: Part[], out: Float32Array): void {
  let o = 0
  for (const p of ps) {
    const pos = p.mesh.geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i)
      if (p.skinned) {
        ;(p.mesh as SkinnedMesh).applyBoneTransform(i, tmp)
        tmp.applyMatrix4(p.mesh.matrixWorld)
      } else {
        tmp.applyMatrix4(p.mesh.matrixWorld)
      }
      out[o++] = tmp.x
      out[o++] = tmp.y
      out[o++] = tmp.z
    }
  }
}

/** Bake the named clips at VAT_FPS. The actor must stand at the origin, unrotated. */
export function bakeVat(actor: Actor, names: Clip[]): VatBake {
  const ps = parts(actor)
  const { geo } = mergeStatic(ps)
  const nv = geo.getAttribute('position').count
  const rows = Math.ceil(nv / W)
  const clips: VatClip[] = []
  let total = 0
  for (const n of names) {
    const a = actor.action(n)
    if (!a) {
      continue
    }
    const frames = Math.max(2, Math.round(a.getClip().duration * VAT_FPS))
    clips.push({ name: n, start: total, frames })
    total += frames
  }
  // positions as half floats (8 B/vertex/frame), normals as RGBA8 (4 B)
  const posData = new Uint16Array(W * rows * total * 4)
  const nrmData = new Uint8Array(W * rows * total * 4)
  const h = DataUtils.toHalfFloat
  const n8 = (x: number) => Math.round((x * 0.5 + 0.5) * 255)
  const frame = new Float32Array(nv * 3)
  const ng = new BufferGeometry()
  const nAttr = new BufferAttribute(frame, 3)
  ng.setAttribute('position', nAttr)
  ng.setIndex(geo.index)
  const mixer = actor.mixer
  for (const c of clips) {
    mixer.stopAllAction()
    const a = actor.action(c.name)
    if (!a) {
      continue
    }
    a.reset().play()
    a.setEffectiveWeight(1)
    for (let f = 0; f < c.frames; f++) {
      a.time = (f / c.frames) * a.getClip().duration
      mixer.update(0)
      actor.root.updateMatrixWorld(true)
      samplePose(ps, frame)
      nAttr.needsUpdate = true
      ng.computeVertexNormals()
      const normals = ng.getAttribute('normal')
      const base = (c.start + f) * rows * W
      for (let v = 0; v < nv; v++) {
        const t = (base + v) * 4
        posData[t] = h(frame[v * 3] ?? 0)
        posData[t + 1] = h(frame[v * 3 + 1] ?? 0)
        posData[t + 2] = h(frame[v * 3 + 2] ?? 0)
        posData[t + 3] = h(1)
        nrmData[t] = n8(normals.getX(v))
        nrmData[t + 1] = n8(normals.getY(v))
        nrmData[t + 2] = n8(normals.getZ(v))
        nrmData[t + 3] = 255
      }
    }
    a.stop()
  }
  const tex = (d: Uint16Array | Uint8Array) => {
    const t = new DataTexture(
      d,
      W,
      rows * total,
      RGBAFormat,
      d instanceof Uint16Array ? HalfFloatType : UnsignedByteType,
    )
    t.minFilter = NearestFilter
    t.magFilter = NearestFilter
    t.generateMipmaps = false
    t.needsUpdate = true
    return t
  }
  // bounds: a generous cylinder around a running man
  geo.boundingSphere = null
  geo.computeBoundingBox()
  geo.boundingBox?.set(new Vector3(-1, 0, -1), new Vector3(1, 2.2, 1))
  geo.computeBoundingSphere()
  return {
    bytes: posData.byteLength + nrmData.byteLength,
    geometry: geo,
    pos: tex(posData),
    nrm: tex(nrmData),
    clips,
    rows,
    vertexCount: nv,
  }
}

/** Shared clock for every VAT crowd. */
export const VAT_TIME = { value: 0 }

export class VatCrowd {
  readonly mesh: InstancedMesh
  readonly bake: VatBake
  /** Per instance: start frame, frame count, phase (s), speed. */
  private readonly clipAttr: InstancedBufferAttribute

  constructor(bake: VatBake, capacity: number) {
    this.bake = bake
    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 })
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.vatPos = { value: bake.pos }
      shader.uniforms.vatNrm = { value: bake.nrm }
      shader.uniforms.vatTime = VAT_TIME
      shader.uniforms.styRim = RIM.color
      shader.uniforms.styRimK = RIM.strength
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform highp sampler2D vatPos;
uniform highp sampler2D vatNrm;
uniform float vatTime;
attribute vec4 vatClip;
vec3 vatP; vec3 vatN;
void vatSample() {
  float f = mod((vatTime + vatClip.z) * vatClip.w * ${VAT_FPS.toFixed(1)}, vatClip.y);
  float f0 = floor(f);
  float f1 = mod(f0 + 1.0, vatClip.y);
  float t = f - f0;
  int v = gl_VertexID;
  int x = v % ${W};
  int y = v / ${W};
  int r0 = int(vatClip.x + f0) * ${bake.rows} + y;
  int r1 = int(vatClip.x + f1) * ${bake.rows} + y;
  vatP = mix(texelFetch(vatPos, ivec2(x, r0), 0).xyz, texelFetch(vatPos, ivec2(x, r1), 0).xyz, t);
  vatN = normalize(mix(texelFetch(vatNrm, ivec2(x, r0), 0).xyz, texelFetch(vatNrm, ivec2(x, r1), 0).xyz, t) * 2.0 - 1.0);
}`,
        )
        .replace('#include <beginnormal_vertex>', 'vatSample();\nvec3 objectNormal = vatN;')
        .replace('#include <begin_vertex>', 'vec3 transformed = vatP;')
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform vec3 styRim;\nuniform float styRimK;',
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
{
  float ndv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
  totalEmissiveRadiance += styRim * styRimK * smoothstep(0.35, 1.0, 1.0 - ndv) * (0.55 + 0.45 * diffuseColor.rgb);
}`,
        )
    }
    mat.customProgramCacheKey = () => `ow-vat-${bake.rows}`
    this.mesh = new InstancedMesh(bake.geometry, mat, capacity)
    this.clipAttr = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    bake.geometry.setAttribute('vatClip', this.clipAttr)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.receiveShadow = true
  }

  clip(name: Clip): VatClip | null {
    return this.bake.clips.find((c) => c.name === name) ?? null
  }

  setClip(i: number, clip: VatClip, phase: number, speed: number): void {
    this.clipAttr.setXYZW(i, clip.start, clip.frames, phase, speed)
    this.clipAttr.needsUpdate = true
  }
}
