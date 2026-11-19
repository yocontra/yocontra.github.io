import { expect, test as it } from 'bun:test'
import {
  AnimComponentSystem,
  AnimCurve,
  AnimData,
  AnimTrack,
  AppBase,
  AppOptions,
  Asset,
  type ContainerResource,
  Entity,
  Frustum,
  INTERPOLATION_LINEAR,
  Mat4,
  Mesh,
  MeshInstance,
  Morph,
  MorphInstance,
  MorphTarget,
  NullGraphicsDevice,
  RenderComponentSystem,
  StandardMaterial,
  Vec3,
} from 'playcanvas'
import { animateWind } from '../../src/experiments/out-west/client/environment-assets.ts'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'

function fixture(name: string, weights: number[] = [0, 1, 0, -1, 0], delta = 0.25) {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [AnimComponentSystem, RenderComponentSystem]
  app.init(options)
  const root = new Entity('town', app)
  const foliage = new Entity(name, app)
  app.root.addChild(root)
  root.addChild(foliage)
  const mesh = new Mesh(device)
  mesh.setPositions([0, 0, 0, 1, 0, 0, 0, 1, 0])
  mesh.update()
  mesh.morph = new Morph(
    [
      new MorphTarget({
        name: '0',
        deltaPositions: new Float32Array([delta, 0, 0, delta, 0, 0, delta, 0, 0]),
      }),
    ],
    device,
  )
  const material = new StandardMaterial()
  const instance = new MeshInstance(mesh, material, foliage)
  instance.morphInstance = new MorphInstance(mesh.morph)
  foliage.addComponent('render', { meshInstances: [instance] })
  const path = { entityPath: ['town', name], component: 'graph', propertyPath: ['weight.name.0'] }
  const track = new AnimTrack(
    'Wind',
    8,
    [new AnimData(1, [0, 2, 4, 6, 8])],
    [new AnimData(1, weights)],
    [new AnimCurve([path], 0, 0, INTERPOLATION_LINEAR)],
  )
  const asset = new Asset(ASSETS.frontier.url, 'container')
  asset.resource = { animations: [{ name: 'Wind', resource: track }] } as ContainerResource
  return {
    root,
    instance,
    asset,
    dispose: () => {
      app.destroy()
      material.destroy()
    },
  }
}

it('signed Frontier wind keeps both ends visible near a native frustum edge', () => {
  const f = fixture('flora-416')
  try {
    const stock = f.instance.aabb.clone()
    const left = new Frustum()
    left.setFromMat4(new Mat4().setOrtho(-1, -0.125, -1, 2, -1, 1))
    const right = new Frustum()
    right.setFromMat4(new Mat4().setOrtho(1.125, 2, -1, 2, -1, 1))
    expect(left.containsPoint(new Vec3(-0.25, 0, 0))).toBeTrue()
    expect(right.containsPoint(new Vec3(1.25, 0, 0))).toBeTrue()
    expect(left.containsAabb(stock)).toBeFalse()
    expect(right.containsAabb(stock)).toBeTrue()
    animateWind(f.root, f.asset, true)
    expect(left.containsAabb(f.instance.aabb)).toBeTrue()
    expect(right.containsAabb(f.instance.aabb)).toBeTrue()
    expect(f.instance.aabb.getMin().x).toBeLessThanOrEqual(-0.25)
    expect(f.instance.aabb.getMax().x).toBeGreaterThanOrEqual(1.25)
    expect(f.instance.morphInstance?.morph.targets[0]?.aabb.getMin().x).toBe(0.25)
  } finally {
    f.dispose()
  }
})

interface BoundsCase {
  frontier?: boolean
  assetName?: string
  node?: string
  weights?: number[]
  delta?: number
}

it.each([
  ['non-Frontier scene', { frontier: false }],
  ['different asset', { assetName: 'other.glb' }],
  ['non-flora morph', { node: 'clock-gear' }],
  ['unsigned wind', { weights: [0, 1, 0, 1, 0] }],
  ['inert target', { delta: 0 }],
  ['weight outside the authored range', { weights: [0, 1, 0, -2, 0] }],
] satisfies [string, BoundsCase][])('keeps native bounds for %s', (_case, options: BoundsCase) => {
  const f = fixture(options.node ?? 'flora-416', options.weights, options.delta)
  try {
    const stock = f.instance.aabb.clone()
    f.asset.name = options.assetName ?? ASSETS.frontier.url
    animateWind(f.root, f.asset, options.frontier ?? true)
    expect(f.instance.aabb.getMin()).toEqual(stock.getMin())
    expect(f.instance.aabb.getMax()).toEqual(stock.getMax())
  } finally {
    f.dispose()
  }
})
