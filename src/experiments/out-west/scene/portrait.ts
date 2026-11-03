import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  MathUtils,
  PerspectiveCamera,
  Scene,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import type { Outlaw } from '../data/outlaws.ts'
import type { Assets } from '../engine/assets.ts'
import type { Actor } from './actor.ts'
import { castActor } from './cast.ts'

/** The print, in pixels: the poster's mugshot frame (ui/poster.ts MUG, 340 × 286) at ~1.13×. */
const PW = 384
const PH = 324
const ASPECT = PW / PH
/** How far the camera stands off: long enough to keep the face from bulging. */
const DIST = 2.4

/**
 * Mugshots for the wanted posters: each outlaw's real model, rendered once offscreen from a
 * three-quarter camera, then printed like an 1880s woodcut/halftone (two ink plates, slight
 * misregistration, paper grain).
 *
 * Every sitter is framed the same way from his own measurements, whatever his height or hat: the
 * top of his hat (or crown) just inside the top edge, his shoulders and the top of his chest at
 * the bottom, his face centred. A broad brim widens the frame rather than being cut off.
 */
export class PortraitStudio {
  private readonly scene = new Scene()
  private readonly cam = new PerspectiveCamera(20, ASPECT, 0.05, 20)
  private readonly rt = new WebGLRenderTarget(PW, PH)
  private readonly cache = new Map<number, HTMLCanvasElement>()
  private readonly gl: WebGLRenderer
  private readonly assets: Assets

  constructor(gl: WebGLRenderer, assets: Assets) {
    this.gl = gl
    this.assets = assets
    this.scene.background = new Color(0xf2_ea_d8)
    const key = new DirectionalLight(0xff_ff_ff, 3.8)
    key.position.set(-1.2, 1.6, 1.4)
    const rim = new DirectionalLight(0xff_ff_ff, 1.4)
    rim.position.set(1.5, 0.8, -1.2)
    this.scene.add(key, rim, new AmbientLight(0xff_ff_ff, 0.9))
  }

  has(index: number): boolean {
    return this.cache.has(index)
  }

  get(index: number): HTMLCanvasElement | null {
    return this.cache.get(index) ?? null
  }

  /** Render (or fetch) the printed portrait. Returns null if his model isn't loaded yet. */
  render(index: number, o: Outlaw): HTMLCanvasElement | null {
    const have = this.cache.get(index)
    if (have) {
      return have
    }
    if (!this.assets.lookLoaded(o.look)) {
      return null
    }
    const actor = castActor(this.assets, {
      look: o.look,
      hat: o.hat,
      hatColor: o.hatColor,
      bandana: o.bandana,
    })
    this.scene.add(actor.root)
    actor.play('Idle', 0)
    actor.update(0.4)
    actor.root.rotation.y = 0.5
    actor.root.updateMatrixWorld(true)
    this.frame(actor)

    const gl = this.gl
    const prevTarget = gl.getRenderTarget()
    const prevTone = gl.toneMapping
    const prevShadow = gl.shadowMap.autoUpdate
    gl.shadowMap.autoUpdate = false
    gl.toneMapping = ACESFilmicToneMapping
    gl.setRenderTarget(this.rt)
    gl.clear()
    gl.render(this.scene, this.cam)
    const px = new Uint8Array(PW * PH * 4)
    gl.readRenderTargetPixels(this.rt, 0, 0, PW, PH, px)
    gl.setRenderTarget(prevTarget)
    gl.toneMapping = prevTone
    gl.shadowMap.autoUpdate = prevShadow
    actor.dispose()

    const canvas = printPortrait(px, index)
    this.cache.set(index, canvas)
    return canvas
  }

  /** Aim the camera so he sits head and shoulders in the print, hat and all. */
  private frame(actor: Actor): void {
    const head = actor.headPos(new Vector3())
    const box = new Box3()
    if (actor.hat) {
      box.setFromObject(actor.hat)
    }
    // the top of his skull is about 0.2 m over the head bone; a hat sits higher
    const top = Math.max(head.y + 0.22, box.isEmpty() ? 0 : box.max.y) + 0.035
    // half the hat's breadth (a sombrero brim is wider than his shoulders)
    const brim = box.isEmpty() ? 0 : (box.max.x - box.min.x) / 2
    // the bottom edge: the top of his chest, a little under the shoulder line
    const bottom = head.y - 0.36 * (actor.height / 1.78)
    const half = Math.max((top - bottom) / 2, (Math.max(brim, 0.25) + 0.03) / ASPECT)
    const centre = new Vector3(head.x, top - half, head.z)
    this.cam.fov = MathUtils.radToDeg(2 * Math.atan(half / DIST))
    this.cam.aspect = ASPECT
    this.cam.updateProjectionMatrix()
    this.cam.position.copy(centre).add(new Vector3(0.12, 0.05, DIST))
    this.cam.lookAt(centre)
    this.cam.updateMatrixWorld()
  }
}

