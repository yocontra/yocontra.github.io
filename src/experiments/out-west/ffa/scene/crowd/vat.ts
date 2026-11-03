// biome-ignore-all lint/style/noExcessiveClassesPerFile: the VAT crowd and its hat layer are one feature
/**
 * Vertex-animation-texture crowd (design doc §9.5 item 8), keyed by BASE BODY
 * (at most 7), not by loadout:
 *
 * - One VAT per base, baked on demand in a worker from an LOD2 of ~1.5k tris
 *   (meshopt), cached in memory and (best effort) in IndexedDB.
 * - Far players are instances of their base with per-instance palette tints
 *   (the loadout's primary and secondary colours) and clip/phase/speed.
 * - Hats are a separate instanced mesh per hat type, placed every frame on
 *   the VAT's baked head track.
 *
 * Draws: (bases in view) + (hat types in view) + 1 blob-shadow draw.
 *
 * SPIKE (stream H, M1): stream G absorbs or replaces this in ffa/scene/.
 */
import {
  type AnimationClip,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  type Mesh,
  MeshStandardMaterial,
  NearestFilter,
  Quaternion,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
} from 'three'
import type { BodyKey, HatKey } from '../../../data/outlaws.ts'
import type { Assets } from '../../../engine/assets.ts'
import type { Clip } from '../../../scene/actor.ts'
import { castActor } from '../../../scene/cast.ts'
import { makeHat } from '../../../scene/hats.ts'
import { HAIR_LUM } from '../../../scene/person.ts'
import { characterMaps, NORMAL_GUARD_GLSL, RECOLOR_GLSL } from '../../../scene/shade.ts'
import { RIM } from '../../../scene/style.ts'
import { VAT_W, type VatClipInfo, type VatJob, type VatResult } from './vat-shared.ts'

export const VAT_FPS = 15
/** Bump when the bake changes; also part of the IndexedDB key. */
const VAT_VERSION = 'vat8-skinhair'
const LOD2_TRIS = 1500

/** Clothing materials per base, recoloured per player (slot 1 top, slot 2 bottoms). */
export const PALETTE: Record<BodyKey, [string[], string[]]> = {
  casual: [['Shirt'], ['Pants']],
  suit: [['Shirt', 'Sleeves'], ['Pants']],
  worker: [['Shirt', 'Sleeves'], ['Pants']],
  punk: [['Shirt', 'Sleeves'], ['Pants']],
  king: [['Shirt', 'Sleeves'], ['Pants']],
  rugged: [['Shirt', 'Sleeves'], ['Pants']],
  woman: [['Shirt'], ['Pants']],
}
const MARK1 = 0xff_00_ff
const MARK2 = 0x00_ff_ff
/** Hair and brows (slot 3), and skin (slot 4): recoloured per rider like the clothes. */
const MARK3 = 0xff_ff_00
const MARK4 = 0x00_00_ff

export interface VatBake extends VatResult {
  base: BodyKey
  posTex: DataTexture
  nrmTex: DataTexture
  geometry: BufferGeometry
  /** Hat transform relative to the head bone (from the fitted base actor). */
  hatLocal: number[]
  bytes: number
  ms: number
  cached: boolean
}

// ---------------------------------------------------------------- IndexedDB (best effort)

