import {
  BODYGROUP_STATIC,
  BODYGROUP_USER_1,
  Entity,
  type GraphNode,
  JOINTTYPE_BALL,
  Mat4,
  Quat,
  Vec3,
} from 'playcanvas'
import type { DuelActor } from '../duel/native-actor.ts'
import { loadAmmo } from '../runtime/ammo.ts'
import type { CollisionData } from '../runtime/protocol.ts'
import { createSimulation, type Simulation } from '../runtime/world.ts'
import type { GameApplication } from './application.ts'

const PARTS = [
  ['Hips', 'Chest', '', 0.16, 18],
  ['Head', '', 'Hips', 0.12, 5],
  ['UpperArmL', 'LowerArmL', 'Hips', 0.065, 3],
  ['LowerArmL', 'WristL', 'UpperArmL', 0.055, 2],
  ['UpperArmR', 'LowerArmR', 'Hips', 0.065, 3],
  ['LowerArmR', 'WristR', 'UpperArmR', 0.055, 2],
  ['UpperLegL', 'LowerLegL', 'Hips', 0.09, 7],
  ['LowerLegL', 'FootL', 'UpperLegL', 0.07, 4],
  ['UpperLegR', 'LowerLegR', 'Hips', 0.09, 7],
  ['LowerLegR', 'FootR', 'UpperLegR', 0.07, 4],
] as const
interface Part {
  body: Entity
  bone: GraphNode
  offset: Mat4
}
interface Corpse {
  actor: DuelActor
  parts: Part[]
  joints: Entity[]
  seconds: number
}

