import { expect, it } from 'bun:test'
import { DataUtils, Vector3 } from 'three'
import {
  atlasRows,
  packNormal,
  unpackNormal,
} from '../src/experiments/out-west/ffa/scene/crowd/packing.ts'

it('preserves normals across every octahedron fold with less than one degree of quantization error', () => {
  const out = new Uint8Array(2)
  const source = new Vector3()
  const decoded = new Vector3()
  let worst = 0
  for (let y = 0; y <= 80; y++) {
    const phi = (y / 80) * Math.PI
    for (let x = 0; x < 160; x++) {
      const theta = (x / 160) * Math.PI * 2
      source.set(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi))
      packNormal(source, out, 0)
      unpackNormal(out[0] ?? 0, out[1] ?? 0, decoded)
      const degrees = (Math.acos(Math.min(1, Math.max(-1, source.dot(decoded)))) * 180) / Math.PI
      worst = Math.max(worst, degrees)
    }
  }
  expect(worst).toBeLessThan(1)
})

it('packs all frame boundaries without padding each character frame or changing half precision', () => {
  const vertices = 1647
  const frames = 177
  const width = 1024
  const positions = new Uint16Array(atlasRows(vertices, frames, 3, width) * width * 4)
  let worst = 0
  for (let frame = 0; frame < frames; frame++) {
    for (let vertex = 0; vertex < vertices; vertex++) {
      const index = (frame * vertices + vertex) * 3
      let errorSq = 0
      for (let axis = 0; axis < 3; axis++) {
        const value = Math.sin((frame * 13 + vertex * 7 + axis * 23) * 0.17) * 2
        positions[index + axis] = DataUtils.toHalfFloat(value)
        // Same address/channel calculation as the shader, including vertices spanning texels/rows.
        const scalar = index + axis
        const texel = Math.floor(scalar / 4)
        const channel = scalar % 4
        const decoded = DataUtils.fromHalfFloat(positions[texel * 4 + channel] ?? 0)
        errorSq += (decoded - value) ** 2
      }
      worst = Math.max(worst, Math.sqrt(errorSq))
    }
  }
  const compactBytes = positions.byteLength + atlasRows(vertices, frames, 2, width) * width * 4
  const previousBytes = width * Math.ceil(vertices / width) * frames * 12
  expect(compactBytes / previousBytes).toBeLessThan(0.55)
  expect(worst).toBeLessThan(0.0018)
})
