// biome-ignore-all lint/style/noMultiAssign: canvas/texture dimension setup (w = h = n) is clearer chained
import {
  CanvasTexture,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
} from 'three'
import { FONT } from '../ui/type.ts'

/** Painted signs use the display wood type (see ui/type.ts). */
export const SLAB = FONT.display

const loader = new TextureLoader()
const WEBP = /\.webp$/iu

/**
 * Phone tiers read the half-size WebP variants (generated beside each map): the download is about
 * a fifth of the full set, which is the difference between a fast first load and a slow one on
 * mobile data. A missing variant falls back to the full file, then to the flat colour.
 */
let lowRes = false

export function setLowRes(on: boolean): void {
  lowRes = on
}

function flatTexture(srgb: boolean): Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 4
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.fillStyle = srgb ? '#a08060' : '#8080ff'
    ctx.fillRect(0, 0, 4, 4)
  }
  const t = new CanvasTexture(c)
  if (srgb) {
    t.colorSpace = SRGBColorSpace
  }
  return t
}

export function loadTex(url: string, srgb: boolean, anisotropy: number): Promise<Texture> {
  const half = lowRes ? url.replace(WEBP, '-half.webp') : url
  return new Promise((resolve) => {
    const done = (t: Texture): void => {
      t.wrapS = RepeatWrapping
      t.wrapT = RepeatWrapping
      t.anisotropy = anisotropy
      t.minFilter = LinearMipmapLinearFilter
      if (srgb) {
        t.colorSpace = SRGBColorSpace
      }
      resolve(t)
    }
    const load = (from: string, fallback: string | null): void => {
      loader.load(from, done, undefined, () => {
        if (fallback) {
          load(fallback, null)
        } else {
          // Fall back to a flat texture; the scene still renders.
          resolve(flatTexture(srgb))
        }
      })
    }
    load(half, half === url ? null : url)
  })
}

export interface SignSpec {
  text: string
  bg: string
  fg: string
}

/** All storefront signs on one canvas, one per row. */
export function signAtlas(signs: SignSpec[]): { tex: CanvasTexture; rows: number } {
  const rows = signs.length
  const w = 1024
  const rh = 128
  const c = document.createElement('canvas')
  c.width = w
  c.height = rh * rows
  const ctx = c.getContext('2d')
  if (ctx) {
    signs.forEach((s, i) => {
      const y = i * rh
      ctx.fillStyle = s.bg
      ctx.fillRect(0, y, w, rh)
      // weathering streaks
      for (let k = 0; k < 120; k++) {
        ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`
        ctx.fillRect(Math.random() * w, y + Math.random() * rh, 30 + Math.random() * 200, 2)
      }
      ctx.strokeStyle = s.fg
      ctx.lineWidth = 6
      ctx.strokeRect(10, y + 10, w - 20, rh - 20)
      ctx.fillStyle = s.fg
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      let size = 82
      ctx.font = `${size}px ${SLAB}`
      while (ctx.measureText(s.text).width > w - 80 && size > 30) {
        size -= 4
        ctx.font = `${size}px ${SLAB}`
      }
      ctx.save()
      ctx.translate(w / 2, y + rh / 2 + 4)
      ctx.scale(1, 1)
      ctx.fillText(s.text, 0, 0)
      ctx.restore()
    })
  }
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 4
  return { tex, rows }
}

/** Soft round sprite for particles. */
export function softDot(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.4, 'rgba(255,255,255,0.5)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  }
  return new CanvasTexture(c)
}
