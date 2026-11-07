import { expect, it } from 'bun:test'
import { BufferGeometry, Color, DataTexture, Float32BufferAttribute, Matrix4, Scene } from 'three'
import type { Assets } from '../src/experiments/out-west/engine/assets.ts'
import { type VatBake, VatCrowd } from '../src/experiments/out-west/ffa/scene/crowd/vat.ts'
import { Crowd } from '../src/experiments/out-west/ffa/scene/crowd.ts'
import { lookFor } from '../src/experiments/out-west/ffa/scene/looks.ts'

function body(): VatCrowd {
  const geometry = new BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0], 3),
  )
  const bake = {
    geometry,
    posTex: new DataTexture(),
    nrmTex: new DataTexture(),
    vertexCount: 1,
    clips: [{ name: 'Idle', start: 3, frames: 12 }],
  } as VatBake
  return new VatCrowd(bake, 4)
}
const colors = {
  top: new Color(0x8a_4a_2a),
  bottom: new Color(0x21_32_45),
  sleeves: new Color(0x78_67_56),
  hair: new Color(0x22_11_00),
  skin: new Color(0x98_77_66),
}
const arrays = (vat: VatCrowd) =>
  JSON.stringify(
    Object.entries(vat.mesh.geometry.attributes).map(([key, value]) => [
      key,
      Array.from(value.array),
    ]),
  )

it('stages real VAT clip/palettes and restores every attribute, active count and matrix on failure/retry', () => {
  const vat = body()
  const matrix = new Matrix4().makeTranslation(4, 5, 6)
  vat.mesh.setMatrixAt(0, matrix)
  const idle = vat.clip('Idle')
  if (!idle) {
    throw new Error('Missing actual idle clip')
  }
  vat.set(0, idle, { phase: 8, speed: 2 }, colors)
  vat.mesh.count = 2
  vat.mesh.visible = false
  vat.mesh.frustumCulled = true
  const original = arrays(vat)
  const failed = vat.stageWarm(colors)
  if (!failed) {
    throw new Error('Actual zero-count program was not staged')
  }
  expect(vat.mesh.count).toBe(1)
  expect(vat.mesh.visible).toBe(true)
  expect(vat.mesh.frustumCulled).toBe(false)
  expect(vat.mesh.geometry.getAttribute('vatClip').getX(0)).toBe(3)
  expect(vat.mesh.geometry.getAttribute('vatClip').getY(0)).toBe(12)
  failed(false)
  expect(vat.warmReady).toBe(false)
  expect(vat.mesh.count).toBe(2)
  expect(vat.mesh.visible).toBe(false)
  expect(vat.mesh.frustumCulled).toBe(true)
  expect(arrays(vat)).toBe(original)
  const restored = new Matrix4()
  vat.mesh.getMatrixAt(0, restored)
  expect(restored.equals(matrix)).toBe(true)
  const success = vat.stageWarm(colors)
  if (!success) {
    throw new Error('Failed warmup could not retry')
  }
  success(true)
  expect(vat.warmReady).toBe(true)
  expect(vat.stageWarm(colors)).toBeNull()
  expect(arrays(vat)).toBe(original)
  const next = body()
  expect(next.warmReady).toBe(false)
  expect(next.stageWarm(colors)).not.toBeNull()
  for (const item of [vat, next]) {
    item.mesh.dispose()
    item.mesh.geometry.dispose()
    item.bake.geometry.dispose()
    item.bake.posTex.dispose()
    item.bake.nrmTex.dispose()
    for (const material of Array.isArray(item.mesh.material)
      ? item.mesh.material
      : [item.mesh.material]) {
      material.dispose()
    }
  }
})

it('keeps one retired actual far material until replacement variants draw successfully', () => {
  const previous = Reflect.get(globalThis, 'document')
  Reflect.set(globalThis, 'document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  })
  const crowd = new Crowd(new Scene(), {} as Assets, 0)
  const first = body()
  const next = body()
  const material = first.mesh.material
  if (Array.isArray(material)) {
    throw new Error('Expected real scalar VAT material')
  }
  let disposed = 0
  material.addEventListener('dispose', () => {
    disposed++
  })
  const look = lookFor([], 1)
  const members = Reflect.get(crowd, 'members') as Map<number, unknown>
  const vats = Reflect.get(crowd, 'vats') as Map<string, VatCrowd>
  const owners = Reflect.get(crowd, 'vatOwners') as Map<string, typeof look.look>
  const release = Reflect.get(crowd, 'releaseVariant') as (
    key: string,
    style: typeof look.look,
  ) => void
  members.set(1, { look, vatKey: 'old', actor: null })
  vats.set('old', first)
  owners.set('old', look.look)
  try {
    crowd.warmFar(() => expect(first.mesh.count).toBe(1))
    expect(first.warmReady).toBe(true)
    release.call(crowd, 'old', look.look)
    expect(disposed).toBe(0)
    members.set(1, { look, vatKey: 'new', actor: null })
    vats.set('new', next)
    owners.set('new', look.look)
    expect(() =>
      crowd.warmFar(() => {
        throw new Error('failed draw')
      }),
    ).toThrow('failed draw')
    expect(disposed).toBe(0)
    expect(next.warmReady).toBe(false)
    let callbacks = 0
    crowd.warmFar(() => {
      callbacks++
      expect(disposed).toBe(0)
      expect(next.mesh.count).toBe(1)
    })
    expect(disposed).toBe(1)
    expect(next.warmReady).toBe(true)
    crowd.warmFar(() => {
      callbacks++
    })
    expect(callbacks).toBe(1)
  } finally {
    crowd.dispose()
    for (const item of [first, next]) {
      item.bake.geometry.dispose()
      item.bake.posTex.dispose()
      item.bake.nrmTex.dispose()
    }
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, 'document')
    } else {
      Reflect.set(globalThis, 'document', previous)
    }
  }
  expect(disposed).toBe(1)
})
