import {
  type AppBase,
  FILTER_NEAREST,
  type GraphNode,
  type MeshInstance,
  PIXELFORMAT_RGBA32F,
  SHADERLANGUAGE_GLSL,
  ShaderChunks,
  SkinInstance,
  StandardMaterial,
  TEXTURELOCK_READ,
  Texture,
  version,
  WebglGraphicsDevice,
} from 'playcanvas'

// A matrix uses three adjacent RGBA texels, so neither a row nor a rig may split one.
const ATLAS_WIDTH = 192
const MATRIX_FLOATS = 12
const BONE_BASE = 'owBoneStart'
const SAMPLER = 'uniform highp sampler2D texture_poseMap;'
const INDEX = 'ivec4(indicesFloat + 0.5) * 3'

function nativePalette(rig: SkinInstance, device: WebglGraphicsDevice): boolean {
  const { boneTexture, matrixPalette } = rig
  return (
    boneTexture instanceof Texture &&
    boneTexture.device === device &&
    boneTexture.format === PIXELFORMAT_RGBA32F &&
    boneTexture.width % 3 === 0 &&
    !boneTexture.cubemap &&
    !boneTexture.array &&
    !boneTexture.volume &&
    !boneTexture.mipmaps &&
    matrixPalette instanceof Float32Array &&
    matrixPalette.length > 0 &&
    matrixPalette.length % MATRIX_FLOATS === 0 &&
    matrixPalette.length === boneTexture.width * boneTexture.height * 4 &&
    (boneTexture.getSource(0) as unknown) === matrixPalette &&
    rig.bones.length * MATRIX_FLOATS <= matrixPalette.length &&
    rig.uploadBones === SkinInstance.prototype.uploadBones &&
    !Object.hasOwn(rig, 'uploadBones') &&
    Object.isExtensible(rig)
  )
}

function standardSkin(draw: MeshInstance): boolean {
  const { material } = draw
  return (
    material instanceof StandardMaterial &&
    !material.shaderChunks.glsl.has('skinVS') &&
    !draw.morphInstance
  )
}

/** A packed rig can leave the camera cull set while still casting a shadow. */
class StockPoseUploads {
  private readonly stale = new WeakSet<Texture>()
  private readonly refreshing = new Set<Texture>()

  skip(texture: Texture): void {
    this.stale.add(texture)
  }

  expectNative(rig: SkinInstance | null): void {
    const texture = rig?.boneTexture
    if (rig?._dirty && texture && this.stale.has(texture)) {
      this.refreshing.add(texture)
    }
  }

  finishNative(): void {
    for (const texture of this.refreshing) {
      this.stale.delete(texture)
    }
  }

  clearNative(): void {
    this.refreshing.clear()
  }

  restore(rig: SkinInstance, device: WebglGraphicsDevice): void {
    const texture = rig.boneTexture
    if (texture && this.stale.has(texture)) {
      if (!texture._needsUpload) {
        rig.uploadBones(device)
      }
      this.stale.delete(texture)
    }
  }

  dispose(device: WebglGraphicsDevice): void {
    this.clearNative()
    // Queue existing stock rows before taking the hooks away. This never uploads on quit.
    for (const texture of device.textures) {
      if (this.stale.delete(texture) && !texture._needsUpload) {
        texture.markForUpload()
      }
    }
  }
}

interface Atlas {
  texture: Texture
  data: Float32Array
}

function createAtlas(device: WebglGraphicsDevice, height: number): Atlas {
  const texture = new Texture(device, {
    name: 'Frontier remote rider poses',
    width: ATLAS_WIDTH,
    height,
    format: PIXELFORMAT_RGBA32F,
    mipmaps: false,
    minFilter: FILTER_NEAREST,
    magFilter: FILTER_NEAREST,
  })
  try {
    // Setting levels in the constructor would immediately upload the empty atlas.
    const data = texture.lock({ mode: TEXTURELOCK_READ })
    texture.unlock()
    if (!(data instanceof Float32Array) || data.length !== ATLAS_WIDTH * height * 4) {
      throw new Error('Unexpected WebGL palette backing store')
    }
    return { texture, data }
  } catch (error) {
    texture.destroy()
    throw error
  }
}

