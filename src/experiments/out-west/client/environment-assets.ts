import {
  AnimTrack,
  type Asset,
  BoundingBox,
  type ContainerResource,
  Entity,
  type GraphicsDevice,
  INTERPOLATION_LINEAR,
  type MeshInstance,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  ShaderChunks,
  StandardMaterial,
  type Vec2,
  Vec3,
} from 'playcanvas'
import { ASSETS } from '../content/manifest.ts'

/** Authoring marks shared local meshes explicitly; material names are display labels. */
export function worldCloudMaterials(resource: ContainerResource): Set<StandardMaterial> {
  const gltf = (
    resource as ContainerResource & {
      data: { gltf?: { materials?: { extras?: { freightWorldUv1?: boolean } }[] } }
    }
  ).data.gltf
  return new Set(
    resource.materials.flatMap((asset, index) =>
      gltf?.materials?.[index]?.extras?.freightWorldUv1 === true &&
      asset.resource instanceof StandardMaterial
        ? [asset.resource]
        : [],
    ),
  )
}

/** Set grazing-angle sign filtering and world-space cloud coordinates before batching. */
export function prepareEnvironmentMaterial(material: StandardMaterial, worldClouds: boolean): void {
  if (material.name === 'Perdition painted signs' && material.diffuseMap) {
    material.diffuseMap.anisotropy = Math.min(8, material.diffuseMap.device.maxAnisotropy)
  }
  if (!worldClouds) {
    return
  }
  material.shaderChunksVersion = '2.23'
  material
    .getShaderChunks(SHADERLANGUAGE_GLSL)
    .set('uv1VS', 'vec2 getUv1() { return dPositionW.xz / 1024.0; }')
  material
    .getShaderChunks(SHADERLANGUAGE_WGSL)
    .set('uv1VS', 'fn getUv1() -> vec2f { return dPositionW.xz / 1024.0; }')
  material.update()
}

/** One device uniform moves all Frontier cloud shadows without updating every material. */
export function sharedCloudMotion(device: GraphicsDevice) {
  if (!device.isWebGL2) {
    return
  }
  const uniformName = 'outWestCloudOffset'
  const uv = '{STD_DIFFUSEDETAIL_TEXTURE_UV}'
  const diffuse = ShaderChunks.get(device, SHADERLANGUAGE_GLSL).get('diffusePS')
  if (!diffuse?.includes(uv)) {
    return
  }
  // Shift the cloud detail sample only. Other textures can share its texcoord set.
  const chunk = `uniform vec2 ${uniformName};\n${diffuse.replace(uv, `(${uv} + ${uniformName})`)}`
  const uniform = device.scope.resolve(uniformName)
  const offset = new Float32Array(2)
  uniform.setValue(offset)
  return {
    move(value: Vec2) {
      offset[0] = value.x
      // PlayCanvas map offsets use the opposite vertical direction from shader UVs.
      offset[1] = -value.y
      uniform.setValue(offset)
    },
    prepare(material: StandardMaterial) {
      material.shaderChunksVersion = '2.23'
      material.getShaderChunks(SHADERLANGUAGE_GLSL).set('diffusePS', chunk)
    },
  }
}

function signedWindExtent(min: number, max: number): number {
  const extent = Math.max(Math.abs(min), Math.abs(max))
  // Leave room for PlayCanvas's half-float delta texture rounding, including subnormals.
  return extent === 0 ? 0 : extent * (1 + 2 ** -10) + 2 ** -24
}

function fitSignedWindBounds(root: Entity, wind: AnimTrack): void {
  for (const curve of wind.curves) {
    const samples = wind.outputs[curve.output]
    if (
      curve.interpolation !== INTERPOLATION_LINEAR ||
      samples?.components !== 1 ||
      !samples.data.some((sample) => sample < 0) ||
      !samples.data.every((sample) => Math.abs(sample) <= 1)
    ) {
      continue
    }
    for (const path of curve.paths) {
      const property = path.propertyPath[0]
      if (path.component !== 'graph' || !property?.startsWith('weight.')) {
        continue
      }
      const entity = root.findByPath(path.entityPath) ?? root.findByPath(path.entityPath.slice(1))
      if (!(entity instanceof Entity && entity.name.startsWith('flora-'))) {
        continue
      }
      for (const instance of entity.render?.meshInstances ?? []) {
        fitSignedWindMesh(instance, property)
      }
    }
  }
}

function fitSignedWindMesh(instance: MeshInstance, property: string): void {
  const mesh = instance.mesh
  const morph = instance.morphInstance?.morph
  const target = morph?.targets[0]
  if (
    !(mesh && morph && target?.morphPositions) ||
    morph.targets.length !== 1 ||
    instance.skinInstance ||
    instance.instancingData ||
    Math.abs(target.defaultWeight) > 1 ||
    (property !== 'weight.0' && property !== `weight.name.${target.name}`)
  ) {
    return
  }
  const min = morph.aabb.getMin()
  const max = morph.aabb.getMax()
  const extent = new Vec3(
    signedWindExtent(min.x, max.x),
    signedWindExtent(min.y, max.y),
    signedWindExtent(min.z, max.z),
  )
  if (extent.lengthSq() > 0) {
    // The stock box includes the positive target only. Wind reaches both signs.
    const box = new BoundingBox()
    box.setMinMax(
      new Vec3().sub2(mesh.aabb.getMin(), extent),
      new Vec3().add2(mesh.aabb.getMax(), extent),
    )
    instance.setCustomAabb(box)
  }
}

export function animateWind(root: Entity, asset: Asset, frontier: boolean): void {
  const resource = asset.resource as ContainerResource
  const wind = resource.animations.find(
    (clip) => clip.name === 'Wind' || clip.resource?.name === 'Wind',
  )?.resource
  if (wind instanceof AnimTrack) {
    if (frontier && asset.name === ASSETS.frontier.url) {
      fitSignedWindBounds(root, wind)
    }
    root.addComponent('anim', { activate: true })
    root.anim?.loadStateGraph({
      layers: [
        {
          name: 'Environment',
          states: [{ name: 'START' }, { name: 'Wind', speed: 1, loop: true }],
          transitions: [{ from: 'START', to: 'Wind' }],
        },
      ],
      parameters: {},
    })
    root.anim?.baseLayer?.assignAnimation('Wind', wind)
  }
}
