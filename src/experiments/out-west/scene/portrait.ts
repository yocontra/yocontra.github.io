// biome-ignore-all lint/style/noMultiAssign: canvas/texture dimension setup (w = h = n) is clearer chained
// biome-ignore-all lint/style/noParameterProperties: legacy constructor shorthand; behaviour-neutral
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import type { Outlaw } from '../data/outlaws.ts'
import type { Assets } from '../engine/assets.ts'
import { castActor } from './cast.ts'

const SIZE = 384

/**
 * Mugshots for the wanted posters: each outlaw's real model, rendered once
 * offscreen from a fixed three-quarter camera, then printed like an 1880s
 * woodcut/halftone (two ink plates, slight misregistration, paper grain).
 */
export class PortraitStudio {
  private readonly scene = new Scene()
  private readonly cam = new PerspectiveCamera(24, 1, 0.05, 20)
  private readonly rt = new WebGLRenderTarget(SIZE, SIZE)
  private readonly cache = new Map<number, HTMLCanvasElement>()

  constructor(
    private readonly gl: WebGLRenderer,
    private readonly assets: Assets,
  ) {
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
    actor.mixer.update(0.4)
    actor.root.rotation.y = 0.5
    actor.root.updateMatrixWorld(true)
    const head = actor.headPos(new Vector3())
    const target = head.clone().add(new Vector3(0, 0.1, 0))
    this.cam.position.copy(target).add(new Vector3(0.1, 0.06, 1.55))
    this.cam.lookAt(target.clone().add(new Vector3(0, -0.06, 0)))
    this.cam.updateMatrixWorld()

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
    actor.dispose()

    const canvas = printPortrait(px, index)
    this.cache.set(index, canvas)
    return canvas
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

/** Halftone + engraved-edge print of a linear RGBA buffer (bottom-up rows). */
function printPortrait(px: Uint8Array, seed: number): HTMLCanvasElement {
  const N = SIZE
  // luminance, gamma-encoded, flipped to top-down
  const L = new Float32Array(N * N)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = ((N - 1 - y) * N + x) * 4
      const r = (px[i] ?? 0) / 255
      const g = (px[i + 1] ?? 0) / 255
      const b = (px[i + 2] ?? 0) / 255
      const l = 0.299 * r + 0.587 * g + 0.114 * b
      L[y * N + x] = Math.min(1, Math.max(0, (l ** (1 / 2.2) - 0.08) * 1.35))
    }
  }
  const c = document.createElement('canvas')
  c.width = c.height = N
  const ctx = c.getContext('2d')
  if (!ctx) {
    return c
  }
  const rnd = rand(seed * 977 + 3)
  // white: the poster multiplies this print onto its own paper stock
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, N, N)
  const cell = 3
  const plate = (ox: number, oy: number, color: string, gain: number) => {
    ctx.fillStyle = color
    for (let y = 0; y < N; y += cell) {
      for (let x = 0; x < N; x += cell) {
        let sum = 0
        for (let j = 0; j < cell; j++) {
          for (let i = 0; i < cell; i++) {
            sum += L[(y + j) * N + x + i] ?? 1
          }
        }
        const d = 1 - sum / (cell * cell)
        if (d < 0.06) {
          continue
        }
        const r = Math.sqrt(d) * cell * 0.72 * gain
        ctx.beginPath()
        ctx.arc(x + cell / 2 + ox, y + cell / 2 + oy, r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  // brown plate slightly off register, then the black key plate
  plate(1.4, -1.0, 'rgba(138,58,28,0.35)', 1.05)
  plate(0, 0, 'rgba(36,22,12,0.92)', 1)
  // engraved edges (Sobel) for line work
  const img = ctx.getImageData(0, 0, N, N)
  const d = img.data
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const g = (xx: number, yy: number) => L[yy * N + xx] ?? 1
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
        const i = (y * N + x) * 4
        const k = 1 - e * 0.85
        d[i] = (d[i] ?? 0) * k
        d[i + 1] = (d[i + 1] ?? 0) * k
        d[i + 2] = (d[i + 2] ?? 0) * k
      }
    }
  }
  ctx.putImageData(img, 0, 0)
  // an engraver's oval vignette: the print fades into the paper instead of ending at a hard edge
  const v = ctx.createRadialGradient(N / 2, N * 0.44, N * 0.3, N / 2, N * 0.5, N * 0.62)
  v.addColorStop(0, 'rgba(255,255,255,0)')
  v.addColorStop(1, 'rgba(255,255,255,0.92)')
  ctx.fillStyle = v
  ctx.fillRect(0, 0, N, N)
  // ink wear: a few pale scratches
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'
  for (let k = 0; k < 6; k++) {
    ctx.lineWidth = 0.5 + rnd()
    ctx.beginPath()
    const x = rnd() * N
    ctx.moveTo(x, 0)
    ctx.lineTo(x + (rnd() - 0.5) * 40, N)
    ctx.stroke()
  }
  return c
}
