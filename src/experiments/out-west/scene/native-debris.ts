import { BoundingBox, Entity, Mat4, Quat, Vec3 } from 'playcanvas'
import type { DuelActor } from '../duel/native-actor.ts'
import { loadAmmo } from '../runtime/ammo.ts'
import { createSimulation, type Simulation } from '../runtime/world.ts'

interface Piece {
  actor: DuelActor
  visual: Entity
  body: Entity | null
  offset: Mat4
  seconds: number
}

/** Presentation props use the same native Ammo adapter as the player motor. */
export class NativeDebris {
  readonly ready: Promise<void>
  private physics: Simulation | null = null
  private readonly pieces: Piece[] = []
  private elapsed = 0
  private closed = false as boolean
  constructor() {
    this.ready = loadAmmo().then((ammo) => {
      if (this.closed) {
        return
      }
      this.physics = createSimulation({
        ammo,
        gravity: 18,
        collision: {
          version: 'duel-prop-floor',
          boxes: [{ center: [0, -0.05, 0], halfExtents: [128, 0.05, 128] }],
          meshes: [],
        },
      })
    })
  }
  drop(actor: DuelActor, kind: 'hat' | 'gun', away: Vec3, big = false): void {
    if (!this.physics || this.closed || this.pieces.length >= 8) {
      return
    }
    const visual = actor.detach(kind)
    if (!visual) {
      return
    }
    const bounds = new BoundingBox()
    let found = false
    for (const render of visual.findComponents('render')) {
      for (const mesh of render.meshInstances) {
        if (found) {
          bounds.add(mesh.aabb)
        } else {
          bounds.copy(mesh.aabb)
          found = true
        }
      }
    }
    if (!found) {
      bounds.center.copy(visual.getPosition())
      bounds.halfExtents.set(0.08, 0.04, 0.08)
    }
    const body = new Entity(`duel-dropped-${kind}`, this.physics.app)
    body.setPosition(bounds.center)
    body.addComponent('collision', {
      type: 'box',
      halfExtents: new Vec3(
        Math.max(0.025, bounds.halfExtents.x),
        Math.max(0.025, bounds.halfExtents.y),
        Math.max(0.025, bounds.halfExtents.z),
      ),
    })
    body.addComponent('rigidbody', {
      type: 'dynamic',
      mass: kind === 'hat' ? 0.25 : 0.4,
      friction: 0.7,
      restitution: 0.15,
      linearDamping: 0.15,
      angularDamping: 0.3,
    })
    this.physics.app.root.addChild(body)
    const velocity = away.clone().mulScalar(big ? 1.6 : 1)
    velocity.y = big ? 4.5 : 2.2
    if (kind === 'gun') {
      velocity.y = 2.6
    }
    if (body.rigidbody) {
      body.rigidbody.linearVelocity = velocity
      body.rigidbody.angularVelocity = new Vec3(6, 4, kind === 'gun' ? 12 : 6)
    }
    this.pieces.push({
      actor,
      visual,
      body,
      offset: new Mat4().mul2(
        body.getWorldTransform().clone().invert(),
        visual.getWorldTransform(),
      ),
      seconds: 0,
    })
  }
  update(dt: number): void {
    if (!this.physics || this.closed || !this.pieces.some((piece) => piece.body)) {
      return
    }
    this.elapsed = Math.min(0.1, this.elapsed + dt)
    while (this.elapsed >= 1 / 60) {
      this.physics.app.systems.rigidbody?.step(1 / 60)
      this.elapsed -= 1 / 60
    }
    for (const piece of this.pieces) {
      if (!piece.body) {
        continue
      }
      if (!piece.visual.parent) {
        piece.body.destroy()
        piece.body = null
        continue
      }
      const world = new Mat4().mul2(piece.body.getWorldTransform(), piece.offset)
      piece.visual.setPosition(world.getTranslation())
      piece.visual.setRotation(new Quat().setFromMat4(world))
      piece.seconds += Math.min(0.1, dt)
      if (piece.seconds >= 4) {
        piece.body.destroy()
        piece.body = null
      }
    }
  }
  reset(): void {
    for (const actor of new Set(this.pieces.map((piece) => piece.actor))) {
      actor.restoreAttachments()
    }
    for (const piece of this.pieces) {
      piece.body?.destroy()
    }
    this.pieces.length = 0
    this.elapsed = 0
  }
  stats(): { pieces: number; bodies: number } {
    return { pieces: this.pieces.length, bodies: this.pieces.filter((piece) => piece.body).length }
  }
  destroy(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.reset()
    this.physics?.dispose()
    this.physics = null
  }
}
