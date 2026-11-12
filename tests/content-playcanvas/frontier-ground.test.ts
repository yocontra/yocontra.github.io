import { beforeAll, expect, it } from 'bun:test'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { file } from 'bun'
import { TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { newMotion } from '../../src/experiments/out-west/runtime/abilities.ts'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'
import { Buttons, neutralInput } from '../../src/experiments/out-west/runtime/protocol.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'
import ground from '../../tools/art/environments/frontier-ground.json' with { type: 'json' }
import { compileFrontierCollision, perimeterSpans } from '../../tools/content/frontier-collision.ts'
import { frontierGround, frontierGroundTransform } from '../../tools/content/frontier-ground.ts'
import { packFrontierVertices } from '../../tools/content/frontier-vertex-packing.ts'
import { repairFrontierWinding } from '../../tools/content/frontier-winding.ts'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
let ammo: unknown
beforeAll(async () => {
  ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})
it('outskirts and every preserved wind patch share one continuous uniform frame', async () => {
  const source = await io.read('tools/art/environments/frontier.glb')
  const frame = frontierGroundTransform(TOWN.size)
  const forest = source
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'frontier-desert-vegetation')
  expect(forest?.getTranslation()).toEqual(frame.translation)
  expect(forest?.getScale()).toEqual([frame.scale, frame.scale, frame.scale])
  const foliage = forest?.listChildren() ?? []
  expect(foliage).toHaveLength(19)
  for (const node of foliage) {
    expect(node.getTranslation()).toEqual([0, 0, 0])
  }
  const meshes = frontierGround(TOWN.size)
  expect(meshes).toHaveLength(4)
  for (const [index, mesh] of meshes.entries()) {
    const original = ground.meshes[index]
    if (!original) {
      throw new Error('Missing canonical outskirts side')
    }
    expect(mesh.indices).toEqual(original.indices)
    for (const [component, value] of mesh.positions.entries()) {
      expect(value).toBe(
        (original.positions[component] ?? Number.NaN) * frame.scale +
          (frame.translation[component % 3] ?? Number.NaN),
      )
    }
  }
})
it('native packing preserves positions, UVs, wind, world transforms and timing at high normal precision', async () => {
  const source = await io.read('tools/art/environments/frontier.glb')
  const proof = await packFrontierVertices(source)
  expect(proof.maximumNormalAngle).toBeLessThan(0.003)
  expect(proof.maximumTangentAngle).toBeLessThan(0.003)
  expect(proof.geometry).toHaveLength(64)
})
it('inside-out flora is corrected once while intentional double-sided faces stay untouched', async () => {
  const canonical = await io.read('tools/art/environments/frontier-library.glb')
  const repaired = repairFrontierWinding(canonical)
  expect(repaired.every((mesh) => mesh.material === 'flora')).toBe(true)
  expect(repaired.reduce((sum, mesh) => sum + mesh.triangles, 0)).toBeGreaterThan(10_000)
  expect(repairFrontierWinding(canonical)).toEqual([])
  const published = await io.read('tools/art/environments/frontier.glb')
  expect(repairFrontierWinding(published)).toEqual([])
})
it('every visible boundary rail and post has the exact matching native collider', () => {
  const collision = compileFrontierCollision(TOWN)
  for (const span of perimeterSpans(TOWN.size)) {
    const box = collision.boxes.find((candidate) => candidate.id === span.id)
    expect(box?.center).toEqual([span.x + span.w / 2, (span.y0 + span.y1) / 2, span.z + span.d / 2])
    expect(box?.halfExtents).toEqual([span.w / 2, (span.y1 - span.y0) / 2, span.d / 2])
  }
  expect(new Set(collision.boxes.map((box) => box.id)).size).toBe(collision.boxes.length)
})
function boundaryButtons(mode: string, tick: number) {
  const edge = tick % 20 === 0
  if (mode === 'sprint') {
    return Buttons.sprint
  }
  if (mode === 'crouch-jump') {
    return Buttons.crouch | (edge ? Buttons.jump : 0)
  }
  if (!edge) {
    return 0
  }
  if (mode === 'jump') {
    return Buttons.jump
  }
  if (mode === 'interact') {
    return Buttons.interact
  }
  return 0
}

