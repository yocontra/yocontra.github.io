import type { HatKey, Outlaw } from '../data/outlaws'
import { SLAB } from '../scene/textures'

const W = 620
const H = 860

function rnd(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 10000) / 10000
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

/** Draw a wanted poster onto a canvas (runtime-generated, no image assets). */
export function drawPoster(canvas: HTMLCanvasElement, o: Outlaw, opts: PosterOpts): void {
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const r = rnd(opts.index * 7919 + 13)
  // parchment
  const g = ctx.createRadialGradient(W / 2, H / 2, 100, W / 2, H / 2, 600)
  g.addColorStop(0, '#ecdcb4')
  g.addColorStop(0.7, '#d9c08c')
  g.addColorStop(1, '#9c7a48')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = `rgba(${90 + r() * 40},${60 + r() * 30},20,${r() * 0.07})`
    ctx.fillRect(r() * W, r() * H, 1 + r() * 3, 1 + r() * 3)
  }
  for (let i = 0; i < 8; i++) {
    ctx.strokeStyle = `rgba(80,50,20,${0.05 + r() * 0.08})`
    ctx.lineWidth = 1 + r() * 2
    ctx.beginPath()
    ctx.moveTo(r() * W, 0)
    ctx.lineTo(r() * W, H)
    ctx.stroke()
  }
  ctx.strokeStyle = '#2a1a0e'
  ctx.lineWidth = 6
  ctx.strokeRect(24, 24, W - 48, H - 48)
  ctx.lineWidth = 2
  ctx.strokeRect(36, 36, W - 72, H - 72)

  ctx.fillStyle = '#1e140a'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `110px ${SLAB}`
  ctx.fillText('WANTED', W / 2, 150)
  ctx.font = `30px ${SLAB}`
  ctx.fillText(opts.index >= 15 ? 'DEAD — ONLY DEAD' : 'DEAD OR ALIVE', W / 2, 196)

  // portrait frame
  const px = 130
  const py = 220
  const pw = W - 260
  const ph = 300
  ctx.fillStyle = opts.portrait ? '#efe2c0' : '#c9ad7a'
  ctx.fillRect(px, py, pw, ph)
  ctx.strokeStyle = '#2a1a0e'
  ctx.lineWidth = 3
  ctx.strokeRect(px, py, pw, ph)
  if (opts.portrait) {
    const pr = opts.portrait
    const k = Math.max(pw / pr.width, ph / pr.height)
    const dw = pr.width * k
    const dh = pr.height * k
    ctx.save()
    ctx.beginPath()
    ctx.rect(px, py, pw, ph)
    ctx.clip()
    ctx.globalCompositeOperation = 'multiply'
    ctx.drawImage(pr, px + (pw - dw) / 2, py + (ph - dh) / 2, dw, dh)
    ctx.restore()
    ctx.save()
  } else {
    // silhouette fallback while his model streams in
    ctx.save()
    ctx.beginPath()
    ctx.rect(px, py, pw, ph)
    ctx.clip()
    ctx.fillStyle = '#24170c'
    const cx = W / 2
    ctx.beginPath()
    ctx.ellipse(cx, py + 165, 48, 60, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(cx - 140, py + ph)
    ctx.bezierCurveTo(cx - 130, py + 235, cx - 60, py + 225, cx - 30, py + 215)
    ctx.lineTo(cx + 30, py + 215)
    ctx.bezierCurveTo(cx + 60, py + 225, cx + 130, py + 235, cx + 140, py + ph)
    ctx.fill()
    hatPath(ctx, o.hat, cx, py + 40)
  }
  ctx.restore()

  // name
  ctx.fillStyle = '#1e140a'
  let size = 54
  const name = o.name.toUpperCase()
  ctx.font = `${size}px ${SLAB}`
  while (ctx.measureText(name).width > W - 100 && size > 22) {
    size -= 2
    ctx.font = `${size}px ${SLAB}`
  }
  ctx.fillText(name, W / 2, 590)
  ctx.font = `italic 28px Georgia, serif`
  ctx.fillText(o.epithet, W / 2, 630)
  ctx.font = `24px Georgia, serif`
  wrap(ctx, o.hook, W / 2, 672, W - 130, 28)
  ctx.font = `64px ${SLAB}`
  ctx.fillText(`$${o.bounty.toLocaleString('en-US')}`, W / 2, 790)
  ctx.font = `22px ${SLAB}`
  ctx.fillText('REWARD', W / 2, 818)

  if (opts.stamp === 'coward') stamp(ctx, ['SHOT IN THE BACK', 'NO BOUNTY'], '#b0100c', -0.28)
  if (opts.stamp === 'dead') stamp(ctx, ['PAID'], '#b0100c', -0.18)
}

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  max: number,
  lh: number,
): void {
  const words = text.split(' ')
  let line = ''
  let yy = y
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (ctx.measureText(test).width > max && line) {
      ctx.fillText(line, x, yy)
      line = w
      yy += lh
    } else line = test
  }
  if (line) ctx.fillText(line, x, yy)
}

function stamp(ctx: CanvasRenderingContext2D, lines: string[], color: string, rot: number): void {
  ctx.save()
  ctx.translate(W / 2, H / 2 + 40)
  ctx.rotate(rot)
  ctx.globalAlpha = 0.85
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 8
  const h = lines.length * 70 + 30
  ctx.strokeRect(-W / 2 + 40, -h / 2, W - 80, h)
  ctx.font = `60px ${SLAB}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  lines.forEach((l, i) => {
    let s = 60
    while (ctx.measureText(l).width > W - 120 && s > 20) {
      s -= 2
      ctx.font = `${s}px ${SLAB}`
    }
    ctx.fillText(l, 0, -h / 2 + 50 + i * 70)
  })
  ctx.restore()
}