/** Native bodies and ball joints replace the old application-owned ragdoll solver. */
export class NativeRagdolls {
  private readonly game: GameApplication
  private readonly physics: Simulation
  private readonly corpses = new Map<string, Corpse>()
  private readonly frozen = new Map<
    string,
    { actor: DuelActor; poses: { bone: GraphNode; position: Vec3; rotation: Quat }[] }
  >()
  private readonly matrix = new Mat4()
  private readonly position = new Vec3()
  private readonly rotation = new Quat()
  private readonly sharers = new Set<() => boolean>()
  private elapsed = 0
  private constructor(game: GameApplication, physics: Simulation) {
    this.game = game
    this.physics = physics
    game.app.on('update', this.update)
    game.app.on('prerender', this.pose)
  }
  static async create(game: GameApplication, collision: CollisionData): Promise<NativeRagdolls> {
    return new NativeRagdolls(
      game,
      createSimulation({ ammo: await loadAmmo(), collision, joints: true, gravity: 18 }),
    )
  }
  /** Other client-only debris joins this town world; it steps while any user has live bodies. */
  share(active: () => boolean): Simulation {
    this.sharers.add(active)
    return this.physics
  }
  private stepping(): boolean {
    if (this.corpses.size > 0) {
      return true
    }
    for (const active of this.sharers) {
      if (active()) {
        return true
      }
    }
    return false
  }
  capture(id: string, actor: DuelActor, velocity: Vec3): void {
    if (this.corpses.has(id) || this.frozen.has(id)) {
      return
    }
    if (this.corpses.size >= 4) {
      const first = this.corpses.keys().next().value
      if (first) {
        this.freeze(first)
      }
    }
    const parts: Part[] = []
    const joints: Entity[] = []
    const byName = new Map<string, Entity>()
    if (actor.model.anim) {
      actor.model.anim.enabled = false
    }
    for (const [name, endName, parent, radius, mass] of PARTS) {
      const bone = actor.model.findByName(name)
      if (!bone) {
        continue
      }
      const start = bone.getPosition().clone()
      const end =
        (endName ? actor.model.findByName(endName) : null)?.getPosition().clone() ??
        start.clone().add(new Vec3(0, 0.14, 0))
      const body = new Entity(`corpse-${id}-${name}`, this.physics.app)
      body.setPosition(new Vec3().lerp(start, end, 0.5))
      const direction = new Vec3().sub2(end, start)
      const distance = direction.length()
      if (distance > 0) {
        body.setRotation(new Quat().setFromDirections(Vec3.UP, direction.normalize()))
      }
      body.addComponent('collision', {
        type: 'capsule',
        radius,
        height: Math.max(radius * 2, distance + radius * 2),
      })
      body.addComponent('rigidbody', {
        type: 'dynamic',
        mass,
        friction: 0.7,
        restitution: 0,
        linearDamping: 0.35,
        angularDamping: 0.7,
        group: BODYGROUP_USER_1,
        mask: BODYGROUP_STATIC | BODYGROUP_USER_1,
      })
      this.physics.app.root.addChild(body)
      if (body.rigidbody) {
        body.rigidbody.linearVelocity = velocity
      }
      const offset = new Mat4().mul2(
        body.getWorldTransform().clone().invert(),
        bone.getWorldTransform(),
      )
      parts.push({ body, bone, offset })
      byName.set(name, body)
      const parentBody = byName.get(parent)
      if (parentBody) {
        const joint = new Entity(`joint-${id}-${name}`, this.physics.app)
        joint.setPosition(start)
        joint.addComponent('joint', {
          type: JOINTTYPE_BALL,
          entityA: body,
          entityB: parentBody,
          enableCollision: false,
          enableLimits: true,
          swingLimitY: 60,
          swingLimitZ: 60,
          twistLimit: 35,
        })
        this.physics.app.root.addChild(joint)
        joints.push(joint)
      }
    }
    this.corpses.set(id, { actor, parts, joints, seconds: 0 })
  }
  release(id: string): void {
    const corpse = this.corpses.get(id)
    const actor = corpse?.actor ?? this.frozen.get(id)?.actor
    if (corpse) {
      for (const joint of corpse.joints) {
        joint.destroy()
      }
      for (const part of corpse.parts) {
        part.body.destroy()
      }
      this.corpses.delete(id)
    }
    this.frozen.delete(id)
    if (actor?.model.anim) {
      actor.model.anim.enabled = true
    }
  }
  private freeze(id: string): void {
    const corpse = this.corpses.get(id)
    if (!corpse) {
      return
    }
    for (const joint of corpse.joints) {
      joint.destroy()
    }
    for (const part of corpse.parts) {
      part.body.destroy()
    }
    this.corpses.delete(id)
    this.frozen.set(id, {
      actor: corpse.actor,
      poses: corpse.parts.map((part) => ({
        bone: part.bone,
        position: part.bone.getPosition().clone(),
        rotation: part.bone.getRotation().clone(),
      })),
    })
  }
  private readonly update = (dt: number): void => {
    if (document.hidden) {
      return
    }
    if (this.stepping()) {
      this.elapsed = Math.min(0.1, this.elapsed + dt)
      while (this.elapsed >= 1 / 60) {
        this.physics.app.systems.rigidbody?.step(1 / 60)
        this.elapsed -= 1 / 60
      }
    } else {
      this.elapsed = 0
    }
    for (const [id, corpse] of this.corpses) {
      corpse.seconds += dt
      if (corpse.seconds > 4) {
        this.freeze(id)
      }
    }
  }
  stats(): { active: number; frozen: number; bodies: number } {
    return {
      active: this.corpses.size,
      frozen: this.frozen.size,
      bodies: [...this.corpses.values()].reduce((count, corpse) => count + corpse.parts.length, 0),
    }
  }
  private readonly pose = (): void => {
    for (const corpse of this.frozen.values()) {
      for (const part of corpse.poses) {
        part.bone.setPosition(part.position)
        part.bone.setRotation(part.rotation)
      }
    }
    for (const corpse of this.corpses.values()) {
      for (const part of corpse.parts) {
        this.matrix.mul2(part.body.getWorldTransform(), part.offset)
        this.matrix.getTranslation(this.position)
        this.rotation.setFromMat4(this.matrix)
        part.bone.setPosition(this.position)
        part.bone.setRotation(this.rotation)
      }
    }
  }
  destroy(): void {
    this.sharers.clear()
    this.game.app.off('update', this.update)
    this.game.app.off('prerender', this.pose)
    for (const id of [...this.corpses.keys(), ...this.frozen.keys()]) {
      this.release(id)
    }
    this.physics.dispose()
  }
}
