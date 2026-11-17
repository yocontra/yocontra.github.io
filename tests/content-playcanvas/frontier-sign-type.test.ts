import { expect, test as it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { SHORT_LABELS, SIGN_ROWS } from '../../tools/content/frontier-materials.ts'
import {
  SIGN_ATLAS_HEIGHT,
  SIGN_ATLAS_WIDTH,
  SIGN_GUTTER,
  SIGN_SHORT_BAND,
  signRect,
  signUvRect,
} from '../../tools/content/frontier-sign-layout.ts'
import {
  paintedSignAtlas,
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
          `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="280" viewBox="0 0 ${SIGN_LOGICAL_WIDTH} 128">${outline.svg}</svg>`,
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
        Math.abs(maxX - minX + 1 - (outline.logicalWidth * 600) / SIGN_LOGICAL_WIDTH),
      ).toBeLessThan(2)
      expect(Math.abs(maxY - minY + 1 - (outline.logicalHeight * 280) / 128)).toBeLessThan(2)
      const worldWidth = (outline.logicalWidth * 1.5) / SIGN_LOGICAL_WIDTH
      const worldHeight = (outline.logicalHeight * 0.7) / 128
      expect(worldWidth / worldHeight).toBeCloseTo(outline.width / outline.height, 10)
      expect(minX).toBeGreaterThan(30)
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
    for (let row = 12; row < 24; row++) {
      const rect = signRect(row)
      let mismatches = 0
      for (let y = -SIGN_GUTTER; y < rect.height + SIGN_GUTTER; y++) {
        for (let x = -SIGN_GUTTER; x < rect.width + SIGN_GUTTER; x++) {
          if (x >= 0 && x < rect.width && y >= 0 && y < rect.height) {
            continue
          }
          const actual = ((rect.top + y) * SIGN_ATLAS_WIDTH + rect.left + x) * 4
          const expected =
            ((rect.top + Math.max(0, Math.min(rect.height - 1, y))) * SIGN_ATLAS_WIDTH +
              rect.left +
              Math.max(0, Math.min(rect.width - 1, x))) *
            4
          if (!after.subarray(actual, actual + 4).equals(after.subarray(expected, expected + 4))) {
            mismatches++
          }
        }
      }
      expect(mismatches).toBe(0)
      const strokeAt = (x: number, y: number) => {
        const p = ((rect.top + y) * SIGN_ATLAS_WIDTH + rect.left + x) * 4
        return after[p] === 37 && after[p + 1] === 25 && after[p + 2] === 15
      }
      expect(Array.from({ length: 16 }, (_, x) => strokeAt(x, 140)).filter(Boolean).length).toBe(6)
      expect(Array.from({ length: 16 }, (_, y) => strokeAt(300, y)).filter(Boolean).length).toBe(6)
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

it('uses balanced physical UV rectangles with guarded gutters, preserving sixteen legacy rows exactly', () => {
  const legacyRows = [...Array.from({ length: 12 }, (_, i) => i), 24, 25, 26, 27]
  for (const row of legacyRows) {
    expect(signUvRect(row)).toEqual({ u0: 0, u1: 1, v0: row / 28, v1: (row + 1) / 28 })
  }
  for (let row = 12; row < 24; row++) {
    const rect = signRect(row)
    const uv = signUvRect(row)
    expect(rect.width / 1.5).toBe(400)
    expect(rect.height / 0.7).toBe(400)
    expect(rect.left - SIGN_GUTTER).toBeGreaterThanOrEqual(0)
    expect(rect.left + rect.width + SIGN_GUTTER).toBeLessThanOrEqual(SIGN_ATLAS_WIDTH)
    expect(rect.top - SIGN_GUTTER).toBeGreaterThanOrEqual(SIGN_SHORT_BAND.top)
    expect(rect.top + rect.height + SIGN_GUTTER).toBeLessThanOrEqual(
      SIGN_SHORT_BAND.top + SIGN_SHORT_BAND.height,
    )
    const packed = new Float32Array([uv.u0, uv.u1, uv.v0, uv.v1])
    expect(
      Math.max(
        Math.abs((packed[0] ?? 0) - uv.u0) * SIGN_ATLAS_WIDTH,
        Math.abs((packed[1] ?? 0) - uv.u1) * SIGN_ATLAS_WIDTH,
        Math.abs((packed[2] ?? 0) - uv.v0) * SIGN_ATLAS_HEIGHT,
        Math.abs((packed[3] ?? 0) - uv.v1) * SIGN_ATLAS_HEIGHT,
      ),
    ).toBeLessThan(0.000_25)
    for (let other = row + 1; other < 24; other++) {
      const next = signRect(other)
      expect(
        rect.left + rect.width + SIGN_GUTTER <= next.left - SIGN_GUTTER ||
          next.left + next.width + SIGN_GUTTER <= rect.left - SIGN_GUTTER ||
          rect.top + rect.height + SIGN_GUTTER <= next.top - SIGN_GUTTER ||
          next.top + next.height + SIGN_GUTTER <= rect.top - SIGN_GUTTER,
      ).toBe(true)
    }
  }
  expect(() => signRect(-1)).toThrow('0..27')
  expect(() => signRect(28)).toThrow('0..27')
  expect(() => signRect(12.5)).toThrow('0..27')
})

it('weathering adds grain to every sign while keeping the pale paint distinct from ink', async () => {
  const directory = 'tools/art/environments/frontier-signs'
  const labels = Object.values(SHORT_LABELS)
  const [paint, weathered] = await Promise.all([
    shortSignAtlas(SIGN_ROWS, labels, directory),
    paintedSignAtlas(SIGN_ROWS, labels, directory),
  ])
  const before = await sharp(paint).ensureAlpha().raw().toBuffer()
  const after = await sharp(weathered).ensureAlpha().raw().toBuffer()
  expect(after.length).toBe(SIGN_ATLAS_WIDTH * SIGN_ATLAS_HEIGHT * 4)
  for (let row = 0; row < SIGN_ROWS.length; row++) {
    const { left, top, width, height } = signRect(row)
    let changed = 0
    let lightestInk = 0
    let darkestPaint = 255
    for (let y = top; y < top + height; y++) {
      for (let x = left; x < left + width; x++) {
        const offset = (y * SIGN_ATLAS_WIDTH + x) * 4
        const original = before[offset] ?? 0
        const next = after[offset] ?? 0
        if (Math.abs(original - next) >= 10) {
          changed++
        }
        if (original < 60) {
          lightestInk = Math.max(lightestInk, next)
        }
        if (original > 150) {
          darkestPaint = Math.min(darkestPaint, next)
        }
      }
    }
    expect(changed).toBeGreaterThan((width * height) / 30)
    expect(darkestPaint - lightestInk).toBeGreaterThan(35)
  }
})
