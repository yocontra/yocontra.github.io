import { expect, test as it } from 'bun:test'
import {
  AppBase,
  AppOptions,
  BatchManager,
  Entity,
  NullGraphicsDevice,
  RenderComponentSystem,
  Vec3,
} from 'playcanvas'
import { BucketResponse } from '../../src/experiments/out-west/client/bucket-response.ts'
import { BUCKET_NODE_PREFIX } from '../../src/experiments/out-west/content/metal-buckets.ts'

it('a confirmed bucket moves from its grouped draw, tips without moving the base, then restores placement', () => {
  const graphicsDevice = new NullGraphicsDevice({ width: 64, height: 64 })
  const app = new AppBase(graphicsDevice.canvas)
  const options = new AppOptions()
  options.graphicsDevice = graphicsDevice
  options.batchManager = BatchManager
  options.componentSystems = [RenderComponentSystem]
  app.init(options)
  const town = new Entity('town', app)
  app.root.addChild(town)
  const bucket = new Entity(`${BUCKET_NODE_PREFIX}250`, app)
  town.addChild(bucket)
  bucket.setLocalPosition(6, 0.06, 5)
  bucket.setLocalEulerAngles(0, 24, 0)
  bucket.addComponent('render', { type: 'box' })
  const render = bucket.render
  const group = app.batcher?.addGroup('test-buckets', false, 104)
  if (!(render && group)) {
    throw new Error('Missing native bucket draw')
  }
  render.batchGroupId = group.id
  const response = new BucketResponse(town)
  const base = bucket.getLocalRotation().clone()
  const mount = bucket.getLocalPosition().clone()
  const world = { seed: 7, tick: 50 }
  const hit = {
    type: 'prop_rattle',
    seed: 7,
    tick: 51,
    cover: 250,
    dx: 1,
    dz: 0,
    strength: 1,
  } as const
  try {
    expect(response.event(hit, 0)).toBe(false)
    response.update(world, 0)
    expect(response.event({ ...hit, seed: 9 }, 0)).toBe(false)
    expect(response.event(hit, 100)).toBe(true)
    expect(response.event(hit, 120)).toBe(false)
    expect(render.batchGroupId).toBe(-1)
    response.update(world, 185)
    const tilted = bucket.getLocalRotation().clone()
    expect(tilted.transformVector(Vec3.UP).x).toBeGreaterThan(0.1)
    expect(bucket.getLocalPosition().equals(mount)).toBe(true)
    expect(response.event({ ...hit, dx: -1, tick: 52 }, 200)).toBe(true)
    response.update(world, 200)
    expect(bucket.getLocalRotation().equals(tilted)).toBe(true)
    response.update(world, 1001)
    expect(bucket.getLocalRotation().equals(base)).toBe(true)
    expect(render.batchGroupId).toBe(group.id)
    world.tick = 100
    expect(response.event({ ...hit, tick: 65 }, 1020)).toBe(false)
    expect(response.event({ ...hit, tick: 101 }, 1020)).toBe(true)
    response.update({ seed: 8, tick: 0 }, 1080)
    expect(bucket.getLocalRotation().equals(base)).toBe(true)
    expect(render.batchGroupId).toBe(group.id)
  } finally {
    response.destroy()
    app.destroy()
  }
})
