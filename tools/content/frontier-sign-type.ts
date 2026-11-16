/** Offline lettering: pinned outlines, physical fit, then atlas storage stretch. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { create, type Font } from 'fontkitten'
import sharp from 'sharp'

export const SIGN_FONT_SHA = 'e0d7f0dfde5f713d46ea9e184ec60eb9e161455ce25d1710fe94f651261165d1'
export const SIGN_LOGICAL_WIDTH = (128 * 1.5) / 0.7
const SHORT_LABEL = /^[A-Z]+$/u
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export async function signFont(): Promise<Font> {
  const bytes = await readFile(
    new URL('../../public/experiments/out-west/fonts/ultra.woff2', import.meta.url),
  )
  if (hash(bytes) !== SIGN_FONT_SHA) {
    throw new Error('Short-sign font bytes changed')
  }
  const font = create(bytes)
  if (font.isCollection) {
    throw new Error('Short-sign font must be one face')
  }
  return font
}

export function shortSignOutline(font: Font, text: string) {
  if (!(text && SHORT_LABEL.test(text))) {
    throw new Error('Expected uppercase short-sign label')
  }
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
  // Equal world-space scale on both axes; at least 8cm side / 12cm top-bottom margins.
  const scale = Math.min((SIGN_LOGICAL_WIDTH - 2 * 16) / width, 84 / height)
  const svg = `<g transform="scale(${2048 / SIGN_LOGICAL_WIDTH} 1)"><g fill="#2d211b" transform="translate(${SIGN_LOGICAL_WIDTH / 2} 64) scale(${scale} ${-scale}) translate(${-(minX + maxX) / 2} ${-(minY + maxY) / 2})">${paths.join('')}</g></g>`
  return { svg, width, height, scale, logicalWidth: width * scale, logicalHeight: height * scale }
}

/** The explicit art input preserves rows not owned by the short-sign correction. */
export async function shortSignAtlas(
  labels: readonly string[],
  shortLabels: readonly string[],
  directory: string,
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
  if (metadata.width !== 2048 || metadata.height !== labels.length * 128) {
    throw new Error('Unexpected sign atlas dimensions')
  }
  const font = await signFont()
  const overlays = await Promise.all(
    shortLabels.map(async (text, index) => {
      const row = 12 + index
      if (labels[row] !== text) {
        throw new Error('Short-sign row contract changed')
      }
      const { svg } = shortSignOutline(font, text)
      const image = `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="128"><rect width="2048" height="128" fill="#36261b"/><rect x="8" y="8" width="2032" height="112" fill="#bd9b66" stroke="#25190f" stroke-width="6"/>${svg}</svg>`
      return { input: await sharp(Buffer.from(image)).png().toBuffer(), left: 0, top: row * 128 }
    }),
  )
  if (shortLabels.length !== 12 || labels.length !== 28) {
    throw new Error('Expected 12 short / 28 total rows')
  }
  return sharp(baseline).composite(overlays).png().toBuffer()
}
