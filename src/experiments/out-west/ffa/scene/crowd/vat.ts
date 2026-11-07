/**
 * Cached silhouette VATs for Frontier's far crowd. Each outfit cut retains its defining coat,
 * poncho, vest, neckerchief and gunbelt; palettes are per instance. Hats and weapon finishes are
 * instanced separately on attachment tracks baked with the body's animation clock.
 * Active crowds pin their resources; the shared cache keeps at most four idle bakes.
 */
import {
  type AnimationClip,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  Group,
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
import type { BodyKey } from '../../../data/outlaws.ts'
import type { Assets } from '../../../engine/assets.ts'
import type { Clip } from '../../../scene/actor.ts'
import { castActor } from '../../../scene/cast.ts'
import { HAIR_LUM } from '../../../scene/person.ts'
import { propObject } from '../../../scene/props.ts'
import { revolverDef } from '../../../scene/revolver.ts'
import { rifleObject } from '../../../scene/rifle.ts'
import { SLOT } from '../../../scene/roles.ts'
import { characterMaterial } from '../../../scene/shade.ts'
import { shotgunMesh } from '../shotgun.ts'
import { aimedGaits } from './aim-gait.ts'
import { ResourceCache } from './resource-cache.ts'
import { silhouetteKey, silhouetteLook, type VatLook } from './silhouette.ts'
import { VAT_W, type VatClipInfo, type VatResult } from './vat-shared.ts'
import { runVatJob } from './worker-client.ts'

export const VAT_FPS = 15
/** Bump when the bake changes; also part of the IndexedDB key. */
const VAT_VERSION = 'vat33-anatomical-waist-boots'
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
const MARK5 = 0x00_ff_00

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
      req.onsuccess = () => {
        db.close()
        resolve((req.result as Stored | undefined) ?? null)
      }
      req.onerror = () => {
        db.close()
        resolve(null)
      }
    } catch {
      db.close()
      resolve(null)
    }
  })
}

async function idbPut(key: string, v: Stored): Promise<void> {
  const db = await idb()
  try {
    if (db) {
      const tx = db.transaction('vat', 'readwrite')
      const close = () => db.close()
      tx.oncomplete = close
      tx.onerror = close
      tx.onabort = close
      tx.objectStore('vat').put(v, key)
    }
  } catch {
    // quota or private mode: memory cache only
    db?.close()
  }
}

// ---------------------------------------------------------------- worker

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
  sleeves: Color
  hair: Color
  skin: Color
}

/** Dress the base with marker colours, serialise it, and hand it to the worker. */
async function bakeFresh(assets: Assets, look: VatLook, clips: Clip[]): Promise<Stored> {
  const base = look.base
  const [top, bottom] = PALETTE[base]
  const tint: Record<string, number> = {}
  for (const n of top) {
    tint[n] = MARK1
  }
  for (const n of bottom) {
    tint[n] = MARK2
  }
  tint.Sleeves = MARK5
  tint.Hair = MARK3
  tint.Skin = MARK4
  const dressed = { ...look, tint, scale: 1 }
  await assets.lookReady(dressed)
  const actor = castActor(assets, {
    look: dressed,
    paletteSlots: {
      [SLOT.Shirt]: 1,
      [SLOT.Sleeves]: 5,
      [SLOT.Pants]: 2,
      [SLOT.Hair]: 3,
      [SLOT.Brows]: 3,
      [SLOT.Skin]: 4,
      [SLOT.Beard]: look.catalogMoustache === undefined ? 3 : 0,
    },
    gun: propObject(revolverDef(0.32, 'lo')),
    offGun: look.offGun ?? false,
    bandana: look.bandana,
    holster: look.holster,
    hat: 'cowboy',
    hatColor: 0xff_ff_ff,
  })
  actor.holsterGun()
  const stowed = new Group()
  if (actor.gun?.parent) {
    stowed.position.copy(actor.gun.position)
    stowed.quaternion.copy(actor.gun.quaternion)
    stowed.scale.copy(actor.gun.scale)
    actor.gun.parent.add(stowed)
  }
  const offStowed = new Group()
  if (actor.offGun?.parent) {
    offStowed.position.copy(actor.offGun.position)
    offStowed.quaternion.copy(actor.offGun.quaternion)
    offStowed.scale.copy(actor.offGun.scale)
    actor.offGun.parent.add(offStowed)
  }
  actor.draw()
  const long = actor.addLong(rifleObject())
  const shotgun = shotgunMesh()
  shotgun.scale.set(1.15, 1.38, 1.38)
  const short = actor.addLong(shotgun)
  actor.holdLong(long)
  actor.update(0)
  actor.holdLong(null)
  actor.root.updateMatrixWorld(true)
  const sockets: Record<string, string> = { holster: stowed.uuid }
  if (actor.gun) {
    sockets.hand = actor.gun.uuid
  }
  if (actor.offGun) {
    sockets.offHand = actor.offGun.uuid
    sockets.offHolster = offStowed.uuid
  }
  if (long) {
    sockets.rifle = long.obj.uuid
  }
  if (short) {
    sockets.shotgun = short.obj.uuid
  }
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
  const sourceClips = clips
    .map((n) => actor.action(n)?.getClip())
    .filter((c): c is AnimationClip => c !== undefined)
  const clipJson = [...sourceClips, ...aimedGaits(sourceClips)].map((c) => c.toJSON())
  actor.dispose()
  const r = await runVatJob({
    json,
    clips: clipJson,
    fps: VAT_FPS,
    targetTris: LOD2_TRIS,
    headUuid: head?.uuid ?? '',
    sockets,
    // the hair tint reads as itself over the grey hair texels (scene/rig.ts), so its marker too
    markers: [linear(MARK1), linear(MARK2), hairLinear(MARK3), linear(MARK4), linear(MARK5)],
  })
  return { r, hatLocal }
}

