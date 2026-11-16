import { expect, test as it } from 'bun:test'
import {
  type ContainerResource,
  Entity,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  StandardMaterial,
} from 'playcanvas'
import { NativeEnvironment } from '../../src/experiments/out-west/client/environment.ts'
import { worldCloudMaterials } from '../../src/experiments/out-west/client/environment-assets.ts'

it('world cloud coordinates belong only to the owned freight material clone', () => {
  const environment = Object.create(NativeEnvironment.prototype) as NativeEnvironment
  const materials = new Set<StandardMaterial>()
  Reflect.set(environment, 'materials', materials)
  Reflect.set(environment, 'cloudMaterials', new Set())
  Reflect.set(environment, 'frontier', true)
  const source = new StandardMaterial()
  source.name = 'Renamed display label'
  source.gloss = 0.8
  source.glossInvert = true
  source.metalness = 0.7
  const other = new StandardMaterial()
  other.name = 'Freight scanned atlas'
  const selected = worldCloudMaterials({
    materials: [{ resource: source }, { resource: other }],
    data: { gltf: { materials: [{ extras: { freightWorldUv1: true } }, {}] } },
  } as unknown as ContainerResource)
  expect([...selected]).toEqual([source])
  const clones = new Map<StandardMaterial, StandardMaterial>()
  const own = (original: StandardMaterial) =>
    Reflect.get(environment, 'ownMaterial').call(
      environment,
      original,
      clones,
      new Entity('freight'),
      selected.has(original),
    ) as StandardMaterial
  try {
    const material = own(source)
    expect(material).not.toBe(source)
    expect(own(source)).toBe(material)
    expect(clones.size).toBe(1)
    expect(source.hasShaderChunks).toBe(false)
    expect(material.shaderChunksVersion).toBe('2.23')
    expect(material.getShaderChunks(SHADERLANGUAGE_GLSL).get('uv1VS')).toBe(
      'vec2 getUv1() { return dPositionW.xz / 1024.0; }',
    )
    expect(material.getShaderChunks(SHADERLANGUAGE_WGSL).get('uv1VS')).toBe(
      'fn getUv1() -> vec2f { return dPositionW.xz / 1024.0; }',
    )
    expect([material.gloss, material.glossInvert, material.metalness]).toEqual([0.8, true, 0.7])
    expect([material.diffuseMapUv, material.normalMapUv, material.aoMapUv]).toEqual([0, 0, 0])
    expect(material.diffuseDetailMapUv).toBe(1)
    const cloned = material.clone()
    expect(cloned.getShaderChunks(SHADERLANGUAGE_GLSL).get('uv1VS')).toBe(
      material.getShaderChunks(SHADERLANGUAGE_GLSL).get('uv1VS'),
    )
    expect(cloned.getShaderChunks(SHADERLANGUAGE_WGSL).get('uv1VS')).toBe(
      material.getShaderChunks(SHADERLANGUAGE_WGSL).get('uv1VS'),
    )
    cloned.destroy()
    expect(own(other).hasShaderChunks).toBe(false)
    expect(other.hasShaderChunks).toBe(false)
  } finally {
    for (const material of materials) {
      material.destroy()
    }
    source.destroy()
    other.destroy()
  }
})
