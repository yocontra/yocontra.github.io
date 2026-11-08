import {
  AnimComponentSystem,
  AppBase,
  AppOptions,
  Asset,
  AudioHandler,
  AudioListenerComponentSystem,
  BatchManager,
  basisInitialize,
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
  ParticleSystemComponentSystem,
  RESOLUTION_AUTO,
  RenderComponentSystem,
  SoundComponentSystem,
  SoundManager,
  type Texture,
  TextureHandler,
  TONEMAP_ACES,
} from 'playcanvas'
import { SKIES } from '../content/skies.ts'
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
  private environmentEpoch = 0
  private environmentSource = '' as string
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
    initializeBasis()
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
        ParticleSystemComponentSystem,
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
  loadTexture(url: string, options?: { srgb?: boolean; flipY?: boolean }): Promise<Asset> {
    return this.loadAsset(url, 'texture', options)
  }
  releaseTexture(url: string): void {
    this.releaseAsset(url)
  }
  /** Call after the last entity using this arena has been destroyed. */
  releaseContainer(url: string): void {
    this.releaseAsset(url)
  }
  private releaseAsset(url: string): void {
    const pending = this.loads.get(url)
    if (!pending) {
      return
    }
    this.loads.delete(url)
    void this.unloadReleasedAsset(url, pending)
  }
  private async unloadReleasedAsset(url: string, pending: Promise<Asset>): Promise<void> {
    try {
      const asset = await pending
      const replacement = this.loads.get(url)
      let next: Asset | null = null
      if (replacement) {
        try {
          next = await replacement
        } catch {
          // A failed replacement cannot retain the old texture.
        }
      }
      if (this.controller.signal.aborted) {
        return
      }
      this.app.assets.remove(asset)
      // The loader may coalesce an immediate re-acquisition onto the same Texture.
      if (next?.resource !== asset.resource) {
        asset.unload()
      }
    } catch {
      // Failed or cancelled loads have no resource to release.
    }
  }
  async environment(
    url: string = SKIES.noon.url,
    intensity = 0.7,
    skyboxSize = 256,
  ): Promise<void> {
    const epoch = ++this.environmentEpoch
    this.environmentSource = url
    const asset = await this.loadTexture(url)
    if (this.controller.signal.aborted || epoch !== this.environmentEpoch) {
      if (url !== this.environmentSource) {
        this.releaseTexture(url)
      }
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
      const sky = EnvLighting.generateSkyboxCubemap(texture, skyboxSize)
      const previous = this.environmentTextures.splice(0)
      this.environmentTextures.push(atlas, sky)
      this.app.scene.envAtlas = atlas
      this.app.scene.skybox = sky
      this.app.scene.skyboxIntensity = intensity
      for (const old of previous) {
        old.destroy()
      }
    } finally {
      lighting.destroy()
      // Convolution owns its native outputs; retain no full-resolution source HDR on the GPU.
      this.releaseTexture(url)
    }
  }
  private loadAsset(
    url: string,
    type: 'container' | 'audio' | 'texture',
    textureOptions?: { srgb?: boolean; flipY?: boolean },
  ): Promise<Asset> {
    if (this.controller.signal.aborted) {
      return Promise.reject(new Error('Game has been disposed'))
    }
    const previous = this.loads.get(url)
    if (previous) {
      return previous
    }
    const promise = new Promise<Asset>((resolve, reject) => {
      const asset = new Asset(url, type, { url: assetUrl(url) }, textureOptions)
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

let basisConfigured = false
function initializeBasis(): void {
  if (basisConfigured) {
    return
  }
  const prefix = '/experiments/out-west/vendor/basis/2.23.3'
  basisInitialize({
    glueUrl: `${prefix}/basis.wasm.js`,
    wasmUrl: `${prefix}/basis.wasm.wasm`,
    fallbackUrl: `${prefix}/basis.js`,
    numWorkers: 2,
    lazyInit: true,
  })
  basisConfigured = true
}
