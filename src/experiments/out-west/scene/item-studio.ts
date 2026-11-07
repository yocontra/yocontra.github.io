/**
 * Outfitter thumbnails: each piece of kit rendered once, offscreen, on a neutral backdrop, and
 * cached as a small canvas. Worn pieces are shown on a plain gunslinger (the starter kit plus
 * this one piece), framed on the part of him the piece dresses: the hat on a head-and-shoulders
 * bust, an outfit or an extra from the thighs up, a holster at the hip, spurs at the heels. A gun
 * is shown on its own, finished as it would be in his hand.
 *
 * Shares the game's renderer (one WebGL context) the same way the wanted-poster mugshots do
 * (scene/portrait.ts): a render target, one draw, a pixel read, the renderer's state put back.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Bone,
  Box3,
  Color,
  DirectionalLight,
  MathUtils,
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  type CatalogItem,
  DEFAULT_LOADOUT,
  type ItemId,
  itemById,
  type Slot,
} from '../data/catalog.ts'
import type { Actor } from './actor.ts'
import { dressedActor, finishedGun } from './loadout.ts'
import type { PropDef } from './props.ts'

/** The print, in pixels: the card shows it about 104 CSS px tall, at the screen's density (≤ 2×). */
const SIZE = Math.round(112 * Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1)))
const DIST = 3

/** Slots with something to see on the body or in the hand. */
/** How far he turns from the camera: the holster's hip, the spurred heel, else three-quarters. */
const TURN: Partial<Record<Slot, number>> = { holster: 1.5, spurs: 2.4 }

const VISIBLE: readonly Slot[] = ['hat', 'gun', 'outfit', 'extra', 'spurs', 'holster']

export const hasThumb = (slot: Slot): boolean => VISIBLE.includes(slot)

export class ItemStudio {
  private readonly scene = new Scene()
  private readonly cam = new PerspectiveCamera(20, 1, 0.05, 30)
  private readonly rt = new WebGLRenderTarget(SIZE, SIZE, { samples: 4 })
  private readonly cache = new Map<string, HTMLCanvasElement>()
  private readonly gl: WebGLRenderer
  private readonly model: GLTF
  private readonly gun: PropDef | null

  constructor(gl: WebGLRenderer, model: GLTF, gun: PropDef | null) {
    this.gl = gl
    this.model = model
    this.gun = gun
    this.rt.texture.colorSpace = SRGBColorSpace
    this.scene.background = new Color(0x3e_33_29)
    const key = new DirectionalLight(0xff_f2_e0, 3.4)
    key.position.set(-1.4, 2, 2)
    const rim = new DirectionalLight(0xff_d8_a8, 1.6)
    rim.position.set(1.6, 1.2, -1.4)
    this.scene.add(key, rim, new AmbientLight(0xff_ff_ff, 0.8))
    // something for polished metal to reflect, or a gilded or nickel gun renders black
    const pmrem = new PMREMGenerator(gl)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.5
    pmrem.dispose()
  }

  /** The cached thumbnail, or null when it hasn't been rendered (see `render`). */
  get(id: string): HTMLCanvasElement | null {
    return this.cache.get(id) ?? null
  }

  /** Render (or fetch) one item's thumbnail; null for kit with nothing to see. */
  render(id: ItemId): HTMLCanvasElement | null {
    const have = this.cache.get(id)
    if (have) {
      return have
    }
    const item = itemById(id)
    if (!(item && hasThumb(item.slot))) {
      return null
    }
    let subject: Object3D
    let actor: Actor | null = null
    if (item.slot === 'gun') {
      const g = this.gun ? finishedGun(this.gun, id) : null
      if (!g) {
        return null
      }
      subject = g
      g.rotation.set(0, -0.35, 0)
      this.scene.add(g)
      g.updateMatrixWorld(true)
      this.frameBox(new Box3().setFromObject(g), 1.25)
    } else {
      actor = dressedActor(this.model, this.gun, { ...DEFAULT_LOADOUT, [item.slot]: id })
      subject = actor.root
      this.scene.add(actor.root)
      actor.holsterGun()
      actor.play('Idle', 0)
      actor.update(0.4)
      actor.root.rotation.y = TURN[item.slot] ?? 0.45
      actor.root.updateMatrixWorld(true)
      this.frameActor(actor, item)
    }
    const canvas = this.shoot()
    subject.removeFromParent()
    if (actor) {
      // the baked body is his alone: free it (hats, guns and props are shared)
      for (const m of actor.meshes) {
        m.geometry.dispose()
      }
      actor.dispose()
    }
    this.cache.set(id, canvas)
    return canvas
  }

