import type {
  AnimComponentLayer,
  AnimTrack,
  ContainerResource,
  Entity,
  GraphNode,
} from 'playcanvas'
import { Mat4, Quat, Vec3 } from 'playcanvas'
import { ASSETS, CONTENT_VERSION } from '../content/manifest.ts'
import { DEFAULT_LOADOUT, type Loadout } from '../data/catalog.ts'
import type { Dyes } from '../data/dye.ts'
import { DuelActor } from '../duel/native-actor.ts'
import { eyeHeight } from '../ffa/sim/combat.ts'
import type { World } from '../ffa/sim/state.ts'
import type { Player } from '../ffa/sim/types.ts'
import type { PlayerState } from '../runtime/protocol.ts'
import { RECOIL_SECONDS } from '../scene/native-animation-timing.ts'
import { attachHeldWeapon, equippedActor } from '../scene/native-equipment.ts'
import { prepareNativeMaterials } from '../scene/native-materials.ts'
import { animateRider, heldWeapon } from './actor-animation.ts'
import { createRiderPose, type RiderPose } from './actor-pose.ts'
import type { GameApplication } from './application.ts'
import type { NativeRagdolls } from './ragdolls.ts'

export interface Appearance {
  loadout: Loadout
  dyes: Dyes
  key: string
}
export interface PreparedCharacters {
  readonly root: Entity
  dispose: () => void
  take: () => { actor: DuelActor; key: string; release: () => void }
}
async function commonCharacters(game: GameApplication): Promise<() => void> {
  const [, fallback] = await Promise.all([
    game.loadContainer(ASSETS.moves.url),
    game.loadContainer(ASSETS['outlaw-0'].url),
    game.loadContainer(heldUrl('rifle')),
    game.loadContainer(heldUrl('shotgun')),
  ])
  return prepareNativeMaterials(game, fallback.resource as ContainerResource)
}
interface Rider {
  actor: DuelActor
  head: GraphNode | null
  key: string
  clip: string
  firingUntil: number
  dead: boolean
  aim: AnimComponentLayer | undefined
  weaponLayer: AnimComponentLayer | undefined
  pose: RiderPose
  held: Map<string, Entity>
  heldPending: Set<string>
  heldFailures: Set<string>
}

const heldUrl = (weapon: 'rifle' | 'shotgun'): string =>
  `/experiments/out-west/3d/native-v2/dynamic/held-${weapon}.glb?v=${CONTENT_VERSION}`

const rigInverse = new Mat4()
const viewRotation = new Quat()
const bodyRotation = new Quat()
const bodyOffset = new Vec3()
const facing = new Quat().setFromEulerAngles(0, 180, 0)

