import { expect, test as it } from 'bun:test'
import { type Node, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { getBounds } from '@gltf-transform/functions'
import plan from '../../tools/art/environments/frontier.plan.json' with { type: 'json' }

const directory = 'public/experiments/out-west/3d/native-v2/baked'
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

function height(node: Node) {
  const { min, max } = getBounds(node)
  return max[1] - min[1]
}

it('keeps mature armed saguaros and low prickly pears at their planted scale across detail tiers', async () => {
  const [low, high] = await Promise.all([
    io.read(`${directory}/frontier.glb`),
    io.read(`${directory}/frontier-yard-high.glb`),
  ])
  const plants = low
    .getRoot()
    .listNodes()
    .filter((node) => node.getName().startsWith('prefab.'))
  const specimens = plan.vegetation.map((bed) => {
    const [x, z] = [bed.x + bed.w / 2, bed.z + bed.d / 2]
    const specimen = plants.find((node) => {
      const origin = node.getParentNode()?.getParentNode()?.getWorldTranslation()
      return origin && Math.hypot(origin[0] - x, origin[2] - z) < 0.001
    })
    if (!specimen) {
      throw new Error(`Missing planted specimen at ${x}, ${z}`)
    }
    return { bed, specimen }
  })
  const pears = specimens.filter(({ specimen }) => specimen.getName() === 'prefab.prickly_pear')
  expect(pears).toHaveLength(2)
  for (const { specimen } of pears) {
    expect(height(specimen)).toBeGreaterThan(0.65)
    expect(height(specimen)).toBeLessThan(1.15)
  }
  const saguaros = specimens.filter(({ specimen }) =>
    specimen.getName().startsWith('prefab.saguaro_'),
  )
  expect(saguaros).toHaveLength(6)
  for (const { bed, specimen } of saguaros) {
    expect(height(specimen)).toBeGreaterThan(4)
    expect(height(specimen)).toBeCloseTo(bed.top, 2)
    const { min, max } = getBounds(specimen)
    expect(min[1]).toBeCloseTo(0, 3)
    const spread = Math.max(max[0] - min[0], max[2] - min[2])
    expect(spread / (max[1] - min[1])).toBeGreaterThan(0.12)
    expect(spread / (max[1] - min[1])).toBeLessThan(0.3)
  }

  for (const [name, floor] of [
    ['saguaro_far_one_arm', 3.75],
    ['saguaro_far_two_arm', 5.75],
  ] as const) {
    const distant = plants.filter((node) => node.getName() === `prefab.${name}`)
    expect(distant.length).toBeGreaterThan(20)
    const heights = distant.map(height)
    expect(Math.min(...heights)).toBeGreaterThan(floor)
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(3)
  }

  const lowYard = plants.filter((node) => node.getName() === 'prefab.saguaro_two_arm')
  const highYard = high
    .getRoot()
    .listNodes()
    .filter((node) => node.getMesh())
  expect(highYard).toHaveLength(3)
  expect(lowYard).toHaveLength(highYard.length)
  for (const lowPlant of lowYard) {
    const origin = lowPlant.getWorldTranslation()
    const highPlant = highYard.find((node) =>
      node
        .getWorldTranslation()
        .every((value, axis) => Math.abs(value - (origin[axis] ?? 0)) < 0.001),
    )
    if (!highPlant) {
      throw new Error(`Missing High specimen at ${origin.join(', ')}`)
    }
    expect(height(highPlant)).toBeCloseTo(height(lowPlant), 3)
    for (const [axis, component] of lowPlant.getWorldMatrix().entries()) {
      expect(highPlant.getWorldMatrix()[axis]).toBeCloseTo(component, 4)
    }
  }
})
