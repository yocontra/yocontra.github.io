import {
  AnimTrack,
  type Asset,
  type ContainerResource,
  type Entity,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  StandardMaterial,
} from 'playcanvas'

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

/** Shared freight UV1 stays local; native world coordinates follow instances and static batches. */
export function prepareFreightClouds(material: StandardMaterial, worldClouds: boolean): void {
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

export function animateWind(root: Entity, asset: Asset): void {
  const resource = asset.resource as ContainerResource
  const wind = resource.animations.find(
    (clip) => clip.name === 'Wind' || clip.resource?.name === 'Wind',
  )?.resource
  if (wind instanceof AnimTrack) {
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