/** Every mode uses the same authored rigs, native animation, equipment and dye pipeline. */
export class Actors {
  private readonly game: GameApplication
  private readonly ragdolls: NativeRagdolls
  private readonly world: () => World | undefined
  private readonly appearance: (id: string) => Appearance | undefined
  private readonly actors = new Map<string, Rider>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, string>()
  private present = new Set<string>()
  private players: ReadonlyMap<string, PlayerState> = new Map()
  private generation = 0
  private readonly incarnations = new Map<string, { serial: number; spawn: number | undefined }>()
  private tracks: AnimTrack[] = []
  private releaseCommon: (() => void) | undefined
  private readonly notice = document.createElement('div')
  private readonly lifecycle = new AbortController()
  constructor(
    game: GameApplication,
    ragdolls: NativeRagdolls,
    appearance: (id: string) => Appearance | undefined = () => undefined,
    world: () => World | undefined = () => undefined,
  ) {
    this.game = game
    this.ragdolls = ragdolls
    this.appearance = appearance
    this.world = world
    this.notice.className = 'pc-game-status'
    this.notice.setAttribute('role', 'status')
    this.notice.style.cssText = 'top:auto;bottom:20px;left:50%;transform:translateX(-50%)'
    this.notice.hidden = true
    const message = document.createElement('span')
    message.textContent = 'Some riders are still loading.'
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = 'Retry loading riders'
    retry.addEventListener(
      'click',
      () => {
        this.failures.clear()
        for (const rider of this.actors.values()) {
          rider.heldFailures.clear()
        }
        this.notice.hidden = true
      },
      { signal: this.lifecycle.signal },
    )
    this.notice.append(message, retry)
    const canvas = game.app.graphicsDevice.canvas
    if (canvas instanceof HTMLCanvasElement) {
      canvas.parentElement?.append(this.notice)
    }
  }
  static async prepare(
    game: GameApplication,
    appearance?: Appearance,
  ): Promise<PreparedCharacters> {
    const [own, common] = await Promise.allSettled([
      equippedActor(game, appearance?.loadout ?? DEFAULT_LOADOUT, appearance?.dyes ?? {}),
      commonCharacters(game),
    ])
    if (own.status === 'rejected' || common.status === 'rejected') {
      if (own.status === 'fulfilled') {
        own.value.destroy()
      }
      if (common.status === 'fulfilled') {
        common.value()
      }
      throw own.status === 'rejected' ? own.reason : (common as PromiseRejectedResult).reason
    }
    const actor = own.value
    const release = common.value
    actor.root.enabled = false
    let available = true
    return {
      root: actor.root,
      dispose() {
        if (available) {
          available = false
          actor.destroy()
          release()
        }
      },
      take() {
        if (!available) {
          throw new Error('Prepared character was already disposed or adopted')
        }
        available = false
        return { actor, key: appearance?.key ?? 'default', release }
      },
    }
  }
  async initialize(
    players: ReadonlyMap<string, PlayerState>,
    ownId?: string,
    prepared?: PreparedCharacters,
  ): Promise<void> {
    this.syncPlayers(players)
    const own = ownId ?? players.keys().next().value
    try {
      const moves = await this.game.loadContainer(ASSETS.moves.url)
      this.tracks = (moves.resource as ContainerResource).animations.map(
        (clip) => clip.resource as AnimTrack,
      )
      if (!(own && players.has(own))) {
        throw new Error('The own rider is not present')
      }
      if (this.lifecycle.signal.aborted) {
        throw new DOMException('Riders were closed', 'AbortError')
      }
      if (prepared) {
        const value = prepared.take()
        this.releaseCommon = value.release
        this.assign(own, value.actor, value.key)
        const self = players.get(own)
        if (self) {
          value.actor.place(self.x, self.y - 0.9, self.z)
        }
        value.actor.root.enabled = true
      } else {
        this.releaseCommon = await commonCharacters(this.game)
        await this.ensure(own, true)
        if (this.failures.has(own)) {
          throw new Error('Own rider assets unavailable')
        }
      }
      // Only cached coherent fallback clones are awaited after join. Cosmetics upgrade in background.
      await Promise.all(
        [...players.keys()]
          .filter((id) => id !== own)
          .map(async (id) => {
            const fallback = await DuelActor.create(
              this.game,
              ASSETS['outlaw-0'].url,
              `rider-${id}-loading`,
            )
            if (this.lifecycle.signal.aborted || !this.present.has(id)) {
              fallback.destroy()
              return
            }
            const state = players.get(id)
            if (state) {
              fallback.place(state.x, state.y - 0.9, state.z)
            }
            this.assign(id, fallback, 'loading')
            void this.ensure(id)
          }),
      )
      this.update(players, 0)
    } catch (cause) {
      prepared?.dispose()
      throw new Error('Could not load the riders. Check your connection and try again.', { cause })
    }
  }
  private syncPlayers(players: ReadonlyMap<string, PlayerState>): void {
    this.players = players
    this.present = new Set(players.keys())
    for (const id of players.keys()) {
      const spawn = this.world()?.players[Number(id)]?.spawnTick
      const previous = this.incarnations.get(id)
      if (!previous || previous.spawn !== spawn) {
        this.incarnations.set(id, { serial: ++this.generation, spawn })
      }
    }
    for (const id of this.incarnations.keys()) {
      if (!players.has(id)) {
        this.incarnations.delete(id)
      }
    }
  }
  private key(id: string): string {
    return this.appearance(id)?.key ?? 'default'
  }
  private assign(id: string, actor: DuelActor, key: string): void {
    actor.root.tags.add(`rider:${id}`)
    for (const track of this.tracks) {
      if (!actor.hasAnimation(track.name)) {
        actor.model.anim?.baseLayer?.assignAnimation(track.name, track)
      }
    }
    const pose = createRiderPose(this.game, actor)
    const weaponLayer = pose.weapon
    const aim = pose.aim
    this.ragdolls.release(id)
    this.actors.get(id)?.actor.destroy()
    actor.root.enabled = false
    this.actors.set(id, {
      actor,
      head: actor.model.findByName('Head'),
      key,
      clip: '',
      firingUntil: 0,
      dead: false,
      aim,
      weaponLayer,
      pose,
      held: new Map(),
      heldPending: new Set(),
      heldFailures: new Set(),
    })
  }
  private ensure(id: string, initial = false): Promise<void> | undefined {
    if ((this.players.get(id)?.hp ?? 0) <= 0) {
      return
    }
    const incarnation = this.incarnations.get(id)?.serial
    const appearance = this.appearance(id)
    const key = this.key(id)
    if (this.actors.get(id)?.key === key) {
      return
    }
    const pending = this.pending.get(id)
    if (pending) {
      return pending
    }
    // PlayCanvas owns its bounded exponential HTTP retry policy; exhausted assets wait for Retry.
    if (this.failures.get(id) === key) {
      return
    }
    const promise = (async () => {
      if (!(initial || this.actors.has(id))) {
        const fallback = await DuelActor.create(
          this.game,
          ASSETS['outlaw-0'].url,
          `rider-${id}-loading`,
        )
        if (this.lifecycle.signal.aborted || !this.present.has(id)) {
          fallback.destroy()
          return
        }
        this.assign(id, fallback, 'loading')
      }
      const actor = appearance
        ? await equippedActor(this.game, appearance.loadout, appearance.dyes)
        : await DuelActor.create(
            this.game,
            ASSETS[`outlaw-${Math.abs(Number(id)) % 17}` as keyof typeof ASSETS].url,
            `rider-${id}`,
          )
      if (
        this.lifecycle.signal.aborted ||
        !this.present.has(id) ||
        this.key(id) !== key ||
        this.incarnations.get(id)?.serial !== incarnation ||
        (this.players.get(id)?.hp ?? 0) <= 0
      ) {
        actor.destroy()
        return
      }
      this.assign(id, actor, key)
      this.failures.delete(id)
      this.notice.hidden =
        this.failures.size === 0 &&
        ![...this.actors.values()].some((rider) => rider.heldFailures.size > 0)
    })()
      .catch(() => {
        if (this.lifecycle.signal.aborted || !this.present.has(id)) {
          return
        }
        this.failures.set(id, key)
        this.notice.hidden = initial
      })
      .finally(() => this.pending.delete(id))
    this.pending.set(id, promise)
    return promise
  }
  update(players: ReadonlyMap<string, PlayerState>, _dt: number, firstPersonId?: string): void {
    this.syncPlayers(players)
    for (const id of this.failures.keys()) {
      if (!players.has(id)) {
        this.failures.delete(id)
      }
    }
    this.notice.hidden =
      this.failures.size === 0 &&
      ![...this.actors.values()].some((rider) => rider.heldFailures.size > 0)
    for (const [id, player] of players) {
      void this.ensure(id)
      const rider = this.actors.get(id)
      if (!rider) {
        continue
      }
      const { actor } = rider
      rider.pose.enabled(player.hp > 0)
      const domain = this.world()?.players[Number(id)] ?? undefined
      actor.root.enabled = id !== firstPersonId || player.hp > 0
      // Use the same native animated body and weapon in first person. Collapsing the head bone
      // also hides its mounted hat, while retaining authored arms, clothing and gun animation.
      const scale = id === firstPersonId ? 0.0001 : 1
      rider.head?.setLocalScale(scale, scale, scale)
      // The SDK interpolates remote state; the local state already contains native prediction.
      // Another interpolation here delays the body behind its capsule and makes feet skate.
      actor.place(player.x, player.y - 0.9, player.z)
      actor.face((player.yaw * 180) / Math.PI + 180)
      if (id === firstPersonId && player.hp > 0) {
        Actors.placeFirstPerson(actor, player, rider.head, domain)
      }
      if (player.hp <= 0 && !rider.dead) {
        this.ragdolls.capture(id, actor, new Vec3(player.vx, player.vy + 0.4, player.vz))
        rider.dead = true
      } else if (player.hp > 0 && rider.dead) {
        this.ragdolls.release(id)
        rider.dead = false
      }
      const weapon = heldWeapon(domain)
      if (weapon !== 'revolver') {
        this.ensureHeld(rider, weapon)
      }
      actor.hold(weapon, player.hp > 0)
      animateRider(rider, player, {
        first: id === firstPersonId,
        domain,
      })
    }
    this.removeDeparted(players)
  }
  private ensureHeld(rider: Rider, weapon: 'rifle' | 'shotgun'): void {
    if (rider.held.has(weapon) || rider.heldPending.has(weapon) || rider.heldFailures.has(weapon)) {
      return
    }
    rider.heldPending.add(weapon)
    void attachHeldWeapon(this.game, rider.actor, weapon, heldUrl(weapon))
      .then((model) => {
        if (this.lifecycle.signal.aborted || !rider.actor.root.parent) {
          model.destroy()
          return
        }
        rider.held.set(weapon, model)
      })
      .catch(() => {
        if (rider.actor.root.parent) {
          rider.heldFailures.add(weapon)
          this.notice.hidden = false
        }
      })
      .finally(() => rider.heldPending.delete(weapon))
  }
  private removeDeparted(players: ReadonlyMap<string, PlayerState>): void {
    for (const [id, rider] of this.actors) {
      if (!players.has(id)) {
        this.ragdolls.release(id)
        rider.actor.destroy()
        this.actors.delete(id)
      }
    }
  }
  private static placeFirstPerson(
    actor: DuelActor,
    player: PlayerState,
    headBone: GraphNode | null,
    domain: Player | undefined,
  ): void {
    // The world eye follows the shared gameplay height. The local rig reference follows
    // its actual native standing/crouching pose, rather than pretending both are the same height.
    const eye = eyeHeight({ crouched: player.crouched ?? domain?.crouched ?? false })
    if (headBone) {
      rigInverse
        .copy(actor.root.getWorldTransform())
        .invert()
        .transformPoint(headBone.getPosition(), bodyOffset)
      bodyOffset.y += 0.1 // Authored eyes sit ten centimetres above the Head joint.
    } else {
      bodyOffset.set(0, 1.62, 0)
    }
    bodyOffset.mulScalar(-1)
    viewRotation.setFromEulerAngles((player.pitch * 180) / Math.PI, (player.yaw * 180) / Math.PI, 0)
    bodyRotation.copy(viewRotation).mul(facing)
    bodyRotation.transformVector(bodyOffset, bodyOffset)
    actor.place(
      player.x + bodyOffset.x,
      player.y - 0.9 + eye + bodyOffset.y,
      player.z + bodyOffset.z,
    )
    actor.root.setRotation(bodyRotation)
  }