const resident = new Set<VatBake>()
const memory = new ResourceCache<VatBake>({
  idleLimit: 4,
  concurrency: 1,
  dispose: (bake) => {
    resident.delete(bake)
    bake.posTex.dispose()
    bake.nrmTex.dispose()
    bake.geometry.dispose()
  },
})
export const setVatIdleLimit = (limit: number): void => memory.setIdleLimit(limit)
export const vatCacheStats = () => ({
  ...memory.stats,
  textureBytes: [...resident].reduce((sum, bake) => sum + bake.bytes, 0),
})

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
  const surface = new Float32Array(r.vertexCount * 4)
  for (let i = 0; i < r.vertexCount; i++) {
    surface.set(
      [r.style[i * 2] ?? 1, r.style[i * 2 + 1] ?? 1, r.lum[i] ?? 0, r.slot[i] ?? 0],
      i * 4,
    )
  }
  geometry.setAttribute('vatSurface', new BufferAttribute(surface, 4))
  geometry.setAttribute('uv', new BufferAttribute(r.uv, 2))
  geometry.setIndex(new BufferAttribute(r.index, 1))
  return {
    ...r,
    base,
    posTex: texture(r.pos, r.posRows),
    nrmTex: texture(r.nrm, r.nrmRows),
    geometry,
    hatLocal: s.hatLocal,
    bytes: r.pos.byteLength + r.nrm.byteLength,
    ms,
    cached,
  }
}

/** Acquire one outfit silhouette: bounded memory cache, IndexedDB, then a worker bake. */
export function baseVat(
  assets: Assets,
  source: BodyKey | VatLook,
  clips: Clip[],
): Promise<VatBake> {
  const look =
    typeof source === 'string' ? { base: source, tint: {}, scale: 1 } : silhouetteLook(source)
  const base = look.base
  const variant = silhouetteKey(look)
  const key = `${VAT_VERSION}:${LOD2_TRIS}:${variant}:${clips.join(',')}`
  return memory.acquire(key, async () => {
    const t0 = performance.now()
    const stored = await idbGet(key)
    if (stored) {
      const bake = finish(base, stored, performance.now() - t0, true)
      resident.add(bake)
      return bake
    }
    const fresh = await bakeFresh(assets, look, clips)
    idbPut(key, fresh).catch(() => undefined)
    const bake = finish(base, fresh, performance.now() - t0, false)
    resident.add(bake)
    return bake
  })
}

/** Release one live crowd's pin after all its instances have detached. */
export function releaseVat(look: VatLook, clips: Clip[]): void {
  const key = `${VAT_VERSION}:${LOD2_TRIS}:${silhouetteKey(look)}:${clips.join(',')}`
  memory.release(key)
}

