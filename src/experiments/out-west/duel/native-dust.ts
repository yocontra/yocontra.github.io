import {
  BLEND_NORMAL,
  Curve,
  CurveSet,
  EMITTERSHAPE_BOX,
  Entity,
  type Texture,
  Vec3,
} from 'playcanvas'
import type { GameApplication } from '../client/application.ts'
import { AMBIENT_ASSETS } from '../content/ambient.ts'

export interface DustOpts {
  /** Outward speed, m/s. */
  speed?: number
  /** Starting particle size, m. */
  size?: number
  /** Seconds each grain lives. */
  life?: number
  /** Peak opacity. */
  alpha?: number
  /** Extra upward speed, m/s. */
  up?: number
  /** A drift every grain shares (blown along the shot), m/s. */
  dir?: Vec3
  /** Linear tint, 0..1 per channel (street dust by default). */
  tint?: [number, number, number]
}

interface Burst {
  entity: Entity
  age: number
  life: number
}

const POOL = 8

/** Pooled native particle bursts of street dust: paces, near misses and falling bodies. */
export class NativeDust {
  private readonly bursts: Burst[] = []
  private texture: Texture | undefined
  private readonly game: GameApplication
  private closed = false as boolean
  readonly ready: Promise<void>
  constructor(game: GameApplication) {
    this.game = game
    this.ready = game
      .loadTexture(AMBIENT_ASSETS.dust.url, { srgb: true, flipY: false })
      .then((asset) => {
        this.texture = asset.resource as Texture
      })
  }
  emit(at: Vec3, count: number, o: DustOpts = {}): void {
    const texture = this.texture
    if (this.closed || !texture) {
      return
    }
    let burst = this.bursts.find((entry) => entry.age >= entry.life)
    if (!burst) {
      if (this.bursts.length >= POOL) {
        return
      }
      const entity = new Entity('duel-dust', this.game.app)
      this.game.stage.addChild(entity)
      burst = { entity, age: 0, life: 0 }
      this.bursts.push(burst)
    }
    const speed = o.speed ?? 0.7
    const up = o.up ?? 0.3
    const size = o.size ?? 0.12
    const life = o.life ?? 1
    const alpha = o.alpha ?? 0.4
    const dx = o.dir?.x ?? 0
    const dy = o.dir?.y ?? 0
    const dz = o.dir?.z ?? 0
    const [r, g, b] = o.tint ?? [0.78, 0.66, 0.5]
    const entity = burst.entity
    entity.removeComponent('particlesystem')
    entity.setPosition(at)
    entity.addComponent('particlesystem', {
      numParticles: Math.max(1, Math.min(48, count)),
      lifetime: life,
      rate: 0.001,
      rate2: 0.004,
      loop: false,
      autoPlay: true,
      colorMap: texture,
      blendType: BLEND_NORMAL,
      lighting: false,
      depthWrite: false,
      emitterShape: EMITTERSHAPE_BOX,
      emitterExtents: new Vec3(0.15, 0.02, 0.15),
      velocityGraph: new CurveSet(
        [0, dx - speed, 1, (dx - speed) * 0.2],
        [0, dy + up, 1, (dy + up) * 0.3],
        [0, dz - speed, 1, (dz - speed) * 0.2],
      ),
      velocityGraph2: new CurveSet(
        [0, dx + speed, 1, (dx + speed) * 0.2],
        [0, dy + up * 1.6, 1, (dy + up) * 0.5],
        [0, dz + speed, 1, (dz + speed) * 0.2],
      ),
      colorGraph: new CurveSet([0, r, 1, r * 0.95], [0, g, 1, g * 0.94], [0, b, 1, b * 0.96]),
      alphaGraph: new Curve([0, 0, 0.12, alpha, 1, 0]),
      scaleGraph: new Curve([0, size, 1, size * 3.2]),
    })
    burst.age = 0
    burst.life = life + 0.1
  }
  update(dt: number): void {
    for (const burst of this.bursts) {
      if (burst.age < burst.life) {
        burst.age += dt
        if (burst.age >= burst.life) {
          burst.entity.removeComponent('particlesystem')
        }
      }
    }
  }
  destroy(): void {
    this.closed = true
    for (const burst of this.bursts) {
      burst.entity.destroy()
    }
    this.bursts.length = 0
  }
}
