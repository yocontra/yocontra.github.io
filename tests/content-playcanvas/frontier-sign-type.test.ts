import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { SHORT_LABELS, SIGN_ROWS } from '../../tools/content/frontier-materials.ts'
import {
  SIGN_LOGICAL_WIDTH,
  shortSignAtlas,
  shortSignOutline,
  signFont,
} from '../../tools/content/frontier-sign-type.ts'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

it('all twelve labels retain pinned outline proportions after physical world mapping', async () => {
  const font = await signFont()
  expect(font.familyName).toBe('Ultra')
  await Promise.all(
    Object.values(SHORT_LABELS).map(async (label) => {
      const outline = shortSignOutline(font, label)
      const { data, info } = await sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="128">${outline.svg}</svg>`,
        ),
      )
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      let minX = info.width
      let maxX = -1
      let minY = info.height
      let maxY = -1
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          if ((data[(y * info.width + x) * 4 + 3] ?? 0) > 127) {
            minX = Math.min(minX, x)
            maxX = Math.max(maxX, x)
            minY = Math.min(minY, y)
            maxY = Math.max(maxY, y)
          }
        }
      }
      expect(
        Math.abs(maxX - minX + 1 - (outline.logicalWidth * 2048) / SIGN_LOGICAL_WIDTH),
      ).toBeLessThan(2)
      expect(Math.abs(maxY - minY + 1 - outline.logicalHeight)).toBeLessThan(2)
      const worldWidth = (outline.logicalWidth * 1.5) / SIGN_LOGICAL_WIDTH
      const worldHeight = (outline.logicalHeight * 0.7) / 128
      expect(worldWidth / worldHeight).toBeCloseTo(outline.width / outline.height, 10)
      expect(minX).toBeGreaterThan(100)
      expect(minY).toBeGreaterThanOrEqual(21)
    }),
  )
  expect(() => shortSignOutline(font, 'BANK&')).toThrow('uppercase')
})

it('compositing preserves every unowned row and rejects stale baseline bytes or label order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ow-sign-type-'))
  try {
    const baseline = await sharp({
      create: { width: 2048, height: 3584, channels: 4, background: '#a17b59' },
    })
      .png()
      .toBuffer()
    const recipe = { sha256: hash(baseline), labels: SIGN_ROWS }
    await writeFile(join(directory, 'baseline-atlas.png'), baseline)
    await writeFile(join(directory, 'baseline.json'), JSON.stringify(recipe))
    const before = await sharp(baseline).raw().toBuffer()
    const after = await sharp(
      await shortSignAtlas(SIGN_ROWS, Object.values(SHORT_LABELS), directory),
    )
      .raw()
      .toBuffer()
    for (let row = 0; row < 28; row++) {
      const offset = row * 128 * 2048 * 4
      const equal = before
        .subarray(offset, offset + 128 * 2048 * 4)
        .equals(after.subarray(offset, offset + 128 * 2048 * 4))
      expect(equal).toBe(row < 12 || row >= 24)
    }
    await expect(
      shortSignAtlas([...SIGN_ROWS].reverse(), Object.values(SHORT_LABELS), directory),
    ).rejects.toThrow('labels/order')
    await writeFile(
      join(directory, 'baseline.json'),
      JSON.stringify({ ...recipe, sha256: 'stale' }),
    )
    await expect(shortSignAtlas(SIGN_ROWS, Object.values(SHORT_LABELS), directory)).rejects.toThrow(
      'bytes',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