  /** Aim at the part of him this slot dresses. */
  private frameActor(a: Actor, item: CatalogItem): void {
    const slot = item.slot
    const head = a.headPos(new Vector3())
    const h = a.height
    if (slot === 'hat') {
      const box = a.hat ? new Box3().setFromObject(a.hat) : new Box3()
      // crown to brim with air around it, and the face below
      const top = Math.max(head.y + 0.22, box.isEmpty() ? 0 : box.max.y) + 0.06
      const brim = box.isEmpty() ? 0.25 : (box.max.x - box.min.x) / 2
      const bottom = head.y - 0.14 * (h / 1.78)
      this.aim(
        new Vector3(head.x, (top + bottom) / 2, head.z),
        Math.max((top - bottom) / 2, brim + 0.06),
      )
      return
    }
    if (slot === 'extra') {
      if (item.id === 'extra.tin-star') {
        const chest =
          a.spine?.getWorldPosition(new Vector3()) ?? head.clone().add(new Vector3(0, -0.3, 0))
        this.aim(chest.add(new Vector3(0.055, 0.04, 0.07)), 0.22)
      } else {
        const offset = item.id === 'extra.handlebar' ? -0.055 : -0.14
        this.aim(head.clone().add(new Vector3(0, offset, 0.035)), 0.19)
      }
      return
    }
    if (slot === 'holster' && a.holster) {
      this.aim(a.holster.getWorldPosition(new Vector3()).add(new Vector3(0, -0.04, 0)), 0.26)
      return
    }
    if (slot === 'spurs') {
      const foot = new Vector3()
      a.model.traverse((b) => {
        if (b instanceof Bone && b.name.replace(/[^a-z]/giu, '').toLowerCase() === 'footr') {
          b.getWorldPosition(foot)
        }
      })
      if (foot.lengthSq() > 0) {
        this.aim(foot.setY(Math.max(0.1, foot.y - 0.02)), 0.2)
        return
      }
    }
    const band: Record<string, [number, number]> = {
      outfit: [0.02, 1.04],
      extra: [0.5, 1.02],
      holster: [0.38, 0.64],
      spurs: [0, 0.2],
    }
    const [lo, hi] = band[slot] ?? [0.3, 1.04]
    const top = hi * h
    const bottom = lo * h
    const centre = new Vector3(head.x, (top + bottom) / 2, head.z)
    this.aim(centre, (top - bottom) / 2 + 0.04)
  }

  private frameBox(box: Box3, pad: number): void {
    const size = box.getSize(new Vector3())
    this.aim(box.getCenter(new Vector3()), (Math.max(size.x, size.y, size.z) / 2) * pad)
  }

  /** Square framing: `half` metres from the centre to each edge. */
  private aim(centre: Vector3, half: number): void {
    this.cam.fov = MathUtils.radToDeg(2 * Math.atan(half / DIST))
    this.cam.aspect = 1
    this.cam.updateProjectionMatrix()
    this.cam.position.copy(centre).add(new Vector3(0, 0.08 * half, DIST))
    this.cam.lookAt(centre)
    this.cam.updateMatrixWorld()
  }

  private shoot(): HTMLCanvasElement {
    const gl = this.gl
    const prevTarget = gl.getRenderTarget()
    const prevTone = gl.toneMapping
    const prevShadow = gl.shadowMap.autoUpdate
    gl.shadowMap.autoUpdate = false
    gl.toneMapping = ACESFilmicToneMapping
    gl.setRenderTarget(this.rt)
    gl.clear()
    gl.render(this.scene, this.cam)
    const px = new Uint8Array(SIZE * SIZE * 4)
    gl.readRenderTargetPixels(this.rt, 0, 0, SIZE, SIZE, px)
    gl.setRenderTarget(prevTarget)
    gl.toneMapping = prevTone
    gl.shadowMap.autoUpdate = prevShadow
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const img = ctx.createImageData(SIZE, SIZE)
      // GL rows are bottom-up
      for (let y = 0; y < SIZE; y++) {
        img.data.set(px.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4)
      }
      ctx.putImageData(img, 0, 0)
    }
    return canvas
  }
}
