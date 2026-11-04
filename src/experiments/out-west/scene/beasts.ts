// biome-ignore-all lint/style/useNamingConvention: paint keys are the model files' material names (Main_Dark)
// biome-ignore-all lint/style/noExcessiveClassesPerFile: the horses and the dog share one loader and one merge
/**
 * The town's horses and its dog: Quaternius's CC0 animated animals (models/horse.glb and
 * models/dog.glb, see CREDITS.md), trimmed to their idle clips. Each file's flat-colour parts are
 * merged into ONE skinned mesh with vertex colours (one draw per animal, not eight), with a coat
 * texture made in the shader, and the horses get a saddle and blanket skinned to the back.
 *
 * - The horses, tethered at two hitching rails, cycle their idles: standing, head low, grazing
 *   the dirt; at a whinny or a gunshot they throw their heads.
 * - The dog on a porch idles and noses about; at the dog fake-out he lunges and snaps.
 *
 * Loaded after the town is up (never on the first-load path); until then there are no animals.
 */
import {
  type AnimationAction,
  AnimationMixer,
  Box3,
  type BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  LoopOnce,
  LoopRepeat,
  Matrix4,
  MeshStandardMaterial,
  type Object3D,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { watchPose } from './pose-watch.ts'
import { SkinThrottle } from './skin-throttle.ts'

const ROOT = '/experiments/out-west/3d/models'

const FUR_GLSL = /* glsl */ `
float furH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float furN(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(furH(i), furH(i + vec3(1, 0, 0)), f.x), mix(furH(i + vec3(0, 1, 0)), furH(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(furH(i + vec3(0, 0, 1)), furH(i + vec3(1, 0, 1)), f.x), mix(furH(i + vec3(0, 1, 1)), furH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`

/** Matte vertex-coloured coat, broken up by a fine hair grain (model space, so it rides along). */
function coatMaterial(): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 })
  mat.userData.procedural = true
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFurP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFurP = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vFurP;\n${FUR_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.rgb *= 0.78 + 0.26 * furN(vFurP * vec3(14.0, 140.0, 14.0)) + 0.12 * furN(vFurP * 4.0);`,
      )
  }
  mat.customProgramCacheKey = () => 'ow-coat'
  return mat
}

/** An attribute as plain floats (or plain 16-bit joints), whatever quantisation it shipped in. */
function plain(a: BufferAttribute, joints: boolean): BufferAttribute {
  const n = a.count * a.itemSize
  const out = joints ? new Uint16Array(n) : new Float32Array(n)
  for (let i = 0; i < a.count; i++) {
    for (let k = 0; k < a.itemSize; k++) {
      out[i * a.itemSize + k] = a.getComponent(i, k)
    }
  }
  return joints
    ? new Uint16BufferAttribute(out, a.itemSize)
    : new Float32BufferAttribute(out, a.itemSize)
}

/**
 * The low-poly files are flat-shaded (every face its own vertices): weld each part's vertices that
 * share a position and skin, and give it smooth normals, so a coat reads as a coat, not card.
 */
function smooth(g: BufferGeometry): BufferGeometry {
  g.deleteAttribute('normal')
  const welded = mergeVertices(g, 1e-4)
  welded.computeVertexNormals()
  return welded
}

/** Extra geometry skinned rigidly to one bone (a saddle on the back), in mesh space. */
export interface Rider {
  geo: BufferGeometry
  color: number
  bone: string
}

/**
 * Merge every skinned part under `scene` into one SkinnedMesh with vertex colours (recoloured by
 * material name through `paint`), plus `riders`. Returns the merged mesh, replacing the parts.
 */
function mergeParts(scene: Object3D, paint: Record<string, number>): SkinnedMesh | null {
  const parts: SkinnedMesh[] = []
  scene.traverse((o) => {
    if ((o as Partial<SkinnedMesh>).isSkinnedMesh === true) {
      parts.push(o as SkinnedMesh)
    }
  })
  const first = parts[0]
  if (!first) {
    return null
  }
  const geos = parts.map((p) => {
    const src = p.geometry
    const g = new BufferGeometry()
    for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) {
      const a = src.getAttribute(name) as BufferAttribute | undefined
      if (a) {
        g.setAttribute(name, plain(a, name === 'skinIndex'))
      }
    }
    if (src.index) {
      g.setIndex(src.index.clone())
    }
    const mat = p.material as MeshStandardMaterial
    const c = new Color(paint[mat.name] ?? mat.color.getHex())
    const n = g.getAttribute('position').count
    const col = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      col.set([c.r, c.g, c.b], i * 3)
    }
    g.setAttribute('color', new Float32BufferAttribute(col, 3))
    return smooth(g)
  })
  const merged = mergeGeometries(geos)
  if (!merged) {
    return null
  }
  const mesh = new SkinnedMesh(merged, coatMaterial())
  mesh.name = first.name
  mesh.position.copy(first.position)
  mesh.quaternion.copy(first.quaternion)
  mesh.scale.copy(first.scale)
  first.parent?.add(mesh)
  mesh.bind(first.skeleton, first.bindMatrix)
  for (const p of parts) {
    p.removeFromParent()
  }
  return mesh
}

/**
 * Skin `riders` (given in the animal's own space, metres, feet on y = 0, as posed now) rigidly
 * to their bones (the animal not yet placed in the street, so its own space is world): each is carried back through its bone's current pose to the bind space the
 * mesh's vertices live in, then merged in.
 */
function addRiders(mesh: SkinnedMesh, riders: readonly Rider[]): void {
  if (riders.length === 0) {
    return
  }
  const bones = mesh.skeleton.bones
  const geos: BufferGeometry[] = [mesh.geometry]
  for (const r of riders) {
    const bi = Math.max(
      0,
      bones.findIndex((b) => b.name === r.bone),
    )
    const bone = bones[bi]
    const inv = mesh.skeleton.boneInverses[bi]
    if (!(bone && inv)) {
      continue
    }
    // attached skinning: world = bone · boneInv · bind · v (the model matrix cancels), solved for v
    const m = new Matrix4()
      .copy(mesh.bindMatrix)
      .invert()
      .multiply(inv.clone().invert())
      .multiply(bone.matrixWorld.clone().invert())
    r.geo.applyMatrix4(m)
    geos.push(riderGeometry(r, bi))
  }
  const merged = mergeGeometries(geos)
  if (merged) {
    mesh.geometry = merged
  }
}

function riderGeometry(r: Rider, bone: number): BufferGeometry {
  const src = r.geo.index ? r.geo.toNonIndexed() : r.geo
  const g = new BufferGeometry()
  g.setAttribute('position', src.getAttribute('position'))
  g.setAttribute('normal', src.getAttribute('normal'))
  const n = src.getAttribute('position').count
  const idx = new Uint16Array(n * 4)
  const w = new Float32Array(n * 4)
  const c = new Color(r.color)
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    idx[i * 4] = bone
    w[i * 4] = 1
    col.set([c.r, c.g, c.b], i * 3)
  }
  g.setAttribute('skinIndex', new Uint16BufferAttribute(idx, 4))
  g.setAttribute('skinWeight', new Float32BufferAttribute(w, 4))
  g.setAttribute('color', new Float32BufferAttribute(col, 3))
  // the parts are indexed: so is this (a trivial index), or the merge refuses the mix
  g.setIndex([...new Array(n).keys()])
  return g
}

let loader: GLTFLoader | null = null
function load(name: string): Promise<GLTF> {
  loader ??= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  return loader.loadAsync(`${ROOT}/${name}.glb`)
}

/** One animated animal: its model, mixer and named clips. */
class Beast {
  readonly root: Object3D
  readonly mixer: AnimationMixer
  readonly mesh: SkinnedMesh | null
  private readonly actions = new Map<string, AnimationAction>()
  private current: AnimationAction | null = null
  readonly label: string
  disposed = false

  constructor(
    g: GLTF,
    o: {
      label: string
      height: number
      paint: Record<string, number>
      riders: (h: number) => Rider[]
    },
  ) {
    this.label = o.label
    const scene = cloneSkinned(g.scene)
    this.root = scene
    this.mixer = new AnimationMixer(scene)
    for (const clip of g.animations) {
      this.actions.set(clip.name, this.mixer.clipAction(clip))
    }
    // posed in its idle (its bones, not its bind, set its rendered size), then merged
    this.play('Idle', 0)
    this.mixer.update(0)
    scene.updateMatrixWorld(true)
    this.mesh = mergeParts(scene, o.paint)
    const mesh = this.mesh
    if (!mesh) {
      return
    }
    mesh.computeBoundingBox()
    const bb = (mesh.boundingBox ?? new Box3()).clone().applyMatrix4(mesh.matrixWorld)
    const k = o.height / Math.max(1e-6, bb.max.y - bb.min.y)
    scene.scale.multiplyScalar(k)
    scene.position.y = -bb.min.y * k
    scene.updateMatrixWorld(true)
    addRiders(mesh, o.riders(o.height))
    mesh.castShadow = false
    mesh.receiveShadow = true
    // culled on a generous bound of its idle pose (off screen: no skinning, no draw)
    mesh.computeBoundingSphere()
    if (mesh.boundingSphere) {
      mesh.boundingSphere.radius *= 1.4
    }
    watchPose(this)
  }

  get meshes(): readonly { visible: boolean }[] {
    return this.mesh ? [this.mesh] : []
  }

  poseWeight(): number {
    let w = 0
    for (const a of this.actions.values()) {
      if (a.isRunning() || (a.enabled && a.getEffectiveWeight() > 0 && a.time > 0)) {
        w += a.getEffectiveWeight()
      }
    }
    return w
  }

  has(name: string): boolean {
    return this.actions.has(name)
  }

  play(name: string, fade = 0.4, once = false, speed = 1): void {
    const a = this.actions.get(name)
    if (!a || (a === this.current && !once)) {
      return
    }
    a.enabled = true
    a.reset()
    a.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Number.POSITIVE_INFINITY)
    a.clampWhenFinished = once
    a.timeScale = speed
    a.setEffectiveWeight(1)
    a.play()
    if (this.current && this.current !== a) {
      this.current.crossFadeTo(a, fade, false)
    }
    this.current = a
  }

  /** The clip playing now, and how far through it (0..1). */
  progress(): { name: string; k: number } {
    const a = this.current
    if (!a) {
      return { name: '', k: 1 }
    }
    return { name: a.getClip().name, k: a.time / Math.max(1e-3, a.getClip().duration) }
  }
}

// --------------------------------------------------------------------------------------- horses

interface Tether {
  at: Vector3
  yaw: number
  paint: Record<string, number>
}

/** Heads over the rail: right side at the saloon, left up the street (in the standoff's frame). */
const TETHERS: readonly Tether[] = [
  {
    at: new Vector3(9 - 0.6 - 1.25, 0, 4.4),
    yaw: Math.PI / 2,
    paint: {
      Main: 0x4c_2c_1a,
      Main_Dark: 0x30_1c_10,
      Main_Light: 0x64_40_28,
      Hair: 0x14_0e_0a,
      Muzzle: 0x24_1a_14,
      Hooves: 0x22_1c_18,
    },
  },
  {
    at: new Vector3(-(9 - 0.6 - 1.25), 0, 16.2),
    yaw: -Math.PI / 2,
    paint: {
      Main: 0x44_40_3a,
      Main_Dark: 0x30_2c_28,
      Main_Light: 0x56_50_48,
      Muzzle: 0x26_22_1e,
      Hair: 0x16_12_10,
      Hooves: 0x22_1c_18,
    },
  },
]

/**
 * A stock saddle on the back (metres, the horse's space, +z forward): a rounded leather seat on a
 * muted blanket, a raised cantle behind and the horn in front. Smooth shapes, no straps.
 */
function saddle(h: number): Rider[] {
  const back = h * 0.712
  const pad = (r: number, len: number, flat: number, at: [number, number, number]) => {
    const g = new CapsuleGeometry(r, len, 4, 14)
    g.rotateX(Math.PI / 2)
    g.scale(1, flat, 1)
    g.translate(...at)
    return g
  }
  const horn = new CylinderGeometry(0.022, 0.03, 0.11, 8)
  horn.translate(0, back + 0.1, 0.21)
  const cantle = new CapsuleGeometry(0.035, 0.18, 3, 8)
  cantle.rotateZ(Math.PI / 2)
  cantle.translate(0, back + 0.09, -0.16)
  return [
    { geo: pad(0.24, 0.3, 0.12, [0, back - 0.005, 0.02]), color: 0x4a_26_1c, bone: 'Torso' },
    { geo: pad(0.17, 0.24, 0.3, [0, back + 0.035, 0.02]), color: 0x3a_24_16, bone: 'Torso' },
    { geo: cantle, color: 0x3a_24_16, bone: 'Torso' },
    { geo: horn, color: 0x2a_1a_10, bone: 'Torso' },
  ]
}

const HORSE_IDLES = ['Idle', 'Idle_2', 'Idle_Headlow', 'Eating'] as const

/** A tethered or standing animal's place in another arena: feet and facing. */
export interface Stand {
  x: number
  y: number
  z: number
  yaw: number
}

export class Horses {
  private readonly herd: {
    beast: Beast
    next: number
    lag: number
    skin: SkinThrottle
    outer: Group
  }[] = []
  /** Another arena's tethers (null: the street's rails). */
  private places: readonly Stand[] | null = null

  constructor(root: Group) {
    load('horse')
      .then((g) => {
        for (const t of TETHERS) {
          const beast = new Beast(g, {
            label: 'horse',
            height: 2.25,
            paint: t.paint,
            riders: saddle,
          })
          const outer = new Group()
          outer.add(beast.root)
          outer.position.copy(t.at)
          outer.rotation.y = t.yaw
          outer.name = 'horse'
          root.add(outer)
          beast.play('Idle', 0)
          beast.mixer.update(Math.random() * 3)
          this.herd.push({
            beast,
            next: 3 + Math.random() * 6,
            lag: 0,
            skin: new SkinThrottle(outer),
            outer,
          })
        }
        this.tether(this.places)
      })
      .catch((e: unknown) => console.warn('[life] horses', e))
  }

  /** Tie the horses at another arena's rails (null: the street's); a horse with no place hides. */
  tether(places: readonly Stand[] | null): void {
    this.places = places
    this.herd.forEach((h, i) => {
      const t = TETHERS[i]
      const home = t ? { x: t.at.x, y: t.at.y, z: t.at.z, yaw: t.yaw } : null
      const p = places ? places[i] : home
      h.outer.visible = p !== undefined && p !== null
      if (p) {
        h.outer.position.set(p.x, p.y, p.z)
        h.outer.rotation.y = p.yaw
        h.skin.touch()
      }
    })
  }

  /** A whinny or a gunshot: heads thrown. */
  toss(): void {
    for (const h of this.herd) {
      h.beast.play('Idle_HitReact_Left', 0.15, true, 1.1)
      h.next = 1.6
    }
  }

  private frame = 0

  update(dt: number, every = 2): void {
    // their clips at 60 / every Hz, staggered
    this.frame++
    this.herd.forEach((h, i) => {
      h.next -= dt
      if (h.next <= 0) {
        const pick = HORSE_IDLES[Math.floor(Math.random() * HORSE_IDLES.length)] ?? 'Idle'
        h.beast.play(pick, 0.8)
        h.next = 5 + Math.random() * 7
      }
      h.lag += dt
      if ((i + this.frame) % every === 0) {
        h.beast.mixer.update(h.lag)
        h.lag = 0
        h.skin.touch()
      }
    })
  }
}

// ------------------------------------------------------------------------------------------ dog

/** The barber's dog on his porch up the right side (in the standoff's frame), facing the street. */
export const DOG_POS = new Vector3(10.05, 0.34, 25.4)
const DOG_YAW = -Math.PI / 2

export class Dog {
  private beast: Beast | null = null
  private holder: Object3D | null = null
  /** Where he lies and which way he faces (another arena's porch, or the barber's). */
  private readonly pos = DOG_POS.clone()
  private yaw = DOG_YAW
  private lunge = 0
  private next = 4

  constructor(root: Group) {
    load('dog')
      .then((g) => {
        const beast = new Beast(g, {
          label: 'dog',
          height: 0.62,
          paint: { Main: 0x8a_5a_2e },
          riders: () => [],
        })
        const outer = new Group()
        outer.add(beast.root)
        outer.position.copy(this.pos)
        outer.rotation.y = this.yaw
        outer.name = 'dog'
        root.add(outer)
        beast.play('Idle', 0)
        this.beast = beast
        this.holder = outer
        this.skin = new SkinThrottle(outer)
      })
      .catch((e: unknown) => console.warn('[life] dog', e))
  }

  /** Move him to another arena's porch (null: back to the barber's). */
  place(p: Stand | null): void {
    this.pos.set(p?.x ?? DOG_POS.x, p?.y ?? DOG_POS.y, p?.z ?? DOG_POS.z)
    this.yaw = p?.yaw ?? DOG_YAW
    this.lunge = 0
    if (this.holder) {
      this.holder.position.copy(this.pos)
      this.holder.rotation.y = this.yaw
    }
    this.skin?.touch()
  }

  /** The bark: he lunges to the porch edge, snapping, then backs off. */
  bark(): void {
    this.beast?.play('Attack', 0.08, true, 1.15)
    this.lunge = 1.4
    this.next = 1.5
  }

  private lag = 0
  private frame = 0
  private skin: SkinThrottle | null = null

  update(dt: number, every = 2): void {
    const b = this.beast
    const h = this.holder
    if (!(b && h)) {
      return
    }
    this.frame++
    this.lag += dt
    this.next -= dt
    if (this.next <= 0) {
      b.play(Math.random() < 0.6 ? 'Idle' : 'Idle_2_HeadLow', 0.6)
      this.next = 4 + Math.random() * 6
    }
    this.lunge = Math.max(0, this.lunge - dt)
    const u = 1.4 - this.lunge
    const out = this.lunge > 0 ? Math.min(1, u / 0.15) * Math.min(1, this.lunge / 0.5) : 0
    h.position
      .copy(this.pos)
      .add(new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(out * 0.55))
    // lunging, every frame; otherwise at 60 / every Hz
    if (this.lunge > 0 || this.frame % every === 0) {
      b.mixer.update(this.lag)
      this.lag = 0
      this.skin?.touch()
    }
  }
}
