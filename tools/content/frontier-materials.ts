import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import type { FrontierGeometry } from './frontier-geometry.ts'
export const LABELS: Record<string, string> = {
  saloon: 'PERDITION SALOON',
  hotel: 'GRAND HOTEL',
  bank: 'FIRST FRONTIER BANK',
  livery: 'LIVERY & FEED',
  general_store: 'MERCANTILE',
  jail: 'SHERIFF',
  depot: 'PERDITION STATION',
  stage_line: 'OVERLAND STAGE',
  assay: 'ASSAY OFFICE',
  smithy: 'BLACKSMITH',
  undertaker: 'UNDERTAKER',
  church: 'PERDITION CHAPEL',
}
export const SHORT_LABELS: Record<string, string> = {
  saloon: 'SALOON',
  hotel: 'HOTEL',
  bank: 'BANK',
  livery: 'LIVERY',
  general_store: 'STORE',
  jail: 'SHERIFF',
  depot: 'STATION',
  stage_line: 'STAGE',
  assay: 'ASSAY',
  smithy: 'SMITHY',
  undertaker: 'UNDERTAKER',
  church: 'CHAPEL',
}
export const SIGN_ROWS = [
  ...Object.values(LABELS),
  ...Object.values(SHORT_LABELS),
  'DEPOSITS',
  'CASHIER',
  'EXCHANGE',
  'SAVINGS',
]
export async function authoredMaterials(g: FrontierGeometry) {
  const clothSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><pattern id="weave" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#c7ac7b"/><path d="M0 0H4" stroke="#7b6548" stroke-opacity=".28"/><path d="M0 0V4" stroke="#f3ddae" stroke-opacity=".32"/></pattern></defs><rect width="128" height="128" fill="url(#weave)"/></svg>`
  const cloth = g.doc
    .createTexture('Weathered canvas weave')
    .setImage(await sharp(Buffer.from(clothSvg)).png().toBuffer())
    .setMimeType('image/png')
  g.materials.set(
    'cloth',
    g.doc
      .createMaterial('Perdition canvas')
      .setBaseColorTexture(cloth)
      .setRoughnessFactor(0.95)
      .setDoubleSided(true),
  )
  const glassImage = g.doc
    .createTexture('Authored dusty window surface')
    .setImage(await readFile('tools/art/environments/frontier-glass.png'))
    .setMimeType('image/png')
  g.materials.set(
    'glass',
    g.doc
      .createMaterial('window-glass')
      .setBaseColorTexture(glassImage)
      .setBaseColorFactor([0.75, 0.85, 0.86, 0.26])
      .setAlphaMode('BLEND')
      .setRoughnessFactor(0.21)
      .setMetallicFactor(0.25)
      .setDoubleSided(true),
  )
  const labels = SIGN_ROWS
  const width = 2048
  const cell = 128
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${cell * labels.length}">${labels.map((text, index) => `<g transform="translate(0 ${index * cell})"><rect width="2048" height="128" fill="#36261b"/><rect x="8" y="8" width="2032" height="112" fill="#bd9b66" stroke="#25190f" stroke-width="6"/><text x="1024" y="90" fill="#2d211b" font-family="Georgia" font-size="83" font-weight="bold" text-anchor="middle" textLength="1900" lengthAdjust="spacingAndGlyphs">${text.replaceAll('&', '&amp;')}</text></g>`).join('')}</svg>`
  const sign = g.doc
    .createTexture('Perdition shop signs')
    .setImage(await sharp(Buffer.from(svg)).png().toBuffer())
    .setMimeType('image/png')
  g.materials.set(
    'sign',
    g.doc
      .createMaterial('Perdition painted signs')
      .setBaseColorTexture(sign)
      .setRoughnessFactor(0.9),
  )
}
