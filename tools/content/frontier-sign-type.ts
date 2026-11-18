/** Offline lettering: pinned outlines and balanced physical texel density in one atlas. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { create, type Font } from 'fontkitten'
import sharp from 'sharp'
import {
  SIGN_ATLAS_HEIGHT,
  SIGN_ATLAS_WIDTH,
  SIGN_GUTTER,
  SIGN_SHORT_BAND,
  signRect,
} from './frontier-sign-layout.ts'

export const SIGN_FONT_SHA = 'e0d7f0dfde5f713d46ea9e184ec60eb9e161455ce25d1710fe94f651261165d1'
export const SIGN_LOGICAL_WIDTH = (128 * 1.5) / 0.7
const WOOD_SCAN = new URL(
  '../../public/experiments/out-west/3d/tex/planks_diff.webp',
  import.meta.url,
)
const SHORT_LABEL = /^[A-Z]+$/u
const LONG_LABEL = /^[A-Z]+(?: [A-Z&]+)*$/u
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export async function signFont(): Promise<Font> {
  const bytes = await readFile(
    new URL('../../public/experiments/out-west/fonts/ultra.woff2', import.meta.url),
  )
  if (hash(bytes) !== SIGN_FONT_SHA) {
    throw new Error('Sign font bytes changed')
  }
  const font = create(bytes)
  if (font.isCollection) {
    throw new Error('Sign font must be one face')
  }
  return font
}

export function shortSignOutline(font: Font, text: string) {
  if (!(text && SHORT_LABEL.test(text))) {
    throw new Error('Expected uppercase short-sign label')
  }
  return signOutline(font, text, SIGN_LOGICAL_WIDTH)
}

function signOutline(font: Font, text: string, logicalWidth: number, sideMargin = 16) {
  let advance = 0
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const paths = [...text].map((character) => {
    const code = character.charCodeAt(0)
    if (!font.hasGlyphForCodePoint(code)) {
      throw new Error(`Missing sign glyph ${character}`)
    }
    const glyph = font.glyphForCodePoint(code)
    if (character === ' ') {
      advance += glyph.advanceWidth
      return ''
    }
    minX = Math.min(minX, advance + glyph.bbox.minX)
    maxX = Math.max(maxX, advance + glyph.bbox.maxX)
    minY = Math.min(minY, glyph.bbox.minY)
    maxY = Math.max(maxY, glyph.bbox.maxY)
    const path = `<path transform="translate(${advance} 0)" d="${glyph.path.toSVG()}"/>`
    advance += glyph.advanceWidth
    return path
  })
  const width = maxX - minX
  const height = maxY - minY
  // Equal world-space scale on both axes, with clearance from the painted border.
  const scale = Math.min((logicalWidth - 2 * sideMargin) / width, 84 / height)
  const svg = `<g fill="#2d211b" transform="translate(${logicalWidth / 2} 64) scale(${scale} ${-scale}) translate(${-(minX + maxX) / 2} ${-(minY + maxY) / 2})">${paths.join('')}</g>`
  return { svg, width, height, scale, logicalWidth: width * scale, logicalHeight: height * scale }
}

/** Keep the existing atlas slots and fit ink in physical board space. */
export async function letteredSignAtlas(
  labels: readonly string[],
  shortLabels: readonly string[],
  directory: string,
  longAspects: ReadonlyMap<number, number> = new Map(),
) {
  const baseline = await readFile(join(directory, 'baseline-atlas.png'))
  const recipe = JSON.parse(await readFile(join(directory, 'baseline.json'), 'utf8'))
  if (
    recipe.sha256 !== hash(baseline) ||
    JSON.stringify(recipe.labels) !== JSON.stringify(labels)
  ) {
    throw new Error('Sign baseline bytes or row labels/order changed')
  }
  const metadata = await sharp(baseline).metadata()
  if (metadata.width !== SIGN_ATLAS_WIDTH || metadata.height !== SIGN_ATLAS_HEIGHT) {
    throw new Error('Unexpected sign atlas dimensions')
  }
  if (shortLabels.length !== 12 || labels.length !== 28) {
    throw new Error('Expected 12 short / 28 total rows')
  }
  const font = await signFont()
  const clearedBand = await sharp({
    create: {
      width: SIGN_SHORT_BAND.width,
      height: SIGN_SHORT_BAND.height,
      channels: 4,
      background: '#36261b',
    },
  })
    .png()
    .toBuffer()
  const overlays = await Promise.all(
    shortLabels.map(async (text, index) => {
      const row = 12 + index
      if (labels[row] !== text) {
        throw new Error('Short-sign row contract changed')
      }
      const { svg } = shortSignOutline(font, text)
      const rect = signRect(row)
      // Six-pixel paint stroke has the same 15mm physical width on both axes.
      const image = `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}"><rect width="${rect.width}" height="${rect.height}" fill="#36261b"/><rect x="8" y="8" width="${rect.width - 16}" height="${rect.height - 16}" fill="#bd9b66" stroke="#25190f" stroke-width="6"/><g transform="scale(${rect.width / SIGN_LOGICAL_WIDTH})">${svg}</g></svg>`
      const input = await sharp(Buffer.from(image))
        .extend({
          top: SIGN_GUTTER,
          bottom: SIGN_GUTTER,
          left: SIGN_GUTTER,
          right: SIGN_GUTTER,
          extendWith: 'copy',
        })
        .png()
        .toBuffer()
      return { input, left: rect.left - SIGN_GUTTER, top: rect.top - SIGN_GUTTER }
    }),
  )
  const longOverlays = await Promise.all(
    [...longAspects].map(async ([row, aspect]) => {
      const label = labels[row]
      if (!(label && LONG_LABEL.test(label) && (row < 12 || row >= 24))) {
        throw new Error(`Invalid long-sign row ${row}`)
      }
      const rect = signRect(row)
      const width = 128 * aspect
      const { svg } = signOutline(font, label, width, width * 0.06)
      const image = `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}" viewBox="0 0 ${width} 128" preserveAspectRatio="none"><rect width="${width}" height="128" fill="#36261b"/><rect x="4" y="4" width="${width - 8}" height="120" fill="#bd9b66" stroke="#25190f" stroke-width="3"/>${svg}</svg>`
      return {
        input: await sharp(Buffer.from(image)).png().toBuffer(),
        left: rect.left,
        top: rect.top,
      }
    }),
  )
  return sharp(baseline)
    .composite([
      { input: clearedBand, left: SIGN_SHORT_BAND.left, top: SIGN_SHORT_BAND.top },
      ...overlays,
      ...longOverlays,
    ])
    .png()
    .toBuffer()
}

