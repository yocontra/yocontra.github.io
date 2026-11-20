import { beforeAll, expect, test as it } from 'bun:test'
import { file } from 'bun'
import { initializeAmmo } from 'colyseus-cloudflare/ammo'
import { ENVIRONMENT_PROPS } from '../../src/experiments/out-west/content/environment-props.ts'
import { COLLISION } from '../../src/experiments/out-west/runtime/collision.ts'
import {
  Buttons,
  type CollisionData,
  neutralInput,
} from '../../src/experiments/out-west/runtime/protocol.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'

let ammo: unknown
beforeAll(async () => {
  ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})
const original: CollisionData = {
  version: 'original-barrel-boxes',
  boxes: [
    { center: [64, -0.5, 64], halfExtents: [128, 0.5, 128] },
    ...COLLISION.boxes.filter((box) => ['cover:16', 'cover:36'].includes(box.id ?? '')),
  ],
  meshes: [],
}
function pair() {
  // No domain IDs means no response policy. Both controls still use the exact same native shapes.
  const old = createSimulation({
    ammo,
    collision: { ...original, boxes: original.boxes.map(({ id: _id, ...box }) => box) },
  })
  const response = createSimulation({ ammo, collision: original })
  return {
    old,
    response,
    destroy() {
      old.dispose()
      response.dispose()
    },
  }
}
it('eight authored cells exactly tile the two original boxes without creating intact child bodies', () => {
  const f = pair()
  try {
    f.response.updateProps(new Uint8Array(8).fill(68))
    expect(f.response.app.root.findComponents('rigidbody')).toHaveLength(original.boxes.length)
    for (const cover of [16, 36]) {
      const box = required(original.boxes.find((entry) => entry.id === `cover:${cover}`))
      const parts = ENVIRONMENT_PROPS.filter((prop) => prop.cover === cover)
      expect(parts).toHaveLength(4)
      expect(
        parts.reduce(
          (sum, part) =>
            sum +
            required(part.halfExtents[0]) *
              required(part.halfExtents[1]) *
              required(part.halfExtents[2]) *
              8,
          0,
        ),
      ).toBe(0.95)
      for (const axis of [0, 1, 2]) {
        expect(
          Math.min(
            ...parts.map((part) => required(part.center[axis]) - required(part.halfExtents[axis])),
          ),
        ).toBe(required(box.center[axis]) - required(box.halfExtents[axis]))
        expect(
          Math.max(
            ...parts.map((part) => required(part.center[axis]) + required(part.halfExtents[axis])),
          ),
        ).toBe(required(box.center[axis]) + required(box.halfExtents[axis]))
      }
    }
  } finally {
    f.destroy()
  }
})
it('intact native shot results remain exact across all cell seams and outer boundaries', () => {
  const f = pair()
  try {
    f.response.updateProps(new Uint8Array(8).fill(68))
    for (const z of [65.9, 66, 66.1, 66.25, 66.499, 66.5, 66.501, 66.75, 66.999, 67, 67.1]) {
      for (const y of [0.1, 0.5, 0.9, 0.95, 1.02]) {
        const ray = { ox: 27, oy: y, oz: z, dx: 1, dy: 0, dz: 0, maxT: 3 }
        expect(f.response.castWorld(ray)).toBe(f.old.castWorld(ray))
      }
    }
  } finally {
    f.destroy()
  }
})
it('intact native walking, jumping and top support remain exact before any break', () => {
  const f = pair()
  try {
    const old = f.old.addPlayer('rider', [27, 0.9, 66.5])
    const response = f.response.addPlayer('rider', [27, 0.9, 66.5])
    f.response.updateProps(new Uint8Array(8).fill(68))
    for (let tick = 0; tick < 100; tick++) {
      const command = {
        ...neutralInput(),
        moveX: tick < 50 ? 1 : 0,
        buttons: tick === 50 ? Buttons.jump : 0,
      }
      f.old.step(new Map([['rider', command]]))
      f.response.step(new Map([['rider', command]]))
      expect(response).toEqual(old)
    }
    const topOld = f.old.addPlayer('top', [28.5, 1.85, 66.5])
    const topResponse = f.response.addPlayer('top', [28.5, 1.85, 66.5])
    for (let tick = 0; tick < 60; tick++) {
      f.old.step(new Map())
      f.response.step(new Map())
      expect(topResponse).toEqual(topOld)
    }
    expect(topResponse.y).toBeCloseTo(1.85, 2)
  } finally {
    f.destroy()
  }
})
it('first break replaces only its owner, further removals are idempotent and latejoin applies before movement', () => {
  const f = pair()
  const health = new Uint8Array(8).fill(68)
  const shortRay = { ox: 27, oy: 0.5, oz: 66.25, dx: 1, dy: 0, dz: 0, maxT: 1.45 }
  try {
    health[0] = 0
    f.response.updateProps(health)
    expect(f.response.castWorld(shortRay)).toBeNull()
    expect(f.response.castWorldHit({ ...shortRay, maxT: 3 })?.collider.id).toBe('cover:16:barrel:2')
    expect(f.response.castWorldHit({ ...shortRay, ox: 30, oz: 67.25 })?.collider.id).toBe(
      'cover:36',
    )
    f.response.updateProps(health)
    const cells = f.response.app.root
      .findComponents('rigidbody')
      .filter((body) => body.entity.enabled)
    expect(cells).toHaveLength(5) // floor + untouched cover36 +3remaining individual cells
    health[2] = 0
    f.response.updateProps(health)
    const rider = f.response.addPlayer('through', [27, 0.9, 65.9])
    for (let tick = 0; tick < 20; tick++) {
      f.response.step(new Map([['through', { ...neutralInput(), moveX: 1 }]]))
    }
    expect(rider.x).toBeGreaterThan(29.3)
    expect(f.old.castWorld(shortRay)).not.toBeNull()
  } finally {
    f.destroy()
  }
})

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Incomplete authored barrel data')
  }
  return value
}
