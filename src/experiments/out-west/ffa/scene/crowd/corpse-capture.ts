/** Reconstruct a far rider's captured animation clock on their real dressed rig. */
import { LoopRepeat, type Matrix4, Mesh, type Object3D, type Vector3 } from 'three'
import { EF_HATLESS, EF_HOLSTERED, WEAPON_RIFLE, WEAPON_SHOTGUN } from '../../../contract/town.ts'
import type { Assets } from '../../../engine/assets.ts'
import { Actor, type Clip } from '../../../scene/actor.ts'
import { type ActorTemplate, restoreTemplateHat } from '../../../scene/actor-template.ts'
import { boneKey } from '../../../scene/fit.ts'
import { rifleObject } from '../../../scene/rifle.ts'
import type { PlayerLook } from '../looks.ts'
import { shotgunMesh } from '../shotgun.ts'
import { copyPlayerLook, dressedRider } from './actor.ts'
import { aimedGaits } from './aim-gait.ts'
import { type CorpseRig, cloneCorpse, prepareCorpseFit } from './corpse-rig.ts'
import { ownGeometry, releaseGeometry, retainGeometry } from './geometry-lease.ts'
import { isResourceReleasedError, ResourceCache } from './resource-cache.ts'

export interface CorpseSnapshot {
  identity: string
  look: PlayerLook
  world: Matrix4
  clip: string
  time: number
  flags: number
  weapon: number
  velocity: Vector3
  phase?: number
  primarySocket?: 'hand' | 'holster'
  attachments?: Partial<Record<'primary' | 'offhand' | 'long' | 'hat', Matrix4>>
}
interface PreparedCorpse {
  actor: Actor
  template: ActorTemplate
  rifle: ReturnType<Actor['addLong']>
  shotgun: ReturnType<Actor['addLong']>
}
const preparationCache = new ResourceCache<PreparedCorpse>({
  idleLimit: 0,
  concurrency: 1,
  dispose: (value) => {
    for (const mesh of value.template.meshes) {
      mesh.skeleton.dispose()
    }
    disposePrepared(value.actor)
  },
})
export const corpsePreparationStats = () => preparationCache.stats

export class CorpsePreparation {
  private readonly jobs = new Map<string, Promise<PreparedCorpse>>()
  private readonly ready = new Map<string, PreparedCorpse>()
  private readonly acquisitions = { forks: 0, misses: 0, lastMs: 0, maxMs: 0 }
  private readonly assets: Assets
  constructor(assets: Assets) {
    this.assets = assets
  }
  get stats() {
    return {
      ready: this.ready.size,
      pending: this.jobs.size - this.ready.size,
      ...this.acquisitions,
    }
  }
  retain(look: PlayerLook): Promise<PreparedCorpse> {
    const have = this.jobs.get(look.key)
    if (have) {
      return have
    }
    const source = copyPlayerLook(look)
    const job = preparationCache.acquire(look.key, async () => {
      await this.assets.lookReady(source.look)
      const actor = dressedRider(this.assets, source)
      const body = actor.meshes[0]
      if (!body) {
        throw new Error('Prepared corpse has no body')
      }
      ownGeometry(body.geometry)
      const template = actor.template()
      const rifle = actor.addLong(rifleObject())
      const gun = shotgunMesh()
      gun.scale.set(1.15, 1.38, 1.38)
      const shotgun = actor.addLong(gun)
      prepareCorpseFit(actor)
      return { actor, template, rifle, shotgun }
    })
    this.jobs.set(look.key, job)
    void job.then(
      (value) => {
        if (this.jobs.get(look.key) === job) {
          this.ready.set(look.key, value)
        }
      },
      () => undefined,
    )
    void job.catch((error: unknown) => {
      if (this.jobs.get(look.key) === job) {
        this.jobs.delete(look.key)
      }
      if (!isResourceReleasedError(error)) {
        console.error('Dressed corpse preparation failed', error)
      }
    })
    return job
  }
  releaseUnused(keys: ReadonlySet<string>): void {
    for (const key of this.jobs.keys()) {
      if (!keys.has(key)) {
        this.jobs.delete(key)
        this.ready.delete(key)
        preparationCache.release(key)
      }
    }
  }
  /** A living fork shares only immutable fitted buffers with the active prepared appearance. */
  fork(look: PlayerLook): Actor | null {
    const source = this.ready.get(look.key)
    if (!source) {
      this.acquisitions.misses++
      return null
    }
    const started = performance.now()
    const actor = new Actor(source.template)
    for (const mesh of actor.meshes) {
      retainGeometry(mesh.geometry)
    }
    this.acquisitions.forks++
    this.acquisitions.lastMs = performance.now() - started
    this.acquisitions.maxMs = Math.max(this.acquisitions.maxMs, this.acquisitions.lastMs)
    return actor
  }
  reset(look: PlayerLook, actor: Actor): void {
    const source = this.ready.get(look.key)
    if (!source) {
      return
    }
    actor.drawing?.undo()
    actor.gestures.undo()
    actor.gestures.clear()
    actor.stopAll(true)
    actor.holdLong(null)
    actor.holsterGun()
    actor.root.traverse((node) => {
      const original = source.template.bones.get(boneKey(node.name))
      if (original && (node as { isBone?: boolean }).isBone) {
        node.position.copy(original.position)
        node.quaternion.copy(original.quaternion)
        node.scale.copy(original.scale)
      }
    })
    restoreTemplateHat(actor, source.template)
    actor.longKick = 0
    actor.longCarry = 0
    actor.glow.value = 0
  }
  async capture(snapshot: CorpseSnapshot): Promise<CorpseRig> {
    const pending = this.retain(snapshot.look)
    const source = await preparationCache.acquire(snapshot.look.key, () => pending)
    try {
      return reconstructCorpse(source, snapshot)
    } finally {
      preparationCache.release(snapshot.look.key)
    }
  }
}

