import {
  AppBase,
  AppOptions,
  Entity,
  Mat4,
  Mesh,
  MeshInstance,
  PIXELFORMAT_RGBA8,
  SHADERLANGUAGE_GLSL,
  ShaderChunks,
  Skin,
  SkinInstance,
  StandardMaterial,
  Texture,
  WebglGraphicsDevice,
} from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { installRiderPalette } from '../../src/experiments/out-west/client/frontier-rider-palette.ts'
import { FrontierShadows } from '../../src/experiments/out-west/client/frontier-shadows.ts'

function require(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message)
  }
}

function verifyForeignDraw(
  read: (draw: MeshInstance) => { texture: Texture; base: number },
  differentOwner: MeshInstance,
  proxy: MeshInstance,
  uploads: ReadonlyMap<Texture, number>,
): void {
  const shared = read(proxy).texture
  const other = read(differentOwner)
  require(other.base === 0 &&
    other.texture ===
      differentOwner.skinInstance?.boneTexture, 'A different owner reused the packed row')
  require(uploads.get(other.texture) === 1, 'Unexpected stock owner did not upload the current rig')
  require(read(proxy).texture === shared, 'Stock fallback changed the eligible shadow binding')
}

interface Binding {
  texture: Texture
  base: number
}

interface StockTransition {
  camera: MeshInstance
  shadow: MeshInstance
  otherCameras: MeshInstance[]
  bone: Entity
  native: Texture
  crowd: (count: number, own: string) => void
  update: (...draws: MeshInstance[]) => void
  read: (draw: MeshInstance) => Binding
  uploads: Map<Texture, number>
  rows: ReadonlyMap<Texture, number>
  device: WebglGraphicsDevice
}

function verifyStockTransitions(probe: StockTransition): void {
  const { camera, shadow, otherCameras, bone, native, crowd, update, read, uploads, rows, device } =
    probe
  const repack = (x: number) => {
    crowd(32, 'self')
    bone.setLocalPosition(x, 0, 0)
    update(camera, ...otherCameras)
    require(read(camera).texture !== native, 'Test fixture failed to pack the current pose')
    uploads.clear()
  }
  const expectShadow = (x: number) => {
    const stock = read(shadow)
    require(stock.base === 0 &&
      stock.texture === native, 'Shadow-only draw did not restore the stock binding')
    read(shadow)
    require(uploads.get(native) === 1 &&
      rows.get(native) === x, 'Expected one current native row upload across stock shadow draws')
  }
  repack(21)
  update(...otherCameras)
  expectShadow(21)
  repack(22)
  crowd(15, 'self')
  update(...otherCameras)
  expectShadow(22)
  repack(23)
  crowd(32, 'a')
  update(...otherCameras)
  expectShadow(23)

  repack(24)
  crowd(15, 'self')
  bone.setLocalPosition(25, 0, 0)
  update(camera, ...otherCameras)
  expectShadow(25)

  repack(26)
  native.markForUpload()
  update(...otherCameras)
  const pending = read(shadow)
  read(shadow)
  require(pending.texture === native &&
    pending.base === 0 &&
    !uploads.has(native), 'The lazy restore duplicated a pending native upload')
  device.setTexture(native, 0)
  expectShadow(26)
}

async function cycleContext(canvas: HTMLCanvasElement, lost: () => void): Promise<void> {
  const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')
  require(extension, 'Chrome did not provide WEBGL_lose_context')
  const event = (type: 'webglcontextlost' | 'webglcontextrestored') =>
    new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.timeout(4000)
      canvas.addEventListener(type, () => resolve(), { once: true, signal })
      signal.addEventListener('abort', () => reject(new Error(`Timed out waiting for ${type}`)), {
        once: true,
      })
    })
  const loss = event('webglcontextlost')
  extension.loseContext()
  await loss
  await new Promise(requestAnimationFrame)
  lost()
  const restored = event('webglcontextrestored')
  extension.restoreContext()
  await restored
}

function verifyStoppedPalette(probe: StockTransition, app: AppBase): void {
  const { camera, shadow, otherCameras, bone, native, update, read, uploads, rows, device } = probe
  const dispose = installRiderPalette(
    app,
    () => true,
    (draw) => draw.node,
  )
  require(dispose, 'Unable to install a new palette on the restored device')
  try {
    bone.setLocalPosition(31, 0, 0)
    update(camera, ...otherCameras)
    require(read(camera).texture !== native, 'Test fixture failed to pack before disposer')
  } finally {
    uploads.clear()
    dispose()
  }
  const stock = read(shadow)
  require(stock.base === 0 &&
    stock.texture === native &&
    native._needsUpload &&
    !uploads.has(native), 'Disposal did not queue the latest native rows without uploading')
  device.setTexture(native, 0)
  require(uploads.get(native) === 1 &&
    rows.get(native) === 31, 'Stock draw after disposal did not get the latest packed pose')
}

