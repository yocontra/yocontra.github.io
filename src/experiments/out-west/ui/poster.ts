/**
 * The wanted posters, painted on canvas: real poster stock (aged newsprint with nail holes and
 * folds), letterpress wood type with worn ink, the outlaw's printed mugshot in a ruled frame, and
 * rubber stamps (PAID, NO BOUNTY) that look pressed rather than drawn.
 *
 * Canvas never swaps in a late font, so callers paint only after `loadPosterArt()` (fonts and the
 * stock image); before that a procedural paper stands in for the stock.
 */
import type { HatKey, Outlaw } from '../data/outlaws.ts'
import { canvasFont, loadFonts } from './type.ts'

const W = 620
const H = 860
const INK = '#1d140c'
const RED_INK = '#9e2218'
const STAMP_RED = '#b0180f'

let stock: HTMLImageElement | null = null
let stockReady = false as boolean
let art: Promise<void> | null = null

/** Fonts plus the poster stock image. Resolves even if the image fails (a painted stock stands in). */
export function loadPosterArt(): Promise<void> {
  if (art) {
    return art
  }
  const img = new Image()
  img.decoding = 'async'
  img.src = '/experiments/out-west/ui/poster.webp'
  stock = img
  art = Promise.all([
    loadFonts(),
    img
      .decode()
      .then(() => {
        stockReady = true
      })
      .catch(() => undefined),
  ]).then(() => undefined)
  return art
}

function rnd(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 10_000) / 10_000
  }
}

function hatPath(ctx: CanvasRenderingContext2D, hat: HatKey, cx: number, top: number): void {
  ctx.beginPath()
  switch (hat) {
    case 'sombrero':
      ctx.ellipse(cx, top + 70, 120, 18, 0, 0, Math.PI * 2)
      ctx.moveTo(cx - 40, top + 70)
      ctx.quadraticCurveTo(cx, top - 30, cx + 40, top + 70)
      break
    case 'tophat':
      ctx.rect(cx - 36, top - 10, 72, 80)
      ctx.ellipse(cx, top + 70, 62, 10, 0, 0, Math.PI * 2)
      break
    case 'bowler':
      ctx.ellipse(cx, top + 70, 62, 10, 0, 0, Math.PI * 2)
      ctx.moveTo(cx - 42, top + 72)
      ctx.bezierCurveTo(cx - 44, top + 5, cx + 44, top + 5, cx + 42, top + 72)
      break
    case 'flat':
      ctx.ellipse(cx, top + 70, 80, 11, 0, 0, Math.PI * 2)
      ctx.rect(cx - 44, top + 28, 88, 44)
      break
    default:
      ctx.moveTo(cx - 95, top + 58)
      ctx.quadraticCurveTo(cx, top + 92, cx + 95, top + 58)
      ctx.quadraticCurveTo(cx + 60, top + 76, cx + 44, top + 70)
      ctx.bezierCurveTo(cx + 46, top + 8, cx + 16, top + 18, cx, top + 24)
      ctx.bezierCurveTo(cx - 16, top + 18, cx - 46, top + 8, cx - 44, top + 70)
      ctx.quadraticCurveTo(cx - 60, top + 76, cx - 95, top + 58)
  }
  ctx.fill()
}

export interface PosterOpts {
  index: number
  stamp?: 'coward' | 'dead' | null
  /** Printed mugshot of his actual model (see PortraitStudio). */
  portrait?: HTMLCanvasElement | null
}

/** The sheet: the photographed stock, or a painted stand-in until it decodes. */
function paper(ctx: CanvasRenderingContext2D, r: () => number): void {
  if (stock && stockReady) {
    const k = Math.max(W / stock.naturalWidth, H / stock.naturalHeight)
    const dw = stock.naturalWidth * k
    const dh = stock.naturalHeight * k
    ctx.drawImage(stock, (W - dw) / 2, (H - dh) / 2, dw, dh)
    return
  }
  const g = ctx.createRadialGradient(W / 2, H / 2, 100, W / 2, H / 2, 620)
  g.addColorStop(0, '#ecdcb4')
  g.addColorStop(0.7, '#d9c08c')
  g.addColorStop(1, '#9c7a48')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = `rgba(${90 + r() * 40},${60 + r() * 30},20,${r() * 0.07})`
    ctx.fillRect(r() * W, r() * H, 1 + r() * 3, 1 + r() * 3)
  }
}

/**
 * Worn letterpress: knock tiny flecks out of everything inked inside the box, the way a tired
 * wood-type forme prints on cheap stock.
 */
