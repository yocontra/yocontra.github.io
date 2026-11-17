import {
  AnimTrack,
  type Asset,
  type ContainerResource,
  type Entity,
  type GraphicsDevice,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  ShaderChunks,
  StandardMaterial,
  type Vec2,
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