function verifyFirstBindings(
  remoteDraws: MeshInstance[],
  proxy: MeshInstance,
  stockDraws: MeshInstance[],
  probe: StockTransition,
): void {
  const { read, uploads, device } = probe
  const shadow = read(proxy)
  const data = shadow.texture.getSource(0) as unknown as Float32Array
  const expected = [1, 3, 4]
  const bases = new Set<number>()
  for (const [index, draw] of remoteDraws.entries()) {
    const rig = draw.skinInstance
    require(rig, 'The probe is missing a native rig')
    const packed = read(draw)
    require(packed.texture === shadow.texture &&
      packed.texture !== rig.boneTexture, 'Remote/shadow draws did not share the atlas')
    require(!bases.has(packed.base) &&
      data[packed.base * 4 + 3] ===
        expected[index], 'The atlas did not retain exact armature rows and per-rig bases')
    require(!(
      uploads.has(rig.boneTexture) || Object.hasOwn(rig, 'uploadBones')
    ), 'A native upload or temporary hook escaped the packed update')
    bases.add(packed.base)
  }
  const first = remoteDraws[0]
  require(first &&
    read(first).base === shadow.base &&
    uploads.get(shadow.texture) === 1, 'The shadow proxy did not reuse the first remote palette')
  device.setTexture(shadow.texture, 0)
  require(uploads.get(shadow.texture) ===
    1, 'The atlas was uploaded a second time for a shadow draw')
  for (const draw of stockDraws) {
    const stock = read(draw)
    require(stock.base === 0 &&
      stock.texture === draw.skinInstance?.boneTexture &&
      uploads.get(stock.texture) === 1, 'An unsupported draw lost its native upload/binding')
  }
}

function observeUploads(
  device: WebglGraphicsDevice,
  uploads: Map<Texture, number>,
  rows: Map<Texture, number>,
): void {
  const setTexture = device.setTexture
  device.setTexture = function (texture, unit) {
    if (texture._needsUpload) {
      uploads.set(texture, (uploads.get(texture) ?? 0) + 1)
      const source: unknown = texture.getSource(0)
      if (source instanceof Float32Array && source[3] !== undefined) {
        rows.set(texture, source[3])
      }
    }
    setTexture.call(this, texture, unit)
  }
}

