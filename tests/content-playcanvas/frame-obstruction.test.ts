import { expect, test as it } from 'bun:test'
import { frameObstruction } from '../../tools/content/frame-obstruction.ts'

it('empty native geometry masks fail instead of reporting perfect visibility', () => {
  expect(() =>
    frameObstruction(new Uint8Array(100), { width: 10, height: 10, channels: 1 }),
  ).toThrow('mask is empty')
})

it('portrait region coverage uses the actual pixel bounds, not fractional screen area', () => {
  const width = 375
  const height = 812
  const pixels = new Uint8Array(width * height).fill(24)
  for (let y = 406; y < 650; y++) {
    for (let x = 132; x < 244; x++) {
      pixels[y * width + x] = 255
    }
  }
  const obstruction = frameObstruction(pixels, { width, height, channels: 1 })
  expect(obstruction.lowerCenter).toEqual({ covered: 112 * 244, pixels: 112 * 244, ratio: 1 })
  expect(obstruction.total?.covered).toBe(112 * 244)
  expect(obstruction.lowerHalf?.pixels).toBe(375 * 406)
})

it('malformed masks fail and channel strides preserve measured coverage', () => {
  expect(() => frameObstruction(new Uint8Array(3), { width: 2, height: 2, channels: 1 })).toThrow(
    'dimensions',
  )
  const obstruction = frameObstruction(new Uint8Array([0, 255, 255, 255, 0, 0]), {
    width: 2,
    height: 1,
    channels: 3,
  })
  expect(obstruction.total).toEqual({ covered: 1, pixels: 2, ratio: 0.5 })
})
