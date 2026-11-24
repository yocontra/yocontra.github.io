import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import type { TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { frontOf } from '../../src/experiments/out-west/ffa/sim/porches.ts'
import type { FrontierGeometry } from './frontier-geometry.ts'
import { BANK_SIGN_SIZE, FACADE_SIGN_HEIGHT, facadeSignWidth } from './frontier-sign-layout.ts'
import { paintedSignAtlas, type SignBoard } from './frontier-sign-type.ts'
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
export function townSignBoards(layout: TownLayout): SignBoard[] {
  const owners = [...Object.keys(LABELS), ...Object.keys(SHORT_LABELS)]
  return SIGN_ROWS.map((label, row) => {
    const owner = row >= 24 ? 'bank' : owners[row]
    if (!owner) {
      throw new Error(`Missing Frontier sign owner at row ${row}`)
    }
    if (row >= 24) {
      return { owner, label, kind: 'counter', aspect: BANK_SIGN_SIZE.width / BANK_SIGN_SIZE.height }
    }
    if (row >= 12) {
      return { owner, label, kind: 'blade', aspect: 1.5 / 0.7 }
    }
    const building = layout.buildings.find((entry) => entry.id === owner)
    if (!building) {
      throw new Error(`Missing Frontier building ${owner}`)
    }
    return {
      owner,
      label,
      kind: 'facade',
      aspect: facadeSignWidth(building, frontOf(building, layout), label) / FACADE_SIGN_HEIGHT,
    }
  })
}

export async function authoredMaterials(g: FrontierGeometry, layout: TownLayout) {
  const clothSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><pattern id="weave" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#c6ae84"/><path d="M0 0H4" stroke="#7b6548" stroke-opacity=".17"/><path d="M0 0V4" stroke="#f3ddae" stroke-opacity=".18"/></pattern></defs><rect width="128" height="128" fill="url(#weave)"/></svg>`
  const cloth = g.doc
    .createTexture('Weathered canvas weave')
    .setImage(await sharp(Buffer.from(clothSvg)).png().toBuffer())
    .setMimeType('image/png')
  g.materials.set(
    'cloth',
    g.doc
      .createMaterial('Perdition canvas')
      .setBaseColorTexture(cloth)
      .setMetallicFactor(0)
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
  const sign = g.doc
    .createTexture('Perdition shop signs')
    .setImage(await paintedSignAtlas(townSignBoards(layout)))
    .setMimeType('image/png')
  g.materials.set(
    'sign',
    g.doc
      .createMaterial('Perdition painted signs')
      .setBaseColorTexture(sign)
      .setMetallicFactor(0)
      .setRoughnessFactor(0.9),
  )
}
