import { expect, it } from 'bun:test'
import { Color, Group, Matrix4 } from 'three'
import { VatHats } from '../src/experiments/out-west/ffa/scene/crowd/hats.ts'

it('warms actual retained instanced hat colors once and restores active draws, including retry', () => {
  const root = new Group()
  const hats = new VatHats(root, 4)
  const mesh = hats.mesh('cowboy', 'bronze')
  const matrix = new Matrix4().makeTranslation(3, 4, 5)
  const color = new Color(0x8a_4a_2a)
  mesh.setMatrixAt(0, matrix)
  mesh.setColorAt(0, color)
  mesh.count = 2
  mesh.visible = false
  mesh.frustumCulled = true
  let calls = 0
  const warm = () => {
    calls++
    expect(mesh.count).toBe(1)
    expect(mesh.visible).toBe(true)
    expect(mesh.frustumCulled).toBe(false)
    expect(mesh.instanceColor).not.toBeNull()
    const material = mesh.material
    if (Array.isArray(material)) {
      throw new Error('Expected actual scalar felt')
    }
    expect(material.customProgramCacheKey()).toBe('ow-far-hat2')
  }
  expect(() =>
    hats.warm(() => {
      warm()
      throw new Error('retry')
    }),
  ).toThrow('retry')
  expect(mesh.count).toBe(2)
  expect(mesh.visible).toBe(false)
  expect(mesh.frustumCulled).toBe(true)
  hats.warm(warm)
  hats.warm(warm)
  expect(calls).toBe(2)
  const restored = new Matrix4()
  const tint = new Color()
  mesh.getMatrixAt(0, restored)
  mesh.getColorAt(0, tint)
  expect(restored.equals(matrix)).toBe(true)
  expect(Math.hypot(tint.r - color.r, tint.g - color.g, tint.b - color.b)).toBeLessThan(1e-6)
  const next = hats.mesh('tall', 'rattler')
  hats.warm(() => {
    calls++
    expect(next.count).toBe(1)
    expect(mesh.count).toBe(2)
    expect(next.instanceColor).not.toBeNull()
  })
  hats.warm(() => {
    calls++
  })
  expect(calls).toBe(3)
  expect(next.count).toBe(0)
  hats.dispose()
  hats.warm(() => {
    calls++
  })
  expect(calls).toBe(3)
})