const perimeterSides = [
  { side: 'west', x: 1.3, z: null, moveX: -1, moveZ: 0 },
  { side: 'east', x: TOWN.size - 1.3, z: null, moveX: 1, moveZ: 0 },
  { side: 'north', x: null, z: 1.3, moveX: 0, moveZ: -1 },
  { side: 'south', x: null, z: TOWN.size - 1.3, moveX: 0, moveZ: 1 },
]
it.each(perimeterSides)(
  'real native bodies cannot walk, sprint, jump, crouch-vault or interact out of the $side perimeter',
  (side) => {
    const simulation = createSimulation({ ammo, collision: compileFrontierCollision(TOWN) })
    const body = simulation.addPlayer('edge')
    const scenarios = [3.25, 19.75, 51.75, 79.75, 100.75].flatMap((along) =>
      ['walk', 'sprint', 'jump', 'crouch-jump', 'interact'].map((mode) => ({
        ...side,
        x: side.x ?? along,
        z: side.z ?? along,
        mode,
      })),
    )
    try {
      for (const { x, z, moveX, moveZ, mode } of scenarios) {
        simulation.adopt('edge', {
          ...body,
          x,
          y: 0.9,
          z,
          vx: 0,
          vy: 0,
          vz: 0,
          grounded: false,
          crouched: false,
          lastButtons: 0,
          motion: newMotion(x, 0, z),
        })
        for (let tick = 0; tick < 12; tick++) {
          simulation.step(new Map())
        }
        for (let tick = 0; tick < 100; tick++) {
          simulation.step(
            new Map([
              [
                'edge',
                {
                  ...neutralInput(),
                  moveX,
                  moveZ,
                  yaw: Math.atan2(-moveX, -moveZ),
                  buttons: boundaryButtons(mode, tick),
                },
              ],
            ]),
          )
          expect(body.x).toBeGreaterThanOrEqual(0)
          expect(body.x).toBeLessThanOrEqual(TOWN.size)
          expect(body.z).toBeGreaterThanOrEqual(0)
          expect(body.z).toBeLessThanOrEqual(TOWN.size)
        }
      }
    } finally {
      simulation.dispose()
    }
  },
)

const stockyardCargo = TOWN.cover.filter(
  (cover) =>
    cover.kind === 'crate_stack' &&
    cover.top === 4 &&
    (cover.x < 4 || cover.x + cover.w > TOWN.size - 5),
)
const stockyardRoutes = [
  {
    route: 'cargo stack approaches',
    cases: stockyardCargo
      .flatMap((cover) =>
        [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ].map(([dx = 0, dz = 0]) => ({
          x: cover.x + cover.w / 2 + dx * (cover.w / 2 + 0.65),
          y: 0,
          z: cover.z + cover.d / 2 + dz * (cover.d / 2 + 0.65),
          moveX: -dx,
          moveZ: -dz,
        })),
      )
      .filter((start) => start.x >= 0.9 && start.x <= TOWN.size - 0.9),
  },
  {
    route: 'boxcar roofs',
    cases: TOWN.cover
      .filter((cover) => cover.kind === 'boxcar')
      .flatMap((cover) =>
        [0.18, 0.5, 0.82].map((along) => ({
          x: cover.x + cover.w * along,
          y: cover.top ?? 3.8,
          z: cover.z + cover.d / 2,
          moveX: 0,
          moveZ: 1,
        })),
      ),
  },
  {
    route: 'fence-line stacks',
    cases: [
      { x: 7.36, y: 0.95, z: 36.82, moveX: -1, moveZ: -0.4 },
      { x: 7.27, y: 0.95, z: 40.23, moveX: -1, moveZ: 0 },
      { x: 6.27, y: 0.95, z: 42.27, moveX: -1, moveZ: -0.4 },
      // This 2.3m stack formerly ended only5.25m from the fence: a roof jump cleared it.
      { x: 94.906, y: 2.3, z: 44.396, moveX: 1, moveZ: 0 },
    ],
  },
]
it('the stockyard escape routes cover all seven tall cargo stacks and every boxcar', () => {
  expect(stockyardCargo).toHaveLength(7)
  for (const { cases } of stockyardRoutes) {
    expect(cases.length).toBeGreaterThan(0)
  }
})
it.each(stockyardRoutes)(
  'reachable $route and repeated jump/interact chains cannot escape the stockyard',
  ({ cases }) => {
    const simulation = createSimulation({ ammo, collision: compileFrontierCollision(TOWN) })
    const body = simulation.addPlayer('chain')
    try {
      for (const start of cases) {
        for (const interval of [14, 20]) {
          simulation.adopt('chain', {
            ...body,
            x: start.x,
            y: start.y + 0.94,
            z: start.z,
            vx: 0,
            vy: 0,
            vz: 0,
            grounded: false,
            crouched: false,
            lastButtons: 0,
            motion: newMotion(start.x, start.y + 0.04, start.z),
          })
          for (let tick = 0; tick < 15; tick++) {
            simulation.step(new Map())
          }
          expect(body.grounded).toBe(true)
          const magnitude = Math.hypot(start.moveX, start.moveZ)
          for (let tick = 0; tick < 100; tick++) {
            simulation.step(
              new Map([
                [
                  'chain',
                  {
                    ...neutralInput(),
                    moveX: start.moveX / magnitude,
                    moveZ: start.moveZ / magnitude,
                    yaw: Math.atan2(-start.moveX, -start.moveZ),
                    buttons:
                      Buttons.sprint |
                      (tick % interval === 0 ? Buttons.jump : 0) |
                      (tick % interval === 7 ? Buttons.interact : 0),
                  },
                ],
              ]),
            )
            expect(body.x).toBeGreaterThanOrEqual(0)
            expect(body.x).toBeLessThanOrEqual(TOWN.size)
            expect(body.z).toBeGreaterThanOrEqual(0)
            expect(body.z).toBeLessThanOrEqual(TOWN.size)
          }
        }
      }
    } finally {
      simulation.dispose()
    }
  },
)