function rand(seed: number): () => number {
  let s = seed >>> 0 || 7
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 100_000) / 100_000
  }
}

/** Luminance of a linear RGBA buffer (bottom-up rows), gamma-encoded and flipped to top-down. */
function luminance(px: Uint8Array): Float32Array {
  const L = new Float32Array(PW * PH)
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const i = ((PH - 1 - y) * PW + x) * 4
      const r = (px[i] ?? 0) / 255
      const g = (px[i + 1] ?? 0) / 255
      const b = (px[i + 2] ?? 0) / 255
      const l = 0.299 * r + 0.587 * g + 0.114 * b
      L[y * PW + x] = Math.min(1, Math.max(0, (l ** (1 / 2.2) - 0.08) * 1.35))
    }
  }
  return L
}

/** One halftone plate of dots, `cell` px apart, offset (ox, oy). */
function plate(
  ctx: CanvasRenderingContext2D,
  L: Float32Array,
  ink: { ox: number; oy: number; color: string; gain: number },
): void {
  const cell = 3
  ctx.fillStyle = ink.color
  for (let y = 0; y + cell <= PH; y += cell) {
    for (let x = 0; x + cell <= PW; x += cell) {
      let sum = 0
      for (let j = 0; j < cell; j++) {
        for (let i = 0; i < cell; i++) {
          sum += L[(y + j) * PW + x + i] ?? 1
        }
      }
      const d = 1 - sum / (cell * cell)
      if (d < 0.06) {
        continue
      }
      const r = Math.sqrt(d) * cell * 0.72 * ink.gain
      ctx.beginPath()
      ctx.arc(x + cell / 2 + ink.ox, y + cell / 2 + ink.oy, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

/** Engraved edges (Sobel) darkened into the plates, for line work. */
function edges(ctx: CanvasRenderingContext2D, L: Float32Array): void {
  const img = ctx.getImageData(0, 0, PW, PH)
  const d = img.data
  const g = (xx: number, yy: number) => L[yy * PW + xx] ?? 1
  for (let y = 1; y < PH - 1; y++) {
    for (let x = 1; x < PW - 1; x++) {
      const gx =
        g(x + 1, y - 1) +
        2 * g(x + 1, y) +
        g(x + 1, y + 1) -
        g(x - 1, y - 1) -
        2 * g(x - 1, y) -
        g(x - 1, y + 1)
      const gy =
        g(x - 1, y + 1) +
        2 * g(x, y + 1) +
        g(x + 1, y + 1) -
        g(x - 1, y - 1) -
        2 * g(x, y - 1) -
        g(x + 1, y - 1)
      const e = Math.min(1, Math.hypot(gx, gy) * 1.6)
      if (e > 0.25) {
        const i = (y * PW + x) * 4
        const k = 1 - e * 0.85
        d[i] = (d[i] ?? 0) * k
        d[i + 1] = (d[i + 1] ?? 0) * k
        d[i + 2] = (d[i + 2] ?? 0) * k
      }
    }
  }
  ctx.putImageData(img, 0, 0)
}

/** Halftone + engraved-edge print of a linear RGBA buffer (bottom-up rows). */
function printPortrait(px: Uint8Array, seed: number): HTMLCanvasElement {
  const L = luminance(px)
  const c = document.createElement('canvas')
  c.width = PW
  c.height = PH
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    return c
  }
  const rnd = rand(seed * 977 + 3)
  // white: the poster multiplies this print onto its own paper stock
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, PW, PH)
  // brown plate slightly off register, then the black key plate
  plate(ctx, L, { ox: 1.4, oy: -1.0, color: 'rgba(138,58,28,0.35)', gain: 1.05 })
  plate(ctx, L, { ox: 0, oy: 0, color: 'rgba(36,22,12,0.92)', gain: 1 })
  edges(ctx, L)
  // an engraver's oval vignette, wide and low so the shoulders print: only the corners fade
  const v = ctx.createRadialGradient(PW / 2, PH * 0.5, PH * 0.42, PW / 2, PH * 0.56, PW * 0.68)
  v.addColorStop(0, 'rgba(255,255,255,0)')
  v.addColorStop(1, 'rgba(255,255,255,0.9)')
  ctx.fillStyle = v
  ctx.fillRect(0, 0, PW, PH)
  // ink wear: a few pale scratches
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'
  for (let k = 0; k < 6; k++) {
    ctx.lineWidth = 0.5 + rnd()
    ctx.beginPath()
    const x = rnd() * PW
    ctx.moveTo(x, 0)
    ctx.lineTo(x + (rnd() - 0.5) * 40, PH)
    ctx.stroke()
  }
  return c
}