function reconstructCorpse(prepared: PreparedCorpse, snapshot: CorpseSnapshot): CorpseRig {
  const actor = prepared.actor
  const body = actor.meshes[0]
  if (!body) {
    throw new Error('Dressed corpse has no skin')
  }
  actor.holdLong(null)
  {
    const source = actor.action(snapshot.clip as Clip)?.getClip()
    const clips = ['Walk', 'Run', 'Idle_Gun_Pointing'].flatMap((name) => {
      const clip = actor.action(name as Clip)?.getClip()
      return clip ? [clip] : []
    })
    const clip =
      source ??
      new Map(aimedGaits(clips).map((candidate) => [candidate.name, candidate])).get(snapshot.clip)
    actor.mixer.stopAllAction()
    if (clip) {
      const action = actor.mixer
        .clipAction(clip)
        .reset()
        .setLoop(LoopRepeat, Number.POSITIVE_INFINITY)
        .play()
      action.time = snapshot.phase === undefined ? snapshot.time : clip.duration * snapshot.phase
      actor.mixer.update(0)
    }
    if (
      snapshot.primarySocket === 'holster' ||
      (snapshot.primarySocket === undefined && snapshot.flags & EF_HOLSTERED)
    ) {
      actor.holsterGun()
    } else {
      actor.draw()
    }
    if (actor.offGun && actor.offHolster) {
      actor.offHolster.attach(actor.offGun)
      actor.offGun.position.set(0, 0, 0)
      actor.offGun.rotation.set(0, 0, 0)
    }
    if (snapshot.weapon === WEAPON_RIFLE || snapshot.weapon === WEAPON_SHOTGUN) {
      actor.holsterGun()
      // The VAT body has no procedural IK; preserve the body pose and its baked gun socket.
    }
    if (actor.hat) {
      actor.hat.visible = (snapshot.flags & EF_HATLESS) === 0
    }
    snapshot.world.decompose(actor.root.position, actor.root.quaternion, actor.root.scale)
    // Match the VAT clock exactly; near-only gestures, recoil and long-gun IK are not baked.
    actor.mixer.update(0)
    actor.root.updateMatrixWorld(true)
    let long: ReturnType<Actor['addLong']> = null
    if (snapshot.weapon === WEAPON_RIFLE) {
      long = prepared.rifle
    } else if (snapshot.weapon === WEAPON_SHOTGUN) {
      long = prepared.shotgun
    }
    if (long) {
      actor.holdLong(long)
    }
    const attachments = snapshot.attachments
    for (const [node, world] of [
      [actor.gun, attachments?.primary],
      [actor.offGun, attachments?.offhand],
      [long?.obj, attachments?.long],
    ] as const) {
      if (node && world) {
        placeWorld(node, world)
      }
    }
    actor.hat?.traverse((node) => {
      if (node instanceof Mesh && attachments?.hat) {
        placeWorld(node, attachments.hat)
      }
    })
    actor.root.updateMatrixWorld(true)
    const rig = cloneCorpse(actor, body.geometry, snapshot.identity)
    rig.velocity.copy(snapshot.velocity)
    return rig
  }
}

function disposePrepared(actor: Actor): void {
  const body = actor.meshes[0]
  if (body) {
    releaseGeometry(body.geometry)
  }
  const materials = new Set<import('three').Material>()
  for (const mesh of actor.meshes) {
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(mat)
    }
  }
  actor.hat?.traverse((node) => {
    if (node instanceof Mesh) {
      node.geometry.dispose()
      for (const mat of Array.isArray(node.material) ? node.material : [node.material]) {
        materials.add(mat)
      }
    }
  })
  actor.root.traverse((node) => {
    if (node instanceof Mesh && node.userData.actorMaterial === true) {
      for (const mat of Array.isArray(node.material) ? node.material : [node.material]) {
        materials.add(mat)
      }
    }
  })
  for (const material of materials) {
    material.dispose()
  }
  actor.dispose()
}

function placeWorld(node: Object3D, world: Matrix4): void {
  const local = node.parent ? node.parent.matrixWorld.clone().invert().multiply(world) : world
  local.decompose(node.position, node.quaternion, node.scale)
  node.updateMatrix()
  node.updateMatrixWorld(true)
}
