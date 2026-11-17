/** Leased authored timber/curved-iron fragments; native boxes are collision proxies only. */
import {
  BODYGROUP_STATIC,
  BODYGROUP_USER_2,
  BoundingBox,
  type ContainerResource,
  Entity,
  Mat4,
  type Material,
  Quat,
  Vec3,
} from 'playcanvas'
import { ENVIRONMENT_PROPS } from '../content/environment-props.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import type { Simulation } from '../runtime/world.ts'
import type { GameApplication } from './application.ts'
import type { NativeRagdolls } from './ragdolls.ts'

const MAX_PIECES = 24
const LIFE_SECONDS = 3
export const BARREL_PIECES = [
  'stave-0',
  'stave-1',
  'stave-2',
  'stave-3',
  'hoop-0',
  'hoop-1',
] as const
type Break = Extract<SimEvent, { type: 'prop_break' }>
interface Piece {
  body: Entity
  visual: Entity
  offset: Mat4
  age: number
}
export class BarrelDebris {
  readonly ready: Promise<void>
  private readonly game: GameApplication
  private readonly physics: Simulation
  private readonly url: string
  private readonly pieces: Piece[] = []
  private readonly pending: { event: Break; material: Material; at: number }[] = []
  private templates: Entity | undefined
  private readonly matrix = new Mat4()
  private readonly rotation = new Quat()
  private readonly position = new Vec3()
  private acquired = false as boolean
  private closed = false as boolean
  constructor(game: GameApplication, ragdolls: NativeRagdolls, url: string) {
    this.game = game
    this.url = url
    this.physics = ragdolls.share(() => this.pieces.length > 0)
    this.ready = game
      .loadContainer(url)
      .then((asset) => {
        this.acquired = true
        if (this.closed) {
          this.release()
          return
        }
        this.templates = (asset.resource as ContainerResource).instantiateRenderEntity()
        this.templates.enabled = false
        for (let prop = 0; prop < ENVIRONMENT_PROPS.length; prop++) {
          for (const piece of BARREL_PIECES) {
            const node = this.templates.findByName(`barrel-debris:${prop}:${piece}`)
            if (!(node instanceof Entity && node.findComponents('render').length > 0)) {
              throw new Error('Incomplete authored barrel fragments')
            }
          }
        }
        for (const queued of this.pending.splice(0)) {
          if (performance.now() - queued.at < LIFE_SECONDS * 1000) {
            this.burst(queued.event, queued.material)
          }
        }
      })
      .catch((error: unknown) => {
        this.templates?.destroy()
        this.templates = undefined
        this.release()
        throw error
      })
    // The owner awaits readiness; an earlier close must not leave a temporarily unhandled rejection.
    void this.ready.catch(() => undefined)
    game.app.on('update', this.update)
  }
  sync(health: Uint8Array): void {
    this.physics.updateProps(health)
  }
  event(event: Break, material: Material): void {
    if (this.closed) {
      return
    }
    if (this.templates) {
      this.burst(event, material)
    } else if (this.pending.length < ENVIRONMENT_PROPS.length) {
      this.pending.push({ event, material, at: performance.now() })
    }
  }
  private burst(event: Break, material: Material): void {
    for (const name of BARREL_PIECES) {
      if (this.pieces.length >= MAX_PIECES) {
        break
      }
      const template = this.templates?.findByName(`barrel-debris:${event.prop}:${name}`)
      if (!(template instanceof Entity)) {
        continue
      }
      const visual = template.clone()
      const bounds = new BoundingBox()
      let found = false
      for (const render of visual.findComponents('render')) {
        for (const mi of render.meshInstances) {
          mi.material = material
          if (found) {
            bounds.add(mi.aabb)
          } else {
            bounds.copy(mi.aabb)
            found = true
          }
        }
      }
      if (!found) {
        visual.destroy()
        continue
      }
      const body = new Entity('barrel-debris', this.physics.app)
      body.setPosition(bounds.center)
      body.addComponent('collision', {
        type: 'box',
        halfExtents: new Vec3(
          Math.max(0.01, bounds.halfExtents.x),
          Math.max(0.01, bounds.halfExtents.y),
          Math.max(0.01, bounds.halfExtents.z),
        ),
      })
      body.addComponent('rigidbody', {
        type: 'dynamic',
        mass: name.startsWith('hoop') ? 0.12 : 0.5,
        group: BODYGROUP_USER_2,
        mask: BODYGROUP_STATIC,
        friction: 0.7,
        restitution: 0.1,
        linearDamping: 0.25,
        angularDamping: 0.35,
      })
      this.physics.app.root.addChild(body)
      this.game.stage.addChild(visual)
      const offset = new Mat4().mul2(
        body.getWorldTransform().clone().invert(),
        visual.getWorldTransform(),
      )
      body.rigidbody?.applyImpulse(
        new Vec3(event.impulse.x, event.impulse.y + 0.5, event.impulse.z).mulScalar(
          body.rigidbody.mass,
        ),
        new Vec3(event.point.x, event.point.y, event.point.z).sub(bounds.center),
      )
      this.pieces.push({ body, visual, offset, age: 0 })
    }
    this.update(0)
  }
  private readonly update = (dt: number): void => {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const piece = this.pieces[i]
      if (!piece) {
        continue
      }
      piece.age += Math.max(0, dt)
      if (piece.age >= LIFE_SECONDS) {
        piece.body.destroy()
        piece.visual.destroy()
        this.pieces.splice(i, 1)
      } else {
        const world = this.matrix.mul2(piece.body.getWorldTransform(), piece.offset)
        piece.visual.setPosition(world.getTranslation(this.position))
        piece.visual.setRotation(this.rotation.setFromMat4(world))
      }
    }
  }
  reset(health: Uint8Array): void {
    this.pending.length = 0
    for (const piece of this.pieces) {
      piece.body.destroy()
      piece.visual.destroy()
    }
    this.pieces.length = 0
    this.physics.resetProps(health)
  }
  stats() {
    return { pieces: this.pieces.length, bodies: this.pieces.length, pending: this.pending.length }
  }
  private release(): void {
    if (this.acquired) {
      this.acquired = false
      this.game.releaseContainer(this.url)
    }
  }
  destroy(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.game.app.off('update', this.update)
    this.pending.length = 0
    for (const piece of this.pieces) {
      piece.body.destroy()
      piece.visual.destroy()
    }
    this.pieces.length = 0
    this.templates?.destroy()
    this.templates = undefined
    this.release()
  }
}