/** Keep the native matrices and draw path. Replace only the texture upload and pose address. */
export function installRiderPalette(
  app: AppBase,
  crowded: () => boolean,
  remoteOwner: (draw: MeshInstance) => GraphNode | undefined,
): (() => void) | undefined {
  const device = app.graphicsDevice
  if (
    !(device instanceof WebglGraphicsDevice) ||
    String(version) !== '2.23.3' ||
    device.contextLost ||
    device.maxTextureSize < ATLAS_WIDTH
  ) {
    return undefined
  }
  const chunks = ShaderChunks.get(device, SHADERLANGUAGE_GLSL)
  const nativeSource = chunks.get('skinVS')
  if (
    nativeSource?.split(SAMPLER).length !== 2 ||
    nativeSource.split(INDEX).length !== 2 ||
    nativeSource.includes(BONE_BASE)
  ) {
    return undefined
  }
  const packedSource = nativeSource
    .replace(SAMPLER, `${SAMPLER}\nuniform int ${BONE_BASE};`)
    .replace(INDEX, `${INDEX} + ivec4(${BONE_BASE})`)
  const renderer = app.renderer
  const nativeUpdate = renderer.gpuUpdate
  const nativeSkinning = renderer.setSkinning
  const base = device.scope.resolve(BONE_BASE)
  let atlas: Atlas | undefined
  let disabled = false
  const offsets = new Map<SkinInstance, number>()
  const owners = new Map<SkinInstance, GraphNode>()
  const participating = new Set<MeshInstance>()
  const stock = new Set<SkinInstance>()
  const suppressed = new Set<SkinInstance>()
  const stockUploads = new StockPoseUploads()
  const skipUpload = function (this: SkinInstance): void {
    stockUploads.skip(this.boneTexture)
  }
  const restoreUploads = () => {
    for (const rig of suppressed) {
      Reflect.deleteProperty(rig, 'uploadBones')
    }
    suppressed.clear()
  }

  const clearFrame = () => {
    offsets.clear()
    owners.clear()
    participating.clear()
    stock.clear()
  }
  const chooseRigs = (draws: MeshInstance[] | Set<MeshInstance>): number => {
    for (const draw of draws) {
      const rig = draw.skinInstance
      if (!rig || stock.has(rig)) {
        continue
      }
      const owner = remoteOwner(draw)
      const preparedOwner = owners.get(rig)
      if (
        !(owner && standardSkin(draw)) ||
        (preparedOwner ? preparedOwner !== owner : !nativePalette(rig, device))
      ) {
        // Preserve the native texture for every draw if a rig crosses the boundary.
        offsets.delete(rig)
        owners.delete(rig)
        stock.add(rig)
        continue
      }
      if (!preparedOwner) {
        owners.set(rig, owner)
        offsets.set(rig, 0)
      }
      participating.add(draw)
    }
    let length = 0
    for (const rig of offsets.keys()) {
      offsets.set(rig, length)
      length += rig.matrixPalette.length
    }
    return length
  }
  const sizeAtlas = (floats: number): Atlas | undefined => {
    const height = Math.ceil(floats / (ATLAS_WIDTH * 4))
    if (height > device.maxTextureSize) {
      return undefined
    }
    if (atlas && height <= atlas.texture.height) {
      return atlas
    }
    try {
      const next = createAtlas(device, height)
      atlas?.texture.destroy()
      atlas = next
      return next
    } catch {
      disabled = true
      return undefined
    }
  }

  function updateNative(draws: MeshInstance[] | Set<MeshInstance>): void {
    try {
      for (const rig of offsets.keys()) {
        rig.uploadBones = skipUpload
        suppressed.add(rig)
      }
      nativeUpdate.call(renderer, draws)
      stockUploads.finishNative()
    } finally {
      stockUploads.clearNative()
      restoreUploads()
    }
  }

  function update(draws: MeshInstance[] | Set<MeshInstance>): void {
    clearFrame()
    const floats = !(disabled || device.contextLost) && crowded() ? chooseRigs(draws) : 0
    const frame = offsets.size >= 2 ? sizeAtlas(floats) : undefined
    if (frame) {
      for (const rig of stock) {
        stockUploads.expectNative(rig)
      }
    } else {
      clearFrame()
      for (const draw of draws) {
        stockUploads.expectNative(draw.skinInstance)
      }
    }
    updateNative(draws)
    if (frame && !disabled) {
      for (const [rig, offset] of offsets) {
        frame.data.set(rig.matrixPalette, offset)
      }
      frame.texture.upload()
    }
  }

  const matchesPreparedOwner = (draw: MeshInstance, rig: SkinInstance): boolean => {
    const owner = owners.get(rig)
    return (
      participating.has(draw) ||
      (owner !== undefined && standardSkin(draw) && remoteOwner(draw) === owner)
    )
  }

  const skin: typeof nativeSkinning = (graphics, draw) => {
    nativeSkinning.call(renderer, graphics, draw)
    const rig = draw.skinInstance
    if (!rig) {
      return
    }
    const offset = offsets.get(rig)
    // Native shadow casters are submitted separately from the camera's GPU update list.
    if (atlas && offset !== undefined && matchesPreparedOwner(draw, rig)) {
      base.setValue(offset / 4)
      renderer.boneTextureId.setValue(atlas.texture)
    } else {
      base.setValue(0)
      stockUploads.restore(rig, device)
    }
  }

  const dispose = () => {
    disabled = true
    restoreUploads()
    clearFrame()
    stockUploads.dispose(device)
    app.off('destroy', dispose)
    device.off('devicelost', dispose)
    if (renderer.gpuUpdate === update) {
      renderer.gpuUpdate = nativeUpdate
    }
    if (renderer.setSkinning === skin) {
      renderer.setSkinning = nativeSkinning
    }
    base.setValue(0)
    if (chunks.get('skinVS') === packedSource) {
      chunks.set('skinVS', nativeSource)
    }
    if (atlas && renderer.boneTextureId.getValue() === atlas.texture) {
      renderer.boneTextureId.setValue(null)
    }
    atlas?.texture.destroy()
    atlas = undefined
  }
  chunks.set('skinVS', packedSource)
  base.setValue(0)
  renderer.gpuUpdate = update
  renderer.setSkinning = skin
  device.once('devicelost', dispose)
  app.once('destroy', dispose)
  return dispose
}