function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('ow-vat', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('vat')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

interface Stored {
  r: VatResult
  hatLocal: number[]
}

async function idbGet(key: string): Promise<Stored | null> {
  const db = await idb()
  if (!db) {
    return null
  }
  return new Promise((resolve) => {
    try {
      const req = db.transaction('vat').objectStore('vat').get(key)
      req.onsuccess = () => resolve((req.result as Stored | undefined) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbPut(key: string, v: Stored): Promise<void> {
  const db = await idb()
  try {
    db?.transaction('vat', 'readwrite').objectStore('vat').put(v, key)
  } catch {
    // quota or private mode: memory cache only
  }
}

// ---------------------------------------------------------------- worker

let worker: Worker | null = null
let seq = 0
const waiting = new Map<number, { ok: (r: VatResult) => void; fail: (e: Error) => void }>()

function runJob(job: VatJob): Promise<VatResult> {
  if (!worker) {
    worker = new Worker(new URL('./vat.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; result?: VatResult; error?: string }>) => {
      const w = waiting.get(e.data.id)
      waiting.delete(e.data.id)
      if (e.data.result) {
        w?.ok(e.data.result)
      } else {
        w?.fail(new Error(e.data.error ?? 'vat bake failed'))
      }
    }
  }
  const id = ++seq
  const wk = worker
  return new Promise((ok, fail) => {
    waiting.set(id, { ok, fail })
    wk.postMessage({ id, job })
  })
}

function linear(hex: number): [number, number, number] {
  const c = new Color(hex)
  return [c.r, c.g, c.b]
}

function hairLinear(hex: number): [number, number, number] {
  const [r, g, b] = linear(hex)
  return [r / HAIR_LUM, g / HAIR_LUM, b / HAIR_LUM]
}

/** One far rider's colours: clothes, and the hair and skin tint his near actor wears. */
export interface VatColors {
  top: Color
  bottom: Color
  hair: Color
  skin: Color
}

/** Dress the base with marker colours, serialise it, and hand it to the worker. */
async function bakeFresh(assets: Assets, base: BodyKey, clips: Clip[]): Promise<Stored> {
  const [top, bottom] = PALETTE[base]
  const tint: Record<string, number> = {}
  for (const n of top) {
    tint[n] = MARK1
  }
  for (const n of bottom) {
    tint[n] = MARK2
  }
  tint.Hair = MARK3
  tint.Skin = MARK4
  await assets.lookReady({ base, tint, scale: 1 })
  const actor = castActor(assets, {
    look: { base, tint, scale: 1 },
    hat: 'cowboy',
    hatColor: 0xff_ff_ff,
  })
  actor.root.updateMatrixWorld(true)
  const head = actor.head
  const hat = actor.hat
  // the hat's one mesh, under its fitted (scaled) inner group
  let hatMesh: Mesh | null = null
  hat?.traverse((o) => {
    if ((o as { isMesh?: boolean }).isMesh) {
      hatMesh = o as Mesh
    }
  })
  const hm = hatMesh as Mesh | null
  // relative to the head's unit-scale pose (the baked head track drops bone scale)
  let hatLocal: number[] = new Matrix4().toArray()
  if (head && hm) {
    const hp = new Vector3()
    const hq = new Quaternion()
    head.matrixWorld.decompose(hp, hq, new Vector3())
    hatLocal = new Matrix4()
      .compose(hp, hq, new Vector3(1, 1, 1))
      .invert()
      .multiply(hm.matrixWorld)
      .toArray()
  }
  hat?.removeFromParent()
  // geometry and bones only: the worker never needs the atlas (and couldn't decode it)
  const plain = new MeshStandardMaterial()
  actor.root.traverse((o) => {
    if ((o as { isMesh?: boolean }).isMesh) {
      ;(o as Mesh).material = plain
    }
  })
  const json = actor.root.toJSON()
  const clipJson = clips
    .map((n) => actor.action(n)?.getClip())
    .filter((c): c is AnimationClip => c !== undefined)
    .map((c) => c.toJSON())
  actor.dispose()
  const r = await runJob({
    json,
    clips: clipJson,
    fps: VAT_FPS,
    targetTris: LOD2_TRIS,
    headUuid: head?.uuid ?? '',
    // the hair tint reads as itself over the grey hair texels (scene/rig.ts), so its marker too
    markers: [linear(MARK1), linear(MARK2), hairLinear(MARK3), linear(MARK4)],
  })
  return { r, hatLocal }
}

const memory = new Map<BodyKey, Promise<VatBake>>()

function texture(d: Uint16Array | Uint8Array, rows: number): DataTexture {
  const t = new DataTexture(
    d,
    VAT_W,
    rows,
    RGBAFormat,
    d instanceof Uint16Array ? HalfFloatType : UnsignedByteType,
  )
  t.minFilter = NearestFilter
  t.magFilter = NearestFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

function finish(base: BodyKey, s: Stored, ms: number, cached: boolean): VatBake {
  const r = s.r
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(r.vertexCount * 3), 3))
  geometry.setAttribute('color', new BufferAttribute(r.color, 3))
  geometry.setAttribute('vatSlot', new BufferAttribute(r.slot, 1))
  geometry.setAttribute('uv', new BufferAttribute(r.uv, 2))
  geometry.setAttribute('styLum', new BufferAttribute(r.lum, 1))
  geometry.setIndex(new BufferAttribute(r.index, 1))
  const totalFrames = r.clips.reduce((a, c) => a + c.frames, 0)
  return {
    ...r,
    base,
    posTex: texture(r.pos, r.rows * totalFrames),
    nrmTex: texture(r.nrm, r.rows * totalFrames),
    geometry,
    hatLocal: s.hatLocal,
    bytes: r.pos.byteLength + r.nrm.byteLength,
    ms,
    cached,
  }
}

/** The VAT for one base body: memory cache, then IndexedDB, then a worker bake. */
export function baseVat(assets: Assets, base: BodyKey, clips: Clip[]): Promise<VatBake> {
  const have = memory.get(base)
  if (have) {
    return have
  }
  const key = `${VAT_VERSION}:${LOD2_TRIS}:${base}:${clips.join(',')}`
  const p = (async () => {
    const t0 = performance.now()
    const stored = await idbGet(key)
    if (stored) {
      return finish(base, stored, performance.now() - t0, true)
    }
    const fresh = await bakeFresh(assets, base, clips)
    idbPut(key, fresh).catch(() => undefined)
    return finish(base, fresh, performance.now() - t0, false)
  })()
  memory.set(base, p)
  return p
}

// ---------------------------------------------------------------- drawing

/** Shared clock for every VAT crowd. */
export const VAT_TIME = { value: 0 }

/** The frame position (fractional) the shader plays for an instance. */
export function vatFrame(clip: VatClipInfo, phase: number, speed: number): number {
  const f = (VAT_TIME.value + phase) * speed * VAT_FPS
  return ((f % clip.frames) + clip.frames) % clip.frames
}

const vatVertex = (rows: number) => /* glsl */ `#include <common>
uniform highp sampler2D vatPos;
uniform highp sampler2D vatNrm;
uniform float vatTime;
attribute vec4 vatClip;
attribute vec3 vatTop;
attribute vec3 vatBottom;
attribute vec3 vatHair;
attribute vec3 vatSkin;
attribute float vatSlot;
attribute vec3 color;
attribute float styLum;
varying vec3 vStyTint;
varying float vStyLum;
vec3 vatP; vec3 vatN;
void vatSample() {
  float f = mod((vatTime + vatClip.z) * vatClip.w * ${VAT_FPS.toFixed(1)}, vatClip.y);
  float f0 = floor(f);
  float f1 = mod(f0 + 1.0, vatClip.y);
  float t = f - f0;
  int v = gl_VertexID;
  int x = v % ${VAT_W};
  int y = v / ${VAT_W};
  int r0 = int(vatClip.x + f0) * ${rows} + y;
  int r1 = int(vatClip.x + f1) * ${rows} + y;
  vatP = mix(texelFetch(vatPos, ivec2(x, r0), 0).xyz, texelFetch(vatPos, ivec2(x, r1), 0).xyz, t);
  vec3 vatNn = mix(texelFetch(vatNrm, ivec2(x, r0), 0).xyz, texelFetch(vatNrm, ivec2(x, r1), 0).xyz, t) * 2.0 - 1.0;
  // a degenerate (collapsed) triangle bakes a zero normal: never normalize it into a NaN
  vatN = dot(vatNn, vatNn) > 1e-6 ? normalize(vatNn) : vec3(0.0, 1.0, 0.0);
}`

export class VatCrowd {
  readonly mesh: InstancedMesh
  readonly bake: VatBake
  private readonly clipAttr: InstancedBufferAttribute
  private readonly topAttr: InstancedBufferAttribute
  private readonly bottomAttr: InstancedBufferAttribute
  private readonly hairAttr: InstancedBufferAttribute
  private readonly skinAttr: InstancedBufferAttribute

  constructor(bake: VatBake, capacity: number) {
    this.bake = bake
    // the same atlas and recolour as the near (skinned) characters
    const maps = characterMaps()
    const mat = new MeshStandardMaterial({ roughness: 1, metalness: maps ? 1 : 0 })
    // like the near characters (shade.ts): open garments show their insides, not the street
    mat.side = DoubleSide
    mat.shadowSide = BackSide
    if (maps) {
      mat.map = maps.map
      mat.normalMap = maps.normal
      mat.roughnessMap = maps.arm
      mat.metalnessMap = maps.arm
    }
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.vatPos = { value: bake.posTex }
      shader.uniforms.vatNrm = { value: bake.nrmTex }
      shader.uniforms.vatTime = VAT_TIME
      shader.uniforms.styRim = RIM.color
      shader.uniforms.styRimK = RIM.strength
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', vatVertex(bake.rows))
        .replace('#include <beginnormal_vertex>', 'vatSample();\nvec3 objectNormal = vatN;')
        .replace('#include <begin_vertex>', 'vec3 transformed = vatP;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
vec3 vatPaint = vatSlot < 2.5 ? vatBottom : (vatSlot < 3.5 ? vatHair : vatSkin);
vStyTint = vatSlot < 0.5 ? color.rgb : (vatSlot < 1.5 ? vatTop : vatPaint);
vStyLum = styLum;`,
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform vec3 styRim;\nuniform float styRimK;\nvarying vec3 vStyTint;\nvarying float vStyLum;',
        )
        .replace('#include <map_fragment>', `#include <map_fragment>\n${RECOLOR_GLSL}`)
        .replace('#include <normal_fragment_maps>', NORMAL_GUARD_GLSL)
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
{
  float ndv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
  totalEmissiveRadiance += styRim * styRimK * smoothstep(0.35, 1.0, 1.0 - ndv) * (0.55 + 0.45 * diffuseColor.rgb);
}`,
        )
    }
    mat.customProgramCacheKey = () => `ow-vat3-${bake.rows}${maps ? '-tex' : ''}`
    const geo = bake.geometry.clone()
    this.mesh = new InstancedMesh(geo, mat, capacity)
    this.clipAttr = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    this.topAttr = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.bottomAttr = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.hairAttr = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.skinAttr = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    geo.setAttribute('vatClip', this.clipAttr)
    geo.setAttribute('vatTop', this.topAttr)
    geo.setAttribute('vatBottom', this.bottomAttr)
    geo.setAttribute('vatHair', this.hairAttr)
    geo.setAttribute('vatSkin', this.skinAttr)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.receiveShadow = true
  }

  clip(name: Clip): VatClipInfo | null {
    return this.bake.clips.find((c) => c.name === name) ?? null
  }

  /** One instance's full state, written per frame without allocating. */
  set(i: number, clip: VatClipInfo, play: { phase: number; speed: number }, c: VatColors): void {
    this.clipAttr.setXYZW(i, clip.start, clip.frames, play.phase, play.speed)
    this.topAttr.setXYZ(i, c.top.r, c.top.g, c.top.b)
    this.bottomAttr.setXYZ(i, c.bottom.r, c.bottom.g, c.bottom.b)
    this.hairAttr.setXYZ(i, c.hair.r, c.hair.g, c.hair.b)
    this.skinAttr.setXYZ(i, c.skin.r, c.skin.g, c.skin.b)
  }

  commit(): void {
    this.clipAttr.needsUpdate = true
    this.topAttr.needsUpdate = true
    this.bottomAttr.needsUpdate = true
    this.hairAttr.needsUpdate = true
    this.skinAttr.needsUpdate = true
    this.mesh.instanceMatrix.needsUpdate = true
  }
}

const hp0 = new Vector3()
const hp1 = new Vector3()
const hq0 = new Quaternion()
const hq1 = new Quaternion()

/** Head pose (root space) at a fractional frame of a clip. */
// biome-ignore lint/complexity/useMaxParams: out-parameters keep the per-frame hat update allocation-free
export function headAt(
  bake: VatBake,
  clip: VatClipInfo,
  frame: number,
  outP: Vector3,
  outQ: Quaternion,
): void {
  const f0 = Math.floor(frame)
  const f1 = (f0 + 1) % clip.frames
  const t = frame - f0
  const h = bake.head
  const o0 = (clip.start + f0) * 7
  const o1 = (clip.start + f1) * 7
  hp0.fromArray(h, o0)
  hp1.fromArray(h, o1)
  hq0.fromArray(h, o0 + 3)
  hq1.fromArray(h, o1 + 3)
  outP.lerpVectors(hp0, hp1, t)
  outQ.slerpQuaternions(hq0, hq1, t)
}

/** One instanced mesh per hat type, tinted per instance. */
export class VatHats {
  readonly meshes = new Map<HatKey, InstancedMesh>()
  private readonly capacity: number
  private readonly root: { add: (o: InstancedMesh) => void }

  constructor(root: { add: (o: InstancedMesh) => void }, capacity: number) {
    this.root = root
    this.capacity = capacity
  }

  mesh(key: HatKey): InstancedMesh {
    const have = this.meshes.get(key)
    if (have) {
      return have
    }
    const g = makeHat(key, 0xff_ff_ff)
    const meshes: Mesh[] = []
    g.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh) {
        meshes.push(o as Mesh)
      }
    })
    const m = meshes[0]
    // mesh-local: VatBake.hatLocal already carries the fitted scale
    const geo = m ? m.geometry.clone() : new BufferGeometry()
    const mat = new MeshStandardMaterial({
      vertexColors: geo.hasAttribute('color'),
      roughness: 0.85,
    })
    const im = new InstancedMesh(geo, mat, this.capacity)
    im.count = 0
    im.frustumCulled = false
    this.meshes.set(key, im)
    this.root.add(im)
    return im
  }

  reset(): void {
    for (const m of this.meshes.values()) {
      m.count = 0
    }
  }

  push(key: HatKey, matrix: Matrix4, color: Color): void {
    const m = this.mesh(key)
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
