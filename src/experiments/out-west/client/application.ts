import {
  AnimComponentSystem,
  AppBase,
  AppOptions,
  Asset,
  AudioHandler,
  AudioListenerComponentSystem,
  BatchManager,
  CameraComponentSystem,
  Color,
  ContainerHandler,
  type ContainerResource,
  createGraphicsDevice,
  Entity,
  EnvLighting,
  FILLMODE_FILL_WINDOW,
  GAMMA_SRGB,
  LightComponentSystem,
  RESOLUTION_AUTO,
  RenderComponentSystem,
  SoundComponentSystem,
  SoundManager,
  type Texture,
  TextureHandler,
  TONEMAP_ACES,
} from 'playcanvas'
import { ENVIRONMENT } from '../content/manifest.ts'
import { assetUrl } from '../platform/asset-url.ts'
import { FrameBudget } from './frame-budget.ts'

export interface ApplicationOptions {
  canvas: HTMLCanvasElement
  /** The DOM viewport can be a hub panel or the full screen. */
  viewport: HTMLElement
  pixelRatio?: number
}

/** Owns every engine resource and listener created by one mounted game. */
export class GameApplication {
  readonly camera: Entity
  readonly stage: Entity
  readonly quality: FrameBudget
  private readonly controller = new AbortController()
  private readonly resizeObserver: ResizeObserver
  private readonly loads = new Map<string, Promise<Asset>>()
  private previousTime = 0
  private readonly environmentTextures: Texture[] = []
  readonly app: AppBase
  private readonly options: ApplicationOptions
  private constructor(app: AppBase, options: ApplicationOptions) {
    this.app = app
    this.camera = new Entity('camera', app)
    this.stage = new Entity('stage', app)
    this.options = options
    this.quality = new FrameBudget(options.pixelRatio ?? Math.min(devicePixelRatio, 1.5))
    app.scene.ambientLight = new Color(0.42, 0.37, 0.29)
    app.scene.exposure = 1.1
    app.root.addChild(this.stage)
    this.camera.addComponent('camera', {
      clearColor: new Color(0.58, 0.65, 0.69),
      fov: 58,
      nearClip: 0.1,
      farClip: 260,
    })
    app.root.addChild(this.camera)
    const sun = new Entity('sun', app)
    sun.addComponent('light', {
      type: 'directional',
      color: new Color(1, 0.87, 0.67),
      intensity: 2.3,
      castShadows: true,
      shadowDistance: 45,
      shadowResolution: 1024,
      shadowBias: 0.2,
      normalOffsetBias: 0.05,
    })
    sun.setEulerAngles(48, -35, 0)
    app.root.addChild(sun)
    app.setCanvasFillMode(FILLMODE_FILL_WINDOW)
    app.setCanvasResolution(RESOLUTION_AUTO)
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(options.viewport)
    document.addEventListener(
      'visibilitychange',
      () => {
        this.quality.reset()
        this.previousTime = 0
        if (document.hidden) {
          app.timeScale = 0
        } else {
          app.timeScale = 1
        }
      },
      { signal: this.controller.signal },
    )
    app.on('update', this.update)
    this.resize()
  }
  static async create(options: ApplicationOptions): Promise<GameApplication> {
    const graphicsDevice = await createGraphicsDevice(options.canvas, {
      deviceTypes: ['webgl2'],
      antialias: true,
      alpha: false,
    })
    let result: GameApplication | undefined
    try {
      const app = new AppBase(options.canvas)
      const setup = new AppOptions()
      setup.batchManager = BatchManager
      setup.graphicsDevice = graphicsDevice
      setup.soundManager = new SoundManager()
      setup.componentSystems = [
        RenderComponentSystem,
        CameraComponentSystem,
        LightComponentSystem,
        AnimComponentSystem,
        SoundComponentSystem,
        AudioListenerComponentSystem,
      ]
      setup.resourceHandlers = [ContainerHandler, TextureHandler, AudioHandler]
      app.init(setup)
      result = new GameApplication(app, options)
      if (result.camera.camera) {
        result.camera.camera.toneMapping = TONEMAP_ACES
        result.camera.camera.gammaCorrection = GAMMA_SRGB
      }
      app.start()
      await result.environment()
      return result
    } catch (error) {
      if (result) {
        result.destroy()
      } else {
        graphicsDevice.destroy()
      }
      throw error
    }
  }
  private readonly update = (): void => {
    const now = performance.now()
    const elapsed = this.previousTime > 0 ? (now - this.previousTime) / 1000 : 0
    this.previousTime = now
    if (!document.hidden && elapsed > 0 && this.quality.sample(elapsed)) {
      this.resize()
    }
  }
  private resize(): void {
    if (this.controller.signal.aborted) {
      return
    }
    const box = this.options.viewport.getBoundingClientRect()
    this.app.graphicsDevice.maxPixelRatio = this.quality.pixelRatio
    this.app.resizeCanvas(Math.max(1, Math.round(box.width)), Math.max(1, Math.round(box.height)))
  }
  /** A failed load is evicted so a retry can recover without rebuilding the application. */
  loadContainer(url: string): Promise<Asset> {
    return this.loadAsset(url, 'container')
  }
  loadAudio(url: string): Promise<Asset> {
    return this.loadAsset(url, 'audio')
  }
  private async environment(): Promise<void> {
    const asset = await this.loadAsset(ENVIRONMENT.url, 'texture')
    if (this.controller.signal.aborted) {
      return
    }
    const texture = asset.resource as Texture
    const lighting = EnvLighting.generateLightingSource(texture, { size: 128 })
    try {
      const atlas = EnvLighting.generateAtlas(lighting, {
        size: 256,
        numReflectionSamples: 64,
        numAmbientSamples: 128,
      })
      const sky = EnvLighting.generateSkyboxCubemap(texture, 256)
      this.environmentTextures.push(atlas, sky)
      this.app.scene.envAtlas = atlas
      this.app.scene.skybox = sky
      this.app.scene.skyboxIntensity = 0.7
    } finally {
      lighting.destroy()
    }
  }
  private loadAsset(url: string, type: 'container' | 'audio' | 'texture'): Promise<Asset> {
    if (this.controller.signal.aborted) {
      return Promise.reject(new Error('Game has been disposed'))
    }
    const previous = this.loads.get(url)
    if (previous) {
      return previous
    }
    const promise = new Promise<Asset>((resolve, reject) => {
      const asset = new Asset(url, type, { url: assetUrl(url) })
      if (type === 'container') {
        // Container HTTP requests outlive unload(). Native glTF hooks stop late parsing before
        // it can register textures or create GPU resources on a disposed application.
        asset.options = {
          global: {
            preprocess: () => {
              if (this.controller.signal.aborted) {
                throw new DOMException('Game was closed', 'AbortError')
              }
            },
          },
          image: {
            processAsync: (
              _image: unknown,
              complete: (error: Error | null, value: Asset | null) => void,
            ) => {
              // Supplying an unregistered native asset avoids starting image work after cancellation.
              // The global hook rejects the container; no placeholder resource reaches a renderer.
              complete(
                null,
                this.controller.signal.aborted ? new Asset('cancelled-image', 'texture') : null,
              )
            },
          },
        }
      }
      const abort = () => {
        this.app.assets.remove(asset)
        asset.unload()
        reject(new DOMException('Game has been disposed', 'AbortError'))
      }
      const finish = () => this.controller.signal.removeEventListener('abort', abort)
      asset.once('load', () => {
        finish()
        resolve(asset)
      })
      asset.once('error', (error: unknown) => {
        finish()
        this.app.assets.remove(asset)
        this.loads.delete(url)
        reject(new Error(`Could not load ${url}`, { cause: error }))
      })
      this.controller.signal.addEventListener('abort', abort, { once: true })
      this.app.assets.add(asset)
      this.app.assets.load(asset)
    })
    this.loads.set(url, promise)
    return promise
  }
  async instantiate(url: string, name: string): Promise<Entity> {
    const asset = await this.loadContainer(url)
    if (this.controller.signal.aborted) {
      throw new DOMException('Game has been disposed', 'AbortError')
    }
    const resource = asset.resource as ContainerResource | undefined
    if (!resource) {
      throw new Error(`Empty scene: ${url}`)
    }
    const entity = resource.instantiateRenderEntity({ castShadows: true, receiveShadows: true })
    entity.name = name
    this.stage.addChild(entity)
    return entity
  }
  destroy(): void {
    if (this.controller.signal.aborted) {
      return
    }
    this.controller.abort()
    this.resizeObserver.disconnect()
    this.app.off('update', this.update)
    this.app.scene.envAtlas = null
    this.app.scene.skybox = null
    for (const texture of this.environmentTextures) {
      texture.destroy()
    }
    this.environmentTextures.length = 0
    this.app.destroy()
    this.loads.clear()
  }
}