function wear(
  ctx: CanvasRenderingContext2D,
  box: [number, number, number, number],
  r: () => number,
): void {
  const [x, y, w, h] = box
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  const n = Math.round((w * h) / 90)
  for (let i = 0; i < n; i++) {
    ctx.globalAlpha = 0.25 + r() * 0.6
    ctx.fillRect(x + r() * w, y + r() * h, 0.6 + r() * 1.8, 0.6 + r() * 1.4)
  }
  ctx.restore()
}

/**
 * Uneven pressure: a forme inked by hand prints lighter in broad soft patches, not just in specks.
 */
function unevenInk(ctx: CanvasRenderingContext2D, r: () => number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 16; i++) {
    const x = r() * W
    const y = r() * H
    const rad = 60 + r() * 160
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad)
    g.addColorStop(0, `rgba(0,0,0,${0.06 + r() * 0.14})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2)
  }
  ctx.restore()
}

/**
 * Paint ink on its own layer (so wear only eats ink, never the paper), then lay it down: first a
 * faint spread where the ink wicked into the fibres, then the crisp impression.
 */
function inkLayer(
  base: CanvasRenderingContext2D,
  r: () => number,
  paint: (ctx: CanvasRenderingContext2D) => void,
): void {
  const layer = document.createElement('canvas')
  layer.width = W
  layer.height = H
  const ctx = layer.getContext('2d')
  if (!ctx) {
    paint(base)
    return
  }
  paint(ctx)
  unevenInk(ctx, r)
  wear(ctx, [0, 0, W, H], r)
  base.save()
  base.globalCompositeOperation = 'multiply'
  base.globalAlpha = 0.3
  base.filter = 'blur(1.2px)'
  base.drawImage(layer, 0, 0)
  base.filter = 'none'
  base.globalAlpha = 0.94
  base.drawImage(layer, 0, 0)
  base.restore()
}

/** The frame of the mugshot. */
const MUG = { x: 140, y: 236, w: W - 280, h: 286 } as const

/** Tone levels of a portrait: luminance stretched between its 2nd and 98th percentiles. */
function levels(px: Uint8ClampedArray): Float32Array {
  const n = px.length / 4
  const lum = new Float32Array(n)
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) {
    const a = (px[i * 4 + 3] ?? 0) / 255
    // transparent pixels are bare paper
    const l =
      (0.299 * (px[i * 4] ?? 0) + 0.587 * (px[i * 4 + 1] ?? 0) + 0.114 * (px[i * 4 + 2] ?? 0)) * a +
      255 * (1 - a)
    lum[i] = l
    hist[Math.min(255, Math.round(l))] = (hist[Math.min(255, Math.round(l))] ?? 0) + 1
  }
  const pct = (p: number): number => {
    let acc = 0
    for (let v = 0; v < 256; v++) {
      acc += hist[v] ?? 0
      if (acc >= n * p) {
        return v
      }
    }
    return 255
  }
  const lo = pct(0.02)
  const hi = Math.max(lo + 1, pct(0.98))
  for (let i = 0; i < n; i++) {
    lum[i] = Math.min(1, Math.max(0, ((lum[i] ?? 0) - lo) / (hi - lo)))
  }
  return lum
}

/** A per-pixel hash in [0, 1): the grain of the screen (stable per poster, no allocation). */
function grain(i: number, j: number): number {
  let h = (i * 374_761_393 + j * 668_265_263) | 0
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177)
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296
}

const smoothstep = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Print the mugshot the way a cheap jobbing press did: a coarse stochastic screen of ink on the
 * stock (soft-thresholded noise, so it reads as grainy print up close and averages to clean tone
 * when the poster is small; a regular line screen moirés), midtones lifted so a face survives,
 * and an oval vignette fading the sitter into bare paper like a period cabinet card.
 */
function engrave(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement): void {
  const { x, y, w, h } = MUG
  const off = document.createElement('canvas')
  off.width = w
  off.height = h
  const o = off.getContext('2d', { willReadFrequently: true })
  if (!o) {
    return
  }
  const k = Math.max(w / src.width, h / src.height)
  o.drawImage(src, (w - src.width * k) / 2, (h - src.height * k) / 2, src.width * k, src.height * k)
  const img = o.getImageData(0, 0, w, h)
  const lum = levels(img.data)
  const out = o.createImageData(w, h)
  const d = out.data
  // INK, as bytes
  const ink = [0x1d, 0x14, 0x0c]
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = j * w + i
      const u = (i / w - 0.5) * 2
      const v = (j / h - 0.46) * 2
      // wide and low: the hat and the shoulders print, only the corners fade into the paper
      const oval = 1 - smoothstep(0.8, 1.22, Math.hypot(u * 0.8, v * 0.74))
      const dark = smoothstep(0.2, 1, 1 - (lum[p] ?? 1)) ** 1.4 * oval
      const n = grain(i, j)
      const cover = smoothstep(n - 0.28, n + 0.28, dark)
      d[p * 4] = ink[0] ?? 0
      d[p * 4 + 1] = ink[1] ?? 0
      d[p * 4 + 2] = ink[2] ?? 0
      d[p * 4 + 3] = Math.round(cover * 255)
    }
  }
  o.putImageData(out, 0, 0)
  ctx.drawImage(off, x, y)
}

/** Set a line of type at the largest size (≤ max) that fits the measure. */
function fitType(
  ctx: CanvasRenderingContext2D,
  text: string,
  o: {
    role: 'display' | 'ornate' | 'text'
    max: number
    min: number
    measure: number
    track?: number
  },
): number {
  let size = o.max
  const set = (): void => {
    ctx.font = canvasFont(o.role, size)
    ctx.letterSpacing = `${(o.track ?? 0) * size}px`
  }
  set()
  while (ctx.measureText(text).width > o.measure && size > o.min) {
    size -= 2
    set()
  }
  return size
}

/** A thin rule with a diamond in the middle. */
function rule(ctx: CanvasRenderingContext2D, y: number, x0: number, x1: number): void {
  const cx = (x0 + x1) / 2
  ctx.fillRect(x0, y - 1, cx - 10 - x0, 2)
  ctx.fillRect(cx + 10, y - 1, x1 - cx - 10, 2)
  ctx.beginPath()
  ctx.moveTo(cx, y - 6)
  ctx.lineTo(cx + 7, y)
  ctx.lineTo(cx, y + 6)
  ctx.lineTo(cx - 7, y)
  ctx.closePath()
  ctx.fill()
}

function portraitBox(
  ctx: CanvasRenderingContext2D,
  o: Outlaw,
  opts: PosterOpts,
  r: () => number,
): void {
  const { x: px, y: py, w: pw, h: ph } = MUG
  if (opts.portrait) {
    const pr = opts.portrait
    // a whisper of the photograph's tone under the engraving, then the engraving in ink
    ctx.save()
    ctx.beginPath()
    ctx.rect(px, py, pw, ph)
    ctx.clip()
    const k = Math.max(pw / pr.width, ph / pr.height)
    ctx.globalCompositeOperation = 'multiply'
    ctx.globalAlpha = 0.22
    ctx.filter = 'grayscale(1) sepia(0.5)'
    ctx.drawImage(
      pr,
      px + (pw - pr.width * k) / 2,
      py + (ph - pr.height * k) / 2,
      pr.width * k,
      pr.height * k,
    )
    ctx.restore()
    inkLayer(ctx, r, (k2) => engrave(k2, pr))
    return
  }
  ctx.save()
  ctx.beginPath()
  ctx.rect(px, py, pw, ph)
  ctx.clip()
  {
    // silhouette while his model streams in
    ctx.fillStyle = 'rgba(201,173,122,0.6)'
    ctx.fillRect(px, py, pw, ph)
    ctx.fillStyle = '#24170c'
    const cx = W / 2
    ctx.beginPath()
    ctx.ellipse(cx, py + 160, 48, 60, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(cx - 140, py + ph)
    ctx.bezierCurveTo(cx - 130, py + 230, cx - 60, py + 220, cx - 30, py + 210)
    ctx.lineTo(cx + 30, py + 210)
    ctx.bezierCurveTo(cx + 60, py + 220, cx + 130, py + 230, cx + 140, py + ph)
    ctx.fill()
    hatPath(ctx, o.hat, cx, py + 36)
  }
  ctx.restore()
}

/** Draw a wanted poster onto a canvas. */
export function drawPoster(canvas: HTMLCanvasElement, o: Outlaw, opts: PosterOpts): void {
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return
  }
  const r = rnd(opts.index * 7919 + 13)
  paper(ctx, r)
  // the mugshot is printed first, so the type and frame overprint its edge like a real forme
  portraitBox(ctx, o, opts, r)

  inkLayer(ctx, r, (k) => {
    k.fillStyle = INK
    k.strokeStyle = INK
    k.textAlign = 'center'
    k.textBaseline = 'alphabetic'
    // a printer's double border, inset from the torn margin
    k.lineWidth = 5
    k.strokeRect(34, 34, W - 68, H - 68)
    k.lineWidth = 1.5
    k.strokeRect(44, 44, W - 88, H - 88)

    fitType(k, 'WANTED', { role: 'display', max: 132, min: 80, measure: W - 120, track: 0.03 })
    k.fillText('WANTED', W / 2 + 2, 166)
    k.letterSpacing = '0px'

    const sub = opts.index >= 15 ? 'DEAD ONLY' : 'DEAD OR ALIVE'
    k.font = canvasFont('ornate', 30)
    k.letterSpacing = '4px'
    k.fillText(sub, W / 2 + 2, 210)
    k.letterSpacing = '0px'

    // the mugshot frame: a heavy rule and a hairline
    k.lineWidth = 4
    k.strokeRect(140, 236, W - 280, 286)
    k.lineWidth = 1.2
    k.strokeRect(132, 228, W - 264, 302)

    const name = o.name.toUpperCase()
    fitType(k, name, { role: 'display', max: 52, min: 22, measure: W - 120, track: 0.02 })
    k.fillText(name, W / 2, 586)
    k.letterSpacing = '0px'
    k.font = canvasFont('text', 30, { italic: true })
    k.fillText(o.epithet, W / 2, 624)
    rule(k, 646, 150, W - 150)
    k.font = canvasFont('text', 24)
    wrap(k, o.hook, { x: W / 2, y: 682, max: W - 150, lh: 27 })

    k.font = canvasFont('ornate', 24)
    k.letterSpacing = '10px'
    k.fillText('REWARD', W / 2 + 5, 812)
    k.letterSpacing = '0px'
  })
  // the bounty in red ink, its own pass of the press (slightly off register)
  inkLayer(ctx, r, (k) => {
    k.fillStyle = RED_INK
    k.textAlign = 'center'
    k.font = canvasFont('display', 70)
    k.letterSpacing = '2px'
    k.fillText(`$${o.bounty.toLocaleString('en-US')}`, W / 2 + 1.5, 784)
    k.letterSpacing = '0px'
  })

  if (opts.stamp === 'coward') {
    stamp(ctx, r, { lines: ['SHOT IN THE BACK', 'NO BOUNTY'], rot: -0.26 })
  }
  if (opts.stamp === 'dead') {
    stamp(ctx, r, { lines: ['PAID'], rot: -0.18 })
  }
}

/** Where wrapped text goes: centre x, first baseline y, max line width, line height. */
interface TextBox {
  x: number
  y: number
  max: number
  lh: number
}

function wrap(ctx: CanvasRenderingContext2D, text: string, box: TextBox): void {
  const { x, y, max, lh } = box
  const words = text.split(' ')
  let line = ''
  let yy = y
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (ctx.measureText(test).width > max && line) {
      ctx.fillText(line, x, yy)
      line = w
      yy += lh
    } else {
      line = test
    }
  }
  if (line) {
    ctx.fillText(line, x, yy)
  }
}

/** A rubber stamp: a ruled box and type in red, pressed unevenly so the ink breaks up. */
function stamp(
  base: CanvasRenderingContext2D,
  r: () => number,
  o: { lines: string[]; rot: number },
): void {
  const layer = document.createElement('canvas')
  layer.width = W
  layer.height = H
  const ctx = layer.getContext('2d')
  if (!ctx) {
    return
  }
  ctx.translate(W / 2, H / 2 + 40)
  ctx.rotate(o.rot)
  ctx.strokeStyle = STAMP_RED
  ctx.fillStyle = STAMP_RED
  const h = o.lines.length * 78 + 36
  ctx.lineWidth = 9
  ctx.strokeRect(-W / 2 + 46, -h / 2, W - 92, h)
  ctx.lineWidth = 2.5
  ctx.strokeRect(-W / 2 + 60, -h / 2 + 14, W - 120, h - 28)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  o.lines.forEach((l, i) => {
    fitType(ctx, l, { role: 'display', max: 64, min: 20, measure: W - 150, track: 0.04 })
    ctx.fillText(l, 0, -h / 2 + 58 + i * 78)
  })
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  // uneven pressure: big pale patches plus fine speckle
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 26; i++) {
    ctx.globalAlpha = 0.1 + r() * 0.25
    ctx.beginPath()
    ctx.ellipse(
      60 + r() * (W - 120),
      H / 2 - 120 + r() * 320,
      20 + r() * 60,
      8 + r() * 26,
      r() * 3,
      0,
      Math.PI * 2,
    )
    ctx.fill()
  }
  wear(ctx, [0, 0, W, H], r)
  wear(ctx, [0, 0, W, H], r)
  base.save()
  base.globalAlpha = 0.86
  base.globalCompositeOperation = 'multiply'
  base.drawImage(layer, 0, 0)
  base.restore()
}
