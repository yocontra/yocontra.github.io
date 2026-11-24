import { expect, test as it } from 'bun:test'
import { Document } from '@gltf-transform/core'
import { getBounds } from '@gltf-transform/functions'
import type { TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import plan from '../../tools/art/environments/frontier.plan.json' with { type: 'json' }
import { installStreetTrades } from '../../tools/content/frontier-street-trades.ts'

const art = 'tools/art/environments/frontier-street-trades.glb'
const town = plan.layout as TownLayout

function emptyTown(): Document {
  const doc = new Document()
  doc.createScene().addChild(doc.createNode('town'))
  return doc
}

it('fits the Blender street trades inside their supports and clear of the main travel lanes', async () => {
  const scene = emptyTown()
  await installStreetTrades(scene, town, art)
  const root = scene.getRoot()
  const fittings = root.listNodes().filter((n) => n.getName().startsWith('street-trade:'))
  expect(fittings).toHaveLength(19)
  expect(new Set(fittings.map((n) => n.getMesh())).size).toBe(12)
  let triangles = 0
  for (const fitting of fittings) {
    const { min, max } = getBounds(fitting)
    expect([...min, ...max].every(Number.isFinite)).toBe(true)
    for (const street of town.streets) {
      expect(
        min[0] >= street.x + street.w ||
          max[0] <= street.x ||
          min[2] >= street.z + street.d ||
          max[2] <= street.z,
      ).toBe(true)
    }
    for (const primitive of fitting.getMesh()?.listPrimitives() ?? []) {
      expect(primitive.getAttribute('COLOR_0')).not.toBeNull()
      expect(primitive.getAttribute('TEXCOORD_0')).not.toBeNull()
      triangles += (primitive.getIndices()?.getCount() ?? 0) / 3
    }
  }
  expect(triangles).toBeLessThan(32_000)
  expect(root.listMaterials()).toHaveLength(4)
  const pump = fittings.find((n) => n.getName().endsWith(':stock-trough-pump'))
  if (!pump) {
    throw new Error('Missing paddock pump')
  }
  const { min, max } = getBounds(pump)
  const trough = town.cover.find((c) => c.kind === 'trough' && c.x === 7)
  expect(min[1]).toBeCloseTo(trough?.top ?? 0, 3)
  // The plank bridges the two real trough rims. The open water is lower than the rims.
  expect(max[2] - min[2]).toBeCloseTo(0.98, 3)
})

it('rejects a moved support or a new ground-floor opening under a wall fitting', async () => {
  const changed = structuredClone(town)
  const smithy = changed.buildings.find((b) => b.id === 'smithy')
  if (!smithy) {
    throw new Error('Missing smithy')
  }
  smithy.doors.push({ side: 'n', at: 0.7, width: 0.7 })
  await expect(installStreetTrades(emptyTown(), changed, art)).rejects.toThrow(
    'intersects an opening',
  )
  const missing = { ...town, cover: town.cover.filter((c) => c.kind !== 'trough') }
  await expect(installStreetTrades(emptyTown(), missing, art)).rejects.toThrow('Missing trough')
})
