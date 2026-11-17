/** Reads the actual staged/published producer output; it does not call the authoring implementation. */
import { expect, test as it } from 'bun:test'
import { join } from 'node:path'
import process from 'node:process'
import { NodeIO, type Primitive } from '@gltf-transform/core'
import { Vec3 } from 'playcanvas'
import { ENVIRONMENT_PROPS } from '../../src/experiments/out-west/content/environment-props.ts'

const stage = process.env.OW_BARREL_STAGE
const io = new NodeIO()
function required<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) {
    throw new Error('Incomplete produced mesh')
  }
  return v
}
function topology(primitive: Primitive) {
  const positions = required(primitive.getAttribute('POSITION'))
  const indices = required(primitive.getIndices())
  const edges = new Map<string, { forward: number; reverse: number }>()
  const key = (v: Vec3) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e6)).join(':')
  let volume = 0
  let minArea = Number.POSITIVE_INFINITY
  const origin = new Vec3(...positions.getElement(0, [0, 0, 0]))
  for (let i = 0; i < indices.getCount(); i += 3) {
    const tri = [0, 1, 2].map(
      (k) => new Vec3(...positions.getElement(indices.getScalar(i + k), [0, 0, 0])),
    )
    const a = required(tri[0])
    const b = required(tri[1])
    const c = required(tri[2])
    minArea = Math.min(minArea, new Vec3().cross(b.clone().sub(a), c.clone().sub(a)).length() / 2)
    volume +=
      a
        .clone()
        .sub(origin)
        .dot(new Vec3().cross(b.clone().sub(origin), c.clone().sub(origin))) / 6
    for (const [j, a] of tri.entries()) {
      const left = key(a)
      const right = key(required(tri[(j + 1) % 3]))
      const order = [left, right].sort((x, y) => x.localeCompare(y))
      const id = order.join('|')
      const entry = edges.get(id) ?? { forward: 0, reverse: 0 }
      entry[left === order[0] ? 'forward' : 'reverse']++
      edges.set(id, entry)
    }
  }
  return {
    minArea,
    volume,
    bad: [...edges.values()].filter((e) => e.forward !== 1 || e.reverse !== 1).length,
  }
}
it('the actual portable tall body and all48 native donor fragments have conforming directed closed surfaces', async () => {
  const library = await io.read(
    stage ? join(stage, 'barrel-parts.glb') : 'tools/art/environments/barrel-parts.glb',
  )
  const fragments = await io.read(
    stage
      ? join(stage, 'barrel-fragments.glb')
      : 'public/experiments/out-west/3d/native-v2/dynamic/barrel-fragments.glb',
  )
  const tall = library
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === 'barrel-tall')
    ?.getMesh()
  expect(tall).toBeDefined()
  const nodes = fragments.getRoot().listNodes()
  expect(nodes).toHaveLength(48)
  expect(new Set(nodes.map((n) => n.getName())).size).toBe(48)
  expect(fragments.getRoot().listTextures()).toHaveLength(0)
  expect(fragments.getRoot().listAnimations()).toHaveLength(0)
  for (const mesh of [required(tall), ...fragments.getRoot().listMeshes()]) {
    for (const primitive of mesh.listPrimitives()) {
      const result = topology(primitive)
      expect(result.bad, mesh.getName()).toBe(0)
      expect(result.minArea, mesh.getName()).toBeGreaterThan(1e-12)
      expect(result.volume, mesh.getName()).toBeGreaterThan(1e-10)
      for (const attribute of [
        'POSITION',
        'NORMAL',
        'TANGENT',
        'TEXCOORD_0',
        'TEXCOORD_1',
        'COLOR_0',
      ]) {
        expect(required(primitive.getAttribute(attribute)).getArray()?.every(Number.isFinite)).toBe(
          true,
        )
      }
    }
  }
})

it('the actual barrel head has wood within1mm of the unchanged support plane, not just a tall rim', async () => {
  const doc = await io.read(
    stage ? join(stage, 'barrel-parts.glb') : 'tools/art/environments/barrel-parts.glb',
  )
  const primitive = required(
    doc
      .getRoot()
      .listNodes()
      .find((n) => n.getName() === 'barrel-tall')
      ?.getMesh()
      ?.listPrimitives()[0],
  )
  const positions = required(primitive.getAttribute('POSITION'))
  const indices = required(primitive.getIndices())
  const minY = Math.min(
    ...Array.from(
      { length: positions.getCount() },
      (_, i) => positions.getElement(i, [0, 0, 0])[1] ?? Number.POSITIVE_INFINITY,
    ),
  )
  for (const x of [-0.1, -0.05, 0, 0.05, 0.1]) {
    for (const z of [-0.1, 0, 0.1]) {
      const hits: number[] = []
      const ray = new Vec3(0, -1, 0)
      const origin = new Vec3(x, 2, z)
      for (let i = 0; i < indices.getCount(); i += 3) {
        const tri = [0, 1, 2].map(
          (k) => new Vec3(...positions.getElement(indices.getScalar(i + k), [0, 0, 0])),
        )
        const a = required(tri[0])
        const b = required(tri[1])
        const c = required(tri[2])
        const e = b.clone().sub(a)
        const f = c.clone().sub(a)
        const h = new Vec3().cross(ray, f)
        const det = e.dot(h)
        if (Math.abs(det) < 1e-10) {
          continue
        }
        const t = origin.clone().sub(a)
        const u = t.dot(h) / det
        const q = new Vec3().cross(t, e)
        const v = ray.dot(q) / det
        const distance = f.dot(q) / det
        if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7 && distance >= 0) {
          hits.push(2 - distance)
        }
      }
      expect(hits.length).toBeGreaterThan(0)
      const height = (Math.max(...hits) - minY) * required(ENVIRONMENT_PROPS[0]?.binding.scale[1])
      expect(Math.abs(height - 0.95)).toBeLessThan(0.001)
    }
  }
})