/** Let scanned wood grain show through the original paint and lettering. */
export async function paintedSignAtlas(
  labels: readonly string[],
  shortLabels: readonly string[],
  directory: string,
  longAspects: ReadonlyMap<number, number>,
) {
  const lettering = await letteredSignAtlas(labels, shortLabels, directory, longAspects)
  const scan = await readFile(WOOD_SCAN)
  const overlays = await Promise.all(
    labels.map(async (_, row) => {
      const rect = signRect(row)
      const short = row >= 12 && row < 24
      const { width, height } = rect
      const grain = await sharp(scan)
        .extract({ left: 0, width: 1024, top: (row * 137) % 879, height: short ? 144 : 68 })
        .resize(width, height, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer()
      const mean = grain.reduce((sum, sample) => sum + sample, 0) / grain.length
      const paint = await sharp(lettering).extract(rect).ensureAlpha().raw().toBuffer()
      for (let y = 0; y < height; y++) {
        const edgeWear = Math.max(0, 1 - Math.min(y, height - 1 - y) / (height * 0.22))
        for (let x = 0; x < width; x++) {
          const pixel = y * width + x
          const offset = pixel * 4
          const tone = (grain[pixel] ?? mean) - mean
          const red = paint[offset] ?? 0
          // Dark letterforms retain their shape while edges and pale paint show more grain.
          const contrast = red < 80 ? 0.36 : 0.95
          const weather = Math.max(-42, Math.min(32, tone * contrast)) - edgeWear * 8
          for (let channel = 0; channel < 3; channel++) {
            const index = offset + channel
            paint[index] = Math.min(255, Math.max(0, Math.round((paint[index] ?? 0) + weather)))
          }
        }
      }
      const gutter = short ? SIGN_GUTTER : 0
      const input = await sharp(paint, { raw: { width, height, channels: 4 } })
        .extend({ top: gutter, bottom: gutter, left: gutter, right: gutter, extendWith: 'copy' })
        .png()
        .toBuffer()
      return { input, left: rect.left - gutter, top: rect.top - gutter }
    }),
  )
  return sharp(lettering).composite(overlays).png().toBuffer()
}
