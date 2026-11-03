// biome-ignore-all lint/style/noMultiAssign: canvas/texture dimension setup (w = h = n) is clearer chained
import {
  CanvasTexture,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
} from 'three'

export const SLAB = '"Alfa Slab One", Rockwell, "Rockwell Extra Bold", Georgia, serif'

const loader = new TextureLoader()

export function loadTex(url: string, srgb: boolean, anisotropy: number): Promise<Texture> {
  return new Promise((resolve) => {
    loader.load(
      url,
      (t) => {
        t.wrapS = RepeatWrapping
        t.wrapT = RepeatWrapping
        t.anisotropy = anisotropy
        t.minFilter = LinearMipmapLinearFilter
        if (srgb) {
          t.colorSpace = SRGBColorSpace
        }
        resolve(t)
      },
      undefined,
      () => {
        // Fall back to a flat texture; the scene still renders.
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
        resolve(t)
      },
    )
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

/** Clock face: roman numerals, hands at the given hour/minute. */
export function clockCanvas(): { canvas: HTMLCanvasElement; draw: (h: number, m: number) => void } {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')
  const draw = (h: number, m: number) => {
    if (!ctx) {
      return
    }
    ctx.clearRect(0, 0, 256, 256)
    ctx.fillStyle = '#efe6cf'
    ctx.beginPath()
    ctx.arc(128, 128, 124, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineWidth = 8
    ctx.strokeStyle = '#2a1d12'
    ctx.stroke()
    ctx.fillStyle = '#2a1d12'
    ctx.font = 'bold 26px Georgia, serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const nums = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI']
    nums.forEach((n, i) => {
      const a = (i / 12) * Math.PI * 2
      ctx.fillText(n, 128 + Math.sin(a) * 96, 128 - Math.cos(a) * 96)
    })
    const hand = (a: number, len: number, wdt: number) => {
      ctx.lineWidth = wdt
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(128, 128)
      ctx.lineTo(128 + Math.sin(a) * len, 128 - Math.cos(a) * len)
      ctx.stroke()
    }
    hand(((h % 12) / 12 + m / 720) * Math.PI * 2, 56, 9)
    hand((m / 60) * Math.PI * 2, 84, 5)
  }
  draw(12, 0)
  return { canvas: c, draw }
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
