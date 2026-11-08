import type { AnimComponentLayer, AnimTrack, ContainerResource, GraphNode } from 'playcanvas'
import { Quat, Vec3 } from 'playcanvas'
import { ASSETS } from '../content/manifest.ts'
import type { Loadout } from '../data/catalog.ts'
import type { Dyes } from '../data/dye.ts'
import { DuelActor } from '../duel/native-actor.ts'
import type { World } from '../ffa/sim/state.ts'
import type { Player } from '../ffa/sim/types.ts'
import type { PlayerState } from '../runtime/protocol.ts'
import { equippedActor } from '../scene/native-equipment.ts'
import type { GameApplication } from './application.ts'
import type { NativeRagdolls } from './ragdolls.ts'

export interface Appearance {
  loadout: Loadout
  dyes: Dyes
  key: string
}
interface Rider {
  actor: DuelActor
  head: GraphNode | null
  key: string
  clip: string
  firingUntil: number
  initialized: boolean
  dead: boolean
  aim: AnimComponentLayer | undefined
}

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
  private tracks: AnimTrack[] = []
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
  async initialize(players: ReadonlyMap<string, PlayerState>): Promise<void> {
    this.present = new Set(players.keys())
    try {
      const [moves] = await Promise.all([
        this.game.loadContainer(ASSETS.moves.url),
        this.game.loadContainer(ASSETS['outlaw-0'].url),
      ])
      this.tracks = (moves.resource as ContainerResource).animations.map(
        (clip) => clip.resource as AnimTrack,
      )
      await Promise.all([...players.keys()].map((id) => this.ensure(id, true)))
      if (this.failures.size > 0) {
        throw new Error('Rider assets unavailable')
      }
    } catch (cause) {
      throw new Error('Could not load the riders. Check your connection and try again.', { cause })
    }
  }
  private key(id: string): string {
    return this.appearance(id)?.key ?? 'default'
  }
  private assign(id: string, actor: DuelActor, key: string): void {
    for (const track of this.tracks) {
      actor.model.anim?.baseLayer?.assignAnimation(track.name, track)
    }
    // The authored aim poses share the outfit rig. Native masking leaves locomotion below
    // the abdomen untouched, and zero weight restores the shooting/reload base layer.
    const anim = actor.model.anim
    const aim = anim?.addLayer('Aim pitch', 0)
    if (aim) {
      aim.mask = { 'Armature/Root/Hips/Abdomen': { children: true } }
    }
    for (const track of this.tracks.filter((candidate) => candidate.name.startsWith('Aim_'))) {
      aim?.assignAnimation(track.name, track, 1, true)
    }
    if (anim) {
      anim.normalizeWeights = false
      anim.rebind()
    }
    this.ragdolls.release(id)
    this.actors.get(id)?.actor.destroy()
    this.actors.set(id, {
      actor,
      head: actor.model.findByName('Head'),
      key,
      clip: '',
      firingUntil: 0,
      initialized: false,
      dead: false,
      aim,
    })
  }
  private ensure(id: string, initial = false): Promise<void> | undefined {
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
      if (this.lifecycle.signal.aborted || !this.present.has(id) || this.key(id) !== key) {
        actor.destroy()
        return
      }
      this.assign(id, actor, key)
      this.failures.delete(id)
      this.notice.hidden = this.failures.size === 0
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
  update(players: ReadonlyMap<string, PlayerState>, dt: number, firstPersonId?: string): void {
    this.present = new Set(players.keys())
    for (const id of this.failures.keys()) {
      if (!players.has(id)) {
        this.failures.delete(id)
      }
    }
    this.notice.hidden = this.failures.size === 0
    for (const [id, player] of players) {
      void this.ensure(id)
      const rider = this.actors.get(id)
      if (!rider) {
        continue
      }
      const { actor } = rider
      actor.root.enabled = id !== firstPersonId || player.hp > 0
      // Use the same native animated body and weapon in first person. Collapsing the head bone
      // also hides its mounted hat, while retaining authored arms, clothing and gun animation.
      const scale = id === firstPersonId ? 0.0001 : 1
      rider.head?.setLocalScale(scale, scale, scale)
      if (!rider.initialized) {
        actor.place(player.x, player.y - 0.9, player.z)
        rider.initialized = true
      }
      const current = actor.root.getPosition()
      const blend = id === firstPersonId ? 1 : 1 - Math.exp(-18 * dt)
      actor.place(
        current.x + (player.x - current.x) * blend,
        current.y + (player.y - 0.9 - current.y) * blend,
        current.z + (player.z - current.z) * blend,
      )
      actor.face((player.yaw * 180) / Math.PI + 180)
      if (id === firstPersonId && player.hp > 0) {
        Actors.placeFirstPerson(actor, player)
      }
      if (player.hp <= 0 && !rider.dead) {
        this.ragdolls.capture(id, actor, new Vec3(player.vx, player.vy + 0.4, player.vz))
        rider.dead = true
      } else if (player.hp > 0 && rider.dead) {
        this.ragdolls.release(id)
        rider.dead = false
      }
      Actors.animate(rider, player, {
        first: id === firstPersonId,
        domain: this.world()?.players[Number(id)] ?? undefined,
      })
    }
    this.removeDeparted(players)
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
  private static placeFirstPerson(actor: DuelActor, player: PlayerState): void {
    // A native camera-relative body keeps the existing authored arms and equipped weapon
    // below the eye at every look angle, without constructing a second view-model mesh.
    viewRotation.setFromEulerAngles((player.pitch * 180) / Math.PI, (player.yaw * 180) / Math.PI, 0)
    bodyOffset.set(0, -1.55, 0)
    viewRotation.transformVector(bodyOffset, bodyOffset)
    actor.place(player.x + bodyOffset.x, player.y + 0.65 + bodyOffset.y, player.z + bodyOffset.z)
    actor.root.setRotation(bodyRotation.copy(viewRotation).mul(facing))
  }
  private static animate(
    rider: Rider,
    player: PlayerState,
    options: { first: boolean; domain: Player | undefined },
  ): void {
    const { actor } = rider
    const speed = Math.hypot(player.vx, player.vz)
    if (rider.aim) {
      const pose = player.pitch >= 0 ? 'Aim_Up' : 'Aim_Down'
      if (rider.aim.activeState !== pose) {
        rider.aim.play(pose)
      }
      rider.aim.weight =
        !options.first && player.hp > 0 ? Math.min(1, Math.abs(player.pitch) / 1.45) : 0
    }
    let clip = 'Idle'
    if (player.hp <= 0) {
      clip = 'Death'
    } else if (performance.now() < rider.firingUntil) {
      clip = 'Gun_Shoot'
    } else if ((options.domain?.reloadTicks ?? 0) > 0) {
      clip = 'Reload'
    } else if (options.first) {
      clip = 'Idle_Gun_Pointing'
    } else if (!player.grounded) {
      clip = 'Jump_Loop'
    } else if (options.domain?.crouched || (player.motion?.slideTicks ?? 0) > 0) {
      clip = speed > 0.1 ? 'Crouch_Walk' : 'Crouch_Idle'
    } else if (speed > 6) {
      clip = 'Sprint'
    } else if (speed > 3) {
      clip = 'Run'
    } else if (speed > 0.1) {
      clip = 'Walk'
    }
    if (clip !== rider.clip) {
      actor.play(clip)
      rider.clip = clip
    }
  }
  fire(id: string): void {
    const rider = this.actors.get(id)
    if (rider) {
      rider.firingUntil = performance.now() + 200
      rider.actor.play('Gun_Shoot', 0.03)
      rider.clip = 'Gun_Shoot'
    }
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
    this.failures.clear()
    this.pending.clear()
    this.tracks = []
    this.notice.remove()
    for (const [id, rider] of this.actors) {
      this.ragdolls.release(id)
      rider.actor.destroy()
    }
    this.actors.clear()
  }
}