// ---------------------------------------------------------------- drawing

/** Shared clock for every VAT crowd. */
export const VAT_TIME = { value: 0 }

/** The frame position (fractional) the shader plays for an instance. */
export function vatFrame(clip: VatClipInfo, phase: number, speed: number): number {
  const f = (VAT_TIME.value + phase) * speed * VAT_FPS
  return ((f % clip.frames) + clip.frames) % clip.frames
}

const VAT_VERTEX = /* glsl */ `#include <common>
uniform highp sampler2D vatPos;
uniform highp sampler2D vatNrm;
uniform float vatTime;
uniform int vatVertices;
attribute vec4 vatClip;
attribute vec3 vatTop;
attribute vec3 vatBottom;
attribute vec3 vatSleeves;
attribute vec3 vatHair;
attribute vec3 vatSkin;
attribute vec4 vatSurface;
#define styMat vatSurface.xy
#define styLum vatSurface.z
#define vatSlot vatSurface.w
vec3 vatP; vec3 vatN;
ivec2 vatAddress(int texel) { return ivec2(texel % ${VAT_W}, texel / ${VAT_W}); }
vec3 vatPosition(int index) {
  int scalar=index*3;
  int texel=scalar/4;
  int channel=scalar%4;
  vec4 a=texelFetch(vatPos,vatAddress(texel),0);
  if(channel==0) return a.xyz;
  if(channel==1) return a.yzw;
  vec4 b=texelFetch(vatPos,vatAddress(texel+1),0);
  return channel==2 ? vec3(a.zw,b.x) : vec3(a.w,b.xy);
}
vec3 vatNormal(int index) {
  vec4 octets=texelFetch(vatNrm,vatAddress(index/2),0);
  vec2 e=(index%2==0 ? octets.xy : octets.zw)*2.0-1.0;
  vec3 n=vec3(e,1.0-abs(e.x)-abs(e.y));
  if(n.z<0.0) n.xy=(1.0-abs(n.yx))*vec2(n.x<0.0?-1.0:1.0,n.y<0.0?-1.0:1.0);
  return normalize(n);
}
void vatSample() {
  float f=mod((vatTime+vatClip.z)*vatClip.w*${VAT_FPS.toFixed(1)},vatClip.y);
  float f0=floor(f);
  float t=f-f0;
  int i0=int(vatClip.x+f0)*vatVertices+gl_VertexID;
  int i1=int(vatClip.x+mod(f0+1.0,vatClip.y))*vatVertices+gl_VertexID;
  vatP=mix(vatPosition(i0),vatPosition(i1),t);
  vec3 n=mix(vatNormal(i0),vatNormal(i1),t);
  vatN=dot(n,n)>1e-6 ? normalize(n) : vec3(0.0,1.0,0.0);
}`

export class VatCrowd {
  private warmed = false
  get warmReady(): boolean {
    return this.warmed
  }
  readonly mesh: InstancedMesh
  readonly bake: VatBake
  private readonly clipAttr: InstancedBufferAttribute
  private readonly topAttr: InstancedBufferAttribute
  private readonly bottomAttr: InstancedBufferAttribute
  private readonly sleevesAttr: InstancedBufferAttribute
  private readonly hairAttr: InstancedBufferAttribute
  private readonly skinAttr: InstancedBufferAttribute

