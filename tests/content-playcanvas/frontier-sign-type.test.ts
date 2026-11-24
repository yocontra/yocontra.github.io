import { expect, test as it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { create } from 'fontkitten'
import sharp from 'sharp'
import { TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { townSignBoards } from '../../tools/content/frontier-materials.ts'
import {
  SIGN_ATLAS_HEIGHT,
  SIGN_ATLAS_WIDTH,
  SIGN_GUTTER,
  signRect,
  signUvRect,
} from '../../tools/content/frontier-sign-layout.ts'
import { signPaint } from '../../tools/content/frontier-sign-paint.ts'
import { boardLettering, paintedSignAtlas } from '../../tools/content/frontier-sign-type.ts'

const boards = townSignBoards(TOWN)

it('each shop has its own colours and uses the same lettering on its fascia and blade', async () => {
  const fronts = boards.filter((b) => b.kind === 'facade')
  expect(fronts).toHaveLength(12)
  const baseline = JSON.parse(
    await readFile('tools/art/environments/frontier-signs/baseline.json', 'utf8'),
  )
  expect(boards.map((b) => b.label)).toEqual(baseline.labels)
  expect(new Set(fronts.map((b) => signPaint(b.owner).face)).size).toBeGreaterThanOrEqual(5)
  expect(new Set(fronts.map((b) => signPaint(b.owner).ground)).size).toBe(12)
  for (const [i, front] of fronts.entries()) {
    expect(boards[12 + i]?.owner).toBe(front.owner)
  }
  for (const counter of boards.slice(24)) {
    expect(counter.owner).toBe('bank')
  }
  for (const board of boards) {
    const { face } = signPaint(board.owner)
    const font = create(await readFile(`public/experiments/out-west/fonts/${face}.woff2`))
    if (font.isCollection) {
      throw new Error('Expected a single sign face')
    }
    const art = boardLettering(board, font)
    expect(art.inkWidth).toBeLessThanOrEqual(art.width - 35.9)
    expect(art.inkHeight).toBeGreaterThan(23)
    expect(art.inkHeight).toBeLessThanOrEqual(88.01)
  }
})

it('every board has its own mip gutter and at least 300 vertical texels per metre', () => {
  for (const [row, board] of boards.entries()) {
    const r = signRect(row)
    const uv = signUvRect(row)
    const physicalHeight = { facade: 0.85, blade: 0.7, counter: 0.42 }[board.kind]
    expect(r.height / physicalHeight).toBeGreaterThanOrEqual(300)
    expect(r.left).toBeGreaterThanOrEqual(SIGN_GUTTER)
    expect(r.top).toBeGreaterThanOrEqual(SIGN_GUTTER)
    expect(r.left + r.width + SIGN_GUTTER).toBeLessThanOrEqual(SIGN_ATLAS_WIDTH)
    expect(r.top + r.height + SIGN_GUTTER).toBeLessThanOrEqual(SIGN_ATLAS_HEIGHT)
    expect((uv.u1 - uv.u0) * SIGN_ATLAS_WIDTH).toBeCloseTo(r.width)
    expect((uv.v1 - uv.v0) * SIGN_ATLAS_HEIGHT).toBeCloseTo(r.height)
    for (let i = row + 1; i < boards.length; i++) {
      const other = signRect(i)
      const gap = 2 * SIGN_GUTTER
      expect(
        r.left + r.width + gap <= other.left ||
          other.left + other.width + gap <= r.left ||
          r.top + r.height + gap <= other.top ||
          other.top + other.height + gap <= r.top,
      ).toBe(true)
    }
  }
  expect(() => signRect(28)).toThrow()
})

it('finished paint keeps distinct ink and ground colours on every sign and repeats its edge texels', async () => {
  const { data, info } = await sharp(await paintedSignAtlas(boards))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pixel = (x: number, y: number) =>
    data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)
  const colour = (hex: string) => Buffer.from(hex.slice(1), 'hex')
  for (const [row, board] of boards.entries()) {
    const { left, top, width, height } = signRect(row)
    const paint = signPaint(board.owner)
    const ink = colour(paint.ink)
    const ground = colour(paint.ground)
    const close = (p: Buffer, c: Buffer) => p.every((v, i) => Math.abs(v - (c[i] ?? 0)) < 33)
    let inkCount = 0
    let groundCount = 0
    for (let y = top + 8; y < top + height - 8; y += 8) {
      for (let x = left + 8; x < left + width - 8; x += 8) {
        const p = pixel(x, y)
        if (close(p, ink)) {
          inkCount++
        }
        if (close(p, ground)) {
          groundCount++
        }
      }
    }
    expect(inkCount, board.label).toBeGreaterThan(((width * height) / 64) * 0.015)
    expect(groundCount, board.label).toBeGreaterThan(inkCount)
    for (let x = left; x < left + width; x += 23) {
      expect(pixel(x, top - SIGN_GUTTER)).toEqual(pixel(x, top))
      expect(pixel(x, top + height - 1 + SIGN_GUTTER)).toEqual(pixel(x, top + height - 1))
    }
  }
}, 60_000)
