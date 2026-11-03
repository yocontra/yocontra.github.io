// biome-ignore-all lint/complexity/useMaxParams: canvas drawing helpers take positional coordinates
/**
 * The minimap: the whole of Perdition (north up, like the camera), baked once from the layout,
 * with live dots drawn over it at 10 Hz: you (an arrow), other players in interest, money bags,
 * the strongbox, and the Most Wanted gold star (which rides the town section, so it shows from
 * anywhere in town).
 */
import type { TownLayout } from '../sim/layout.ts'

export interface MapDot {
  x: number
  z: number
}

export interface MapFrame {
  self: (MapDot & { aim: number }) | null
  others: readonly MapDot[]
  bags: readonly MapDot[]
  strongbox: MapDot | null
  mostWanted: (MapDot & { you: boolean }) | null
  callout: MapDot | null
}

const PAD = 4
const BUILDING_FILL: Record<string, string> = { bank: '#e8c060', stage_line: '#9ac0a0' }

export class Minimap {
  readonly el: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly base: HTMLCanvasElement
  private readonly size: number
  private readonly px: number
  private readonly scale: number

  constructor(layout: TownLayout, cssSize: number) {
    this.size = cssSize
    this.px = Math.round(cssSize * Math.min(2, window.devicePixelRatio || 1))
    this.scale = (this.px - PAD * 2) / layout.size
    this.el = document.createElement('canvas')
    this.el.className = 'fr-map'
    this.el.width = this.px
    this.el.height = this.px
    this.el.style.width = `${cssSize}px`
    this.el.style.height = `${cssSize}px`
    this.el.setAttribute('aria-label', 'Map of Perdition')
    this.ctx = this.el.getContext('2d')
    this.base = this.bake(layout)
  }

  private bake(layout: TownLayout): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = this.px
    c.height = this.px
    const ctx = c.getContext('2d')
    if (!ctx) {
      return c
    }
    const k = this.scale
    ctx.fillStyle = 'rgba(52, 38, 26, 0.82)'
    ctx.beginPath()
    ctx.roundRect(0, 0, this.px, this.px, this.px * 0.08)
    ctx.fill()
    ctx.save()
    ctx.translate(PAD, PAD)
    ctx.scale(k, k)
    ctx.fillStyle = '#c8a878'
    ctx.fillRect(
      0,
      layout.creek.z + layout.creek.d,
      layout.size,
      layout.size - layout.creek.z - layout.creek.d,
    )
    ctx.fillStyle = '#4a7480'
    ctx.fillRect(layout.creek.x, layout.creek.z + 1.4, layout.creek.w, layout.creek.d - 2.6)
    ctx.fillStyle = '#9a7a54'
    const br = layout.creek.bridge
    ctx.fillRect(br.x, br.z, br.w, br.d)
    ctx.fillStyle = '#b08e62'
    for (const s of layout.streets) {
      ctx.fillRect(s.x, s.z, s.w, s.d)
    }
    for (const b of layout.buildings) {
      ctx.fillStyle = BUILDING_FILL[b.kind] ?? '#5a4434'
      ctx.fillRect(b.x, b.z, b.w, b.d)
    }
    ctx.fillStyle = '#7a6046'
    for (const c2 of layout.cover) {
      ctx.fillRect(c2.x, c2.z, Math.max(1, c2.w), Math.max(1, c2.d))
    }
    // Bank: a $ on the roof.
    const bank = layout.buildings.find((b) => b.kind === 'bank')
    if (bank) {
      ctx.fillStyle = '#3a2810'
      ctx.font = `bold ${bank.d * 0.8}px Georgia, serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('$', bank.x + bank.w / 2, bank.z + bank.d / 2 + 1)
    }
    ctx.restore()
    return c
  }

  private at(d: MapDot): [number, number] {
    return [PAD + d.x * this.scale, PAD + d.z * this.scale]
  }

  draw(f: MapFrame, nowS: number): void {
    const ctx = this.ctx
    if (!ctx) {
      return
    }
    const r = this.px / this.size
    ctx.clearRect(0, 0, this.px, this.px)
    ctx.drawImage(this.base, 0, 0)
    ctx.fillStyle = '#ffd860'
    for (const b of f.bags) {
      const [x, y] = this.at(b)
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
    ctx.fillStyle = '#e04a32'
    for (const o of f.others) {
      const [x, y] = this.at(o)
      ctx.beginPath()
      ctx.arc(x, y, 2.2 * r, 0, Math.PI * 2)
      ctx.fill()
    }
    if (f.strongbox) {
      const [x, y] = this.at(f.strongbox)
      const p = 1 + Math.sin(nowS * 5) * 0.2
      ctx.fillStyle = '#ffcf4a'
      ctx.strokeStyle = '#2a1a08'
      ctx.lineWidth = r
      ctx.fillRect(x - 3.5 * r * p, y - 2.5 * r * p, 7 * r * p, 5 * r * p)
      ctx.strokeRect(x - 3.5 * r * p, y - 2.5 * r * p, 7 * r * p, 5 * r * p)
    }
    if (f.callout) {
      const [x, y] = this.at(f.callout)
      ctx.strokeStyle = '#ff5a3a'
      ctx.lineWidth = 1.5 * r
      ctx.beginPath()
      ctx.arc(x, y, (5 + Math.sin(nowS * 8)) * r, 0, Math.PI * 2)
      ctx.stroke()
    }
    if (f.mostWanted) {
      const [x, y] = this.at(f.mostWanted)
      star(ctx, x, y, (f.mostWanted.you ? 6 : 5.5) * r, nowS)
    }
    if (f.self) {
      const [x, y] = this.at(f.self)
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(f.self.aim)
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = '#1a120a'
      ctx.lineWidth = r
      ctx.beginPath()
      ctx.moveTo(5 * r, 0)
      ctx.lineTo(-3.5 * r, 3.2 * r)
      ctx.lineTo(-2 * r, 0)
      ctx.lineTo(-3.5 * r, -3.2 * r)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
  }
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, rad: number, t: number): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(Math.sin(t * 2) * 0.15)
  ctx.beginPath()
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2
    const rr = i % 2 === 0 ? rad : rad * 0.45
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr)
  }
  ctx.closePath()
  ctx.fillStyle = '#ffd030'
  ctx.strokeStyle = '#3a2400'
  ctx.lineWidth = rad * 0.18
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}