  fire(id: string): void {
    const rider = this.actors.get(id)
    if (rider) {
      rider.firingUntil = performance.now() + RECOIL_SECONDS * 1000
      rider.actor.fireWeapon()
      const clip = rider.actor.shotClip(this.players.get(id)?.crouched ?? false)
      if (rider.weaponLayer?.states.includes(clip)) {
        rider.weaponLayer.play(clip)
        rider.pose.root.anim?.update(0)
      }
    }
  }
  muzzle(id: string): { position: Vec3; direction: Vec3 } | null {
    return this.actors.get(id)?.actor.muzzle() ?? null
  }
  stats(): { loaded: number; loading: number; failed: number; fallbacks: number; visible: number } {
    const riders = [...this.actors.values()]
    return {
      loaded: riders.length,
      loading: this.pending.size,
      failed: this.failures.size,
      fallbacks: riders.filter((rider) => rider.key === 'loading').length,
      visible: riders.filter((rider) => rider.actor.root.enabled).length,
    }
  }
  destroy(): void {
    this.lifecycle.abort()
    this.present.clear()
    this.players = new Map()
    this.incarnations.clear()
    this.failures.clear()
    this.pending.clear()
    this.tracks = []
    this.releaseCommon?.()
    this.releaseCommon = undefined
    this.notice.remove()
    for (const [id, rider] of this.actors) {
      this.ragdolls.release(id)
      rider.actor.destroy()
    }
    this.actors.clear()
  }
}
