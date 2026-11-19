import { readFile } from 'node:fs/promises'
import {
  AnimComponentSystem,
  AppBase,
  AppOptions,
  Asset,
  ContainerHandler,
  Entity,
  NullGraphicsDevice,
  PIXELFORMAT_RGBA8,
  RenderComponentSystem,
  Texture,
} from 'playcanvas'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'

const fromPublic = (url: string) => readFile(`public${url.split('?')[0]}`)

export function nativeActorFixture(readModel: (url: string) => Promise<Uint8Array> = fromPublic) {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.componentSystems = [RenderComponentSystem, AnimComponentSystem]
  options.resourceHandlers = [ContainerHandler]
  app.init(options)
  const stage = new Entity('stage', app)
  app.root.addChild(stage)
  const assets = new Map<string, Promise<Asset>>()
  const textures = new Map<string, Texture>()
  const requests: string[] = []
  const load = async (url: string) => {
    const contents = await readModel(url)
    const asset = new Asset(url, 'container', {
      url,
      contents: new Uint8Array(contents).buffer,
    })
    app.assets.add(asset)
    await new Promise<void>((resolve, reject) => {
      asset.once('load', () => resolve())
      asset.once('error', reject)
      app.assets.load(asset)
    })
    return asset
  }
  const game = {
    app,
    stage,
    loadContainer(url: string) {
      requests.push(url)
      let pending = assets.get(url)
      if (!pending) {
        pending = load(url)
        assets.set(url, pending)
      }
      return pending
    },
    loadTexture(url: string) {
      let texture = textures.get(url)
      if (!texture) {
        texture = new Texture(device, { width: 1, height: 1, format: PIXELFORMAT_RGBA8 })
        textures.set(url, texture)
      }
      const asset = new Asset(url, 'texture')
      asset.resource = texture
      return Promise.resolve(asset)
    },
    releaseTexture(url: string) {
      textures.get(url)?.destroy()
      textures.delete(url)
    },
  } as unknown as GameApplication
  return {
    game,
    app,
    stage,
    requests,
    assets,
    textures,
    async destroy() {
      stage.destroy()
      const loaded = await Promise.all(assets.values())
      for (const asset of loaded) {
        asset.unload()
        app.assets.remove(asset)
      }
      for (const texture of textures.values()) {
        texture.destroy()
      }
      app.destroy()
      return { textures: device.textures.size, buffers: device.buffers.size }
    },
  }
}
