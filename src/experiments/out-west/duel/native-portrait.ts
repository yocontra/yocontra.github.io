import {
  ASPECT_MANUAL,
  Color,
  Entity,
  FILTER_LINEAR,
  Layer,
  PIXELFORMAT_RGBA8,
  type RenderComponent,
  RenderTarget,
  Texture,
  Vec3,
} from 'playcanvas'
import type { GameApplication } from '../client/application.ts'
import type { DuelActor } from './native-actor.ts'

/** The print, in pixels: the poster's mugshot frame (340 × 286) at ~1.13×. */
const PW = 384
const PH = 324
const ASPECT = PW / PH
/** How far the lens stands off: long enough to keep the face from bulging. */
const DIST = 2.4

/**
 * Mugshots for the wanted posters: the outlaw's own loaded model, rendered once from a
 * three-quarter camera on a private layer with its own studio lights, onto bare (transparent)
 * paper. The poster engraves it. Framed head and shoulders from his head bone, hat and all.
 */
export class NativePortraits {
  private readonly game: GameApplication
  private readonly cache = new Map<number, HTMLCanvasElement>()
  private busy = false as boolean

  constructor(game: GameApplication) {
    this.game = game
  }

  /** Render (or fetch) `index`'s print from `actor`; null while he isn't on stage. */
  async print(index: number, actor: DuelActor | null): Promise<HTMLCanvasElement | null> {
    const have = this.cache.get(index)
    if (have) {
      return have
    }
    if (!actor?.root.enabled || this.busy || !actor.root.parent?.enabled) {
      return null
    }
    this.busy = true
    try {
      const print = await this.shoot(actor)
      if (print) {
        this.cache.set(index, print)
      }
      return print
    } finally {
      this.busy = false
    }
  }

  private async shoot(actor: DuelActor): Promise<HTMLCanvasElement | null> {
    const app = this.game.app
    const layer = new Layer({ name: 'duel-portrait' })
    app.scene.layers.push(layer)
    const texture = new Texture(app.graphicsDevice, {
      name: 'duel-portrait',
      width: PW,
      height: PH,
      format: PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: FILTER_LINEAR,
      magFilter: FILTER_LINEAR,
    })
    const target = new RenderTarget({ colorBuffer: texture, depth: true })
    const rig = new Entity('duel-portrait-rig', app)
    const camera = new Entity('duel-portrait-camera', app)
    camera.addComponent('camera', {
      layers: [layer.id],
      renderTarget: target,
      clearColor: new Color(0, 0, 0, 0),
      aspectRatioMode: ASPECT_MANUAL,
      aspectRatio: ASPECT,
      nearClip: 0.05,
      farClip: 20,
      priority: -10,
    })
    const key = new Entity('duel-portrait-key', app)
    key.addComponent('light', {
      type: 'directional',
      layers: [layer.id],
      intensity: 2.6,
      castShadows: false,
    })
    const rim = new Entity('duel-portrait-rim', app)
    rim.addComponent('light', {
      type: 'directional',
      layers: [layer.id],
      intensity: 1.1,
      castShadows: false,
    })
    rig.addChild(camera)
    rig.addChild(key)
    rig.addChild(rim)
    app.root.addChild(rig)

    const renders = actor.root.findComponents('render') as RenderComponent[]
    // copies: the setter refills the component's own array in place
    const saved = renders.map((r) => [...r.layers])
    for (const r of renders) {
      r.layers = [layer.id]
    }
    try {
      frame(actor, renders, { camera, key, rim })
      await new Promise<void>((resolve) => app.once('frameend', () => resolve()))
    } finally {
      renders.forEach((r, i) => {
        r.layers = saved[i] ?? r.layers
      })
    }
    try {
      const px = (await texture.read(0, 0, PW, PH, {
        renderTarget: target,
        immediate: true,
      })) as Uint8Array
      return toCanvas(px)
    } catch {
      return null
    } finally {
      rig.destroy()
      app.scene.layers.remove(layer)
      target.destroy()
      texture.destroy()
    }
  }
}

/** Aim the lens so he sits head and shoulders in the print, hat and all. */
function frame(
  actor: DuelActor,
  renders: RenderComponent[],
  { camera, key, rim }: { camera: Entity; key: Entity; rim: Entity },
): void {
  const node = actor.model.findByName('Head')
  const head = node ? node.getPosition().clone() : actor.root.getPosition().clone()
  if (!node) {
    head.y += 1.6
  }
  let crown = head.y + 0.22
  for (const r of renders) {
    for (const mi of r.meshInstances) {
      const box = mi.aabb
      // hats and heads only: the top of whatever sits within a hand of his skull
      if (Math.hypot(box.center.x - head.x, box.center.z - head.z) < 0.35) {
        crown = Math.max(crown, Math.min(head.y + 0.5, box.getMax().y))
      }
    }
  }
  const top = crown + 0.035
  const bottom = head.y - 0.36
  const half = Math.max((top - bottom) / 2, 0.28 / ASPECT)
  const centre = new Vec3(head.x, top - half, head.z)
  // his facing: the model's +Z, flattened
  const fwd = actor.root.forward.clone().mulScalar(-1)
  fwd.y = 0
  fwd.normalize()
  // a three-quarter view: the lens swung ~0.5 rad off his nose
  const side = new Vec3(-fwd.z, 0, fwd.x)
  const dir = fwd
    .clone()
    .mulScalar(Math.cos(0.5))
    .add(side.clone().mulScalar(Math.sin(0.5)))
  camera.setPosition(
    centre
      .clone()
      .add(dir.mulScalar(DIST))
      .add(new Vec3(0, 0.05, 0)),
  )
  camera.lookAt(centre)
  if (camera.camera) {
    camera.camera.fov = (2 * Math.atan(half / DIST) * 180) / Math.PI
  }
  // the key from above his near shoulder, the rim from behind the far one
  shine(
    key,
    side
      .clone()
      .mulScalar(1.2)
      .sub(fwd.clone().mulScalar(1.4))
      .add(new Vec3(0, -1.6, 0)),
  )
  shine(
    rim,
    side
      .clone()
      .mulScalar(-1.5)
      .add(fwd.clone().mulScalar(1.2))
      .add(new Vec3(0, -0.8, 0)),
  )
}

/** Point a directional light (which shines down its local -Y) along `dir`. */
function shine(light: Entity, dir: Vec3): void {
  light.setPosition(0, 0, 0)
  light.lookAt(dir)
  light.rotateLocal(90, 0, 0)
}

/** The read-back (bottom-up rows) flipped onto a canvas. */
function toCanvas(px: Uint8Array): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = PW
  canvas.height = PH
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return canvas
  }
  const img = ctx.createImageData(PW, PH)
  const row = PW * 4
  for (let y = 0; y < PH; y++) {
    img.data.set(px.subarray((PH - 1 - y) * row, (PH - y) * row), y * row)
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}
