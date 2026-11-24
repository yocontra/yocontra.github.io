/** Offline sign painting. Rasterize the bundled font outlines directly in each board's UV slot. */
import { readFile } from 'node:fs/promises'
import { create, type Font } from 'fontkitten'
import sharp from 'sharp'
import {
  SIGN_ATLAS_HEIGHT,
  SIGN_ATLAS_WIDTH,
  SIGN_GUTTER,
  signRect,
} from './frontier-sign-layout.ts'
import { boardDecoration, signPaint } from './frontier-sign-paint.ts'

export interface SignBoard {
  owner: string
  label: string
  aspect: number
  kind: 'facade' | 'blade' | 'counter'
}

const wood = new URL('../../public/experiments/out-west/3d/tex/planks_diff.webp', import.meta.url)
type Face = ReturnType<typeof signPaint>['face']
async function readFace(face: Face) {
  const bytes = await readFile(
    new URL(`../../public/experiments/out-west/fonts/${face}.woff2`, import.meta.url),
  )
  const font = create(bytes)
  if (font.isCollection) {
    throw new Error(`Expected one face for ${face}`)
  }
  return font
}

export function boardLettering(board: SignBoard, font: Font) {
  const { label, aspect, kind } = board
  const paint = signPaint(board.owner)
  const text =
    paint.mixedCase && kind !== 'counter'
      ? label.toLowerCase().replace(/\b[a-z]/gu, (c) => c.toUpperCase())
      : label
  let x = 0
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.POSITIVE_INFINITY
  let top = Number.NEGATIVE_INFINITY
  const paths: string[] = []
  for (const character of text) {
    const cp = character.codePointAt(0)
    if (cp === undefined || !font.hasGlyphForCodePoint(cp)) {
      throw new Error(`Missing painted glyph: ${character}`)
    }
    const glyph = font.glyphForCodePoint(cp)
    if (character !== ' ') {
      left = Math.min(left, x + glyph.bbox.minX)
      right = Math.max(right, x + glyph.bbox.maxX)
      bottom = Math.min(bottom, glyph.bbox.minY)
      top = Math.max(top, glyph.bbox.maxY)
      paths.push(`<path transform="translate(${x} 0)" d="${glyph.path.toSVG()}"/>`)
    }
    x += glyph.advanceWidth + paint.spacing * font.unitsPerEm
  }
  const width = aspect * 128
  const mark = kind === 'facade' && paint.mark !== 'none' && width >= 440
  const margin = mark ? 88 : 18
  // Uniform scaling in metres keeps the same letterforms on a blade and a fascia.
  const scale = Math.min((width - 2 * margin) / (right - left), 88 / (top - bottom))
  // A slightly wider painted stroke keeps fine serifs visible as the map selects lower mips.
  const stroke = paint.face.startsWith('eb-garamond')
    ? 'stroke="currentColor" stroke-width="13" stroke-linejoin="round"'
    : ''
  const shape = `<g ${stroke} transform="translate(${width / 2} 64) scale(${scale} ${-scale}) translate(${-(left + right) / 2} ${-(bottom + top) / 2})">${paths.join('')}</g>`
  const shade = paint.shade
    ? `<g fill="${paint.shade}" color="${paint.shade}" transform="translate(1.8 2.8)">${shape}</g>`
    : ''
  const svg = `<rect width="${width}" height="128" fill="${paint.ground}"/>${boardDecoration(paint, width, mark)}${shade}<g fill="${paint.ink}" color="${paint.ink}">${shape}</g>`
  return { svg, width, scale, inkWidth: (right - left) * scale, inkHeight: (top - bottom) * scale }
}

export async function paintedSignAtlas(boards: SignBoard[]) {
  if (boards.length !== 28) {
    throw new Error('Expected all 28 Perdition sign boards')
  }
  const faces = new Map<Face, Font>()
  for (const { owner } of boards) {
    const { face } = signPaint(owner)
    if (!faces.has(face)) {
      faces.set(face, await readFace(face))
    }
  }
  const scan = await readFile(wood)
  const overlays: { input: Buffer; left: number; top: number }[] = []
  for (const [row, board] of boards.entries()) {
    const rect = signRect(row)
    const font = faces.get(signPaint(board.owner).face)
    if (!font) {
      throw new Error(`Missing sign font for ${board.owner}`)
    }
    const art = boardLettering(board, font)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}" viewBox="0 0 ${art.width} 128" preserveAspectRatio="none">${art.svg}</svg>`
    const paint = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer()
    const grain = await sharp(scan)
      .extract({
        left: 0,
        width: 1024,
        top: (137 * row) % 768,
        height: Math.min(256, Math.round(1024 / board.aspect)),
      })
      .resize(rect.width, rect.height, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer()
    const mean = grain.reduce((sum, sample) => sum + sample, 0) / grain.length
    for (let y = 0; y < rect.height; y++) {
      const edge = Math.max(0, 1 - Math.min(y, rect.height - 1 - y) / (rect.height * 0.07))
      for (let x = 0; x < rect.width; x++) {
        const i = y * rect.width + x
        const weather = Math.round(
          Math.max(-16, Math.min(14, ((grain[i] ?? mean) - mean) * 0.32)) - edge * 5,
        )
        for (let c = 0; c < 3; c++) {
          const k = i * 3 + c
          paint[k] = Math.min(255, Math.max(0, (paint[k] ?? 0) + weather))
        }
      }
    }
    const input = await sharp(paint, {
      raw: { width: rect.width, height: rect.height, channels: 3 },
    })
      .extend({
        top: SIGN_GUTTER,
        bottom: SIGN_GUTTER,
        left: SIGN_GUTTER,
        right: SIGN_GUTTER,
        extendWith: 'copy',
      })
      .png()
      .toBuffer()
    overlays.push({ input, left: rect.left - SIGN_GUTTER, top: rect.top - SIGN_GUTTER })
  }
  return sharp({
    create: {
      width: SIGN_ATLAS_WIDTH,
      height: SIGN_ATLAS_HEIGHT,
      channels: 3,
      background: '#45392e',
    },
  })
    .composite(overlays)
    .removeAlpha()
    .png({ palette: true, colours: 256, dither: 0 })
    .toBuffer()
}