  constructor(bake: VatBake, capacity: number) {
    this.bake = bake
    // Use the exact same material response as skinned riders; only the vertex source changes.
    const mat = characterMaterial({ value: 0 }, 'FarCharacter', { value: 0 })
    mat.shadowSide = BackSide
    const characterShader = mat.onBeforeCompile
    mat.onBeforeCompile = (shader, renderer) => {
      characterShader.call(mat, shader, renderer)
      shader.uniforms.vatPos = { value: bake.posTex }
      shader.uniforms.vatNrm = { value: bake.nrmTex }
      shader.uniforms.vatTime = VAT_TIME
      shader.uniforms.vatVertices = { value: bake.vertexCount }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', VAT_VERTEX)
        .replace('attribute vec2 styMat;', '')
        .replace('attribute float styLum;', '')
        .replace('#include <beginnormal_vertex>', 'vatSample();\nvec3 objectNormal = vatN;')
        .replace('#include <begin_vertex>', 'vec3 transformed = vatP;')
        .replace(
          'vStyTint = color;',
          `vec3 vatPaint = vatSlot < 2.5 ? vatBottom : (vatSlot < 3.5 ? vatHair : (vatSlot < 4.5 ? vatSkin : vatSleeves));
vStyTint = vatSlot < 0.5 ? color.rgb : (vatSlot < 1.5 ? vatTop : vatPaint) * color.rgb;`,
        )
        // Root-space feet are zero even on roofs; the instance adds its world elevation later.
        .replace('vStyY = (modelMatrix * vec4(transformed, 1.0)).y;', 'vStyY = transformed.y;')
    }
    mat.customProgramCacheKey = () => 'ow-vat26-palette'
    const geo = bake.geometry.clone()
    this.mesh = new InstancedMesh(geo, mat, capacity)
    this.clipAttr = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    this.topAttr = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.bottomAttr = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.sleevesAttr = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.hairAttr = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.skinAttr = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    geo.setAttribute('vatClip', this.clipAttr)
    geo.setAttribute('vatTop', this.topAttr)
    geo.setAttribute('vatBottom', this.bottomAttr)
    geo.setAttribute('vatSleeves', this.sleevesAttr)
    geo.setAttribute('vatHair', this.hairAttr)
    geo.setAttribute('vatSkin', this.skinAttr)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.castShadow = false
    this.mesh.receiveShadow = true
  }

  clip(name: string): VatClipInfo | null {
    return this.bake.clips.find((c) => c.name === name) ?? null
  }

  /** Stage a real idle/palette instance so a zero-count material is actually drawn during warmup. */
  stageWarm(colors: VatColors): ((ready: boolean) => void) | null {
    const clip = this.bake.clips[0]
    if (this.warmReady || !clip) {
      return null
    }
    const mesh = this.mesh
    const state = { count: mesh.count, visible: mesh.visible, culled: mesh.frustumCulled }
    const matrix = new Matrix4()
    mesh.getMatrixAt(0, matrix)
    const attributes = [
      this.clipAttr,
      this.topAttr,
      this.bottomAttr,
      this.sleevesAttr,
      this.hairAttr,
      this.skinAttr,
    ]
    const values = attributes.map((attribute) =>
      Array.from({ length: attribute.itemSize }, (_, i) => attribute.getComponent(0, i)),
    )
    mesh.count = 1
    mesh.visible = true
    mesh.frustumCulled = false
    mesh.setMatrixAt(0, new Matrix4())
    this.set(0, clip, { phase: 0, speed: 1 }, colors)
    this.commit()
    return (ready) => {
      this.warmed = ready
      mesh.count = state.count
      mesh.visible = state.visible
      mesh.frustumCulled = state.culled
      mesh.setMatrixAt(0, matrix)
      for (const [index, attribute] of attributes.entries()) {
        for (let i = 0; i < attribute.itemSize; i++) {
          attribute.setComponent(0, i, values[index]?.[i] ?? 0)
        }
      }
      this.commit()
    }
  }

  /** One instance's full state, written per frame without allocating. */
  set(i: number, clip: VatClipInfo, play: { phase: number; speed: number }, c: VatColors): void {
    this.clipAttr.setXYZW(i, clip.start, clip.frames, play.phase, play.speed)
    this.topAttr.setXYZ(i, c.top.r, c.top.g, c.top.b)
    this.bottomAttr.setXYZ(i, c.bottom.r, c.bottom.g, c.bottom.b)
    this.sleevesAttr.setXYZ(i, c.sleeves.r, c.sleeves.g, c.sleeves.b)
    this.hairAttr.setXYZ(i, c.hair.r, c.hair.g, c.hair.b)
    this.skinAttr.setXYZ(i, c.skin.r, c.skin.g, c.skin.b)
  }

  commit(): void {
    this.clipAttr.needsUpdate = true
    this.topAttr.needsUpdate = true
    this.bottomAttr.needsUpdate = true
    this.sleevesAttr.needsUpdate = true
    this.hairAttr.needsUpdate = true
    this.skinAttr.needsUpdate = true
    this.mesh.instanceMatrix.needsUpdate = true
  }
}