export async function probePalette() {
  const canvas = document.body.appendChild(document.createElement('canvas'))
  const device = new WebglGraphicsDevice(canvas, { antialias: false })
  const app = new AppBase(canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  app.init(options)
  const renderer = app.renderer
  const originalUpdate = renderer.gpuUpdate
  const originalSetSkinning = renderer.setSkinning
  const chunks = ShaderChunks.get(device, SHADERLANGUAGE_GLSL)
  const originalSource = chunks.get('skinVS')
  const controller = new FrontierShadows({ app } as GameApplication)
  require(renderer.gpuUpdate !== originalUpdate, 'Pinned WebGL hook was not installed')
  const scope = device.scope.resolve('owBoneStart')
  const material = new StandardMaterial()
  const mesh = new Mesh(device)
  mesh.setPositions([0, 0, 0, 1, 0, 0, 0, 1, 0])
  mesh.update()
  const skins = new Set<SkinInstance>()
  const draws = new Set<MeshInstance>()
  const bind = (id: string | null, x: number) => {
    const root = new Entity(id ?? 'unregistered', app)
    const bone = new Entity('rootBone', app)
    root.addChild(bone)
    bone.setLocalPosition(x, 0, 0)
    app.root.addChild(root)
    const skin = new SkinInstance(new Skin(device, [new Mat4()], [bone.name]))
    skin.bones = [bone]
    skins.add(skin)
    const draw = new MeshInstance(mesh, material, root)
    draws.add(draw)
    draw.skinInstance = skin
    if (id !== null) {
      controller.registerRider(root, id)
    }
    return { root, draw, skin, bone }
  }
  const a = bind('a', 1)
  const b = bind('b', 3)
  const c = bind('c', 4)
  const local = bind('self', 8)
  const unregistered = bind(null, 12)
  const incompatible = bind('different format', 13)
  const originalTexture = incompatible.skin.boneTexture
  incompatible.skin.boneTexture = new Texture(device, {
    format: PIXELFORMAT_RGBA8,
    width: 3,
    height: 1,
    mipmaps: false,
  })
  originalTexture.destroy()
  const proxy = new MeshInstance(mesh, material, a.root)
  draws.add(proxy)
  proxy.skinInstance = a.skin
  const update = (...current: MeshInstance[]) => {
    renderer.updateCpuSkinMatrices(current)
    renderer.gpuUpdate(new Set(current))
  }
  const read = (draw: MeshInstance) => {
    renderer.setSkinning(device, draw)
    return {
      texture: renderer.boneTextureId.getValue() as Texture,
      base: scope.getValue() as number,
    }
  }
  // Directional casters are submitted separately from the camera's GPU update list.
  const all = [a.draw, b.draw, c.draw, local.draw, unregistered.draw, incompatible.draw]
  const differentOwner = new MeshInstance(mesh, material, b.root)
  draws.add(differentOwner)
  differentOwner.skinInstance = a.skin
  const setTexture = device.setTexture
  const uploads = new Map<Texture, number>()
  const rows = new Map<Texture, number>()
  const transition = {
    camera: a.draw,
    shadow: proxy,
    otherCameras: [b.draw, c.draw],
    bone: a.bone,
    native: a.skin.boneTexture,
    crowd: (count: number, own: string) => controller.crowd(count, own),
    update,
    read,
    uploads,
    rows,
    device,
  }
  observeUploads(device, uploads, rows)
  try {
    // Drain constructor uploads and establish ordinary texture state first.
    for (const rig of skins) {
      device.setTexture(rig.boneTexture, 0)
    }
    uploads.clear()
    controller.crowd(32, 'self')
    update(...all)
    verifyFirstBindings(
      [a.draw, b.draw, c.draw],
      proxy,
      [local.draw, unregistered.draw, incompatible.draw],
      transition,
    )
    verifyForeignDraw(read, differentOwner, proxy, uploads)
    verifyStockTransitions(transition)
    controller.setRiderRagdoll(a.root, true)
    controller.crowd(32, 'b')
    const replacement = bind('replacement', 15)
    c.root.remove()
    update(...all, replacement.draw)
    require(read(a.draw).texture === a.skin.boneTexture &&
      read(proxy).texture ===
        a.skin.boneTexture, 'Ragdoll and related proxy did not return to stock')
    require(read(b.draw).texture ===
      b.skin.boneTexture, 'The current local rider still used the atlas')
    require(read(c.draw).texture === c.skin.boneTexture, 'A removed rider still used the atlas')
    require(read(local.draw).texture ===
      read(replacement.draw).texture, 'Remote and replacement ownership did not update')
    controller.setRiderRagdoll(a.root, false)
    update(...all, replacement.draw)
    require(read(a.draw).texture ===
      read(replacement.draw).texture, 'Released ragdoll did not return to eligible scope')
    controller.crowd(15, 'self')
    update(...all)
    require(read(a.draw).texture === a.skin.boneTexture &&
      read(a.draw).base === 0, 'Sparse crowd kept a packed binding')
    controller.crowd(32, 'self')
    update(...all, replacement.draw)
    const restored = read(a.draw).texture
    require(restored !== a.skin.boneTexture, 'Crowd resume did not reactivate the shared texture')
    await cycleContext(canvas, () => {
      require(renderer.gpuUpdate === originalUpdate &&
        renderer.setSkinning === originalSetSkinning, 'Device loss left the renderer hooked')
      require(chunks.get('skinVS') === originalSource &&
        scope.getValue() === 0 &&
        !device.textures.has(
          restored,
        ), 'Device loss did not clear the owned atlas and shader state')
    })
    const restoredStock = read(proxy)
    require(restoredStock.texture === a.skin.boneTexture &&
      restoredStock.base === 0 &&
      restoredStock.texture._needsUpload, 'Context restore did not queue the stock texture')
    device.setTexture(restoredStock.texture, 0)
    require(rows.get(restoredStock.texture) ===
      26, 'Restored context did not retain the current native pose')
    verifyStoppedPalette(transition, app)
    return { sharedRigs: 3, shadowTransitions: true, contextFallback: true, disposedFallback: true }
  } finally {
    device.setTexture = setTexture
    controller.destroy()
    for (const draw of draws) {
      draw.skinInstance = null
      draw.destroy()
    }
    for (const skin of skins) {
      skin.destroy()
    }
    material.destroy()
    c.root.destroy()
    app.destroy()
    canvas.remove()
  }
}
