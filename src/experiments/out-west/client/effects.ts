import { type Asset, Color, Entity, StandardMaterial, Vec3 } from 'playcanvas'
import { canFire, pressed } from '../ffa/sim/combat.ts'
import type { Player, SimEvent } from '../ffa/sim/types.ts'
import { haptic } from '../platform/haptics.ts'
import { Buttons, type PlayerInput } from '../runtime/protocol.ts'
import { getSettings } from '../settings.ts'
import type { GameApplication } from './application.ts'

/** Engine sound components and short-lived entities present confirmed game events. */
export class GameEffects {
  private readonly game: GameApplication
  private readonly material = new StandardMaterial()
  private readonly tracers: { entity: Entity; life: number }[] = []
  private readonly emitters = new Map<number, Entity>()
  private readonly soundAssets = new Map<string, Asset>()
  private readonly abort = new AbortController()
  private readonly start = new Vec3()
  private readonly end = new Vec3()
  readonly ready: Promise<void>
  private readonly predicted = new Map<number, number>()
  private lastButtons = 0
  private nextShot = 0
  constructor(game: GameApplication) {
    this.game = game
    this.material.diffuse = new Color(1, 0.77, 0.3)
    this.material.emissive = new Color(1, 0.65, 0.15)
    this.material.useLighting = false
    this.material.update()
    game.camera.addComponent('audiolistener')
    const sounds: Promise<unknown>[] = []
    for (const [name, file] of [
      ['shot', 'rev_close'],
      ['reload', 'shotgun_load'],
      ['hit', 'bodyfall'],
      ['coin', 'coin'],
      ['deposit', 'deposit'],
      ['bell', 'bell'],
      ['fake0', 'crow'],
      ['fake1', 'cock'],
      ['fake2', 'door'],
      ['explosion', 'explosion'],
      ['respawn', 'respawn'],
    ] as const) {
      sounds.push(
        game
          .loadAudio(`/experiments/out-west/3d/sfx/${file}.m4a`)
          .then((asset) => {
            if (!this.abort.signal.aborted) {
              this.soundAssets.set(name, asset)
            }
          })
          .catch(() => undefined),
      )
    }
    this.ready = Promise.all(sounds).then(() => undefined)
    game.app.on('update', this.update)
    globalThis.addEventListener('pointerup', () => void game.app.soundManager.resume(), {
      signal: this.abort.signal,
    })
    globalThis.addEventListener('keydown', () => void game.app.soundManager.resume(), {
      signal: this.abort.signal,
    })
  }
  event(event: SimEvent): void {
    if (event.type === 'shot') {
      this.trace(event.origin, event.end)
      for (const endpoint of event.pellets) {
        this.trace(event.origin, endpoint)
      }
      if ((this.predicted.get(event.shooter) ?? 0) < performance.now()) {
        this.play(event.shooter, 'shot', event.origin)
      }
    } else if (event.type === 'showdown_call') {
      this.play(-1, 'bell', this.game.camera.getPosition())
    } else if (event.type === 'showdown_fake') {
      this.play(-1, `fake${event.cue % 3}`, this.game.camera.getPosition())
    } else if (event.type === 'explosion') {
      this.play(event.by, 'explosion', { x: event.x, y: 0.5, z: event.z })
    } else if (event.type === 'kill') {
      this.play(-1, 'hit', this.game.camera.getPosition())
    } else if (event.type === 'deposit') {
      this.play(event.player, 'deposit', this.game.camera.getPosition())
    } else if (event.type === 'respawn') {
      this.play(event.player, 'respawn', this.game.camera.getPosition())
    }
  }
  predictShot(player: Player | null | undefined, input: PlayerInput): boolean {
    const pulled =
      pressed(input.buttons, this.lastButtons, Buttons.fire) || Boolean(player?.fireQueued)
    this.lastButtons = input.buttons
    if (!(player && canFire(player, pulled, player.alive)) || performance.now() < this.nextShot) {
      return false
    }
    this.nextShot = performance.now() + 280
    this.predicted.set(player.id, performance.now() + 250)
    this.play(player.id, 'shot', { x: player.x, y: player.y + 1.5, z: player.z })
    if (getSettings().vibration) {
      haptic('shot')
    }
    return true
  }
  private trace(
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
  ): void {
    if (this.tracers.length >= 48) {
      return
    }
    this.start.set(from.x, from.y, from.z)
    this.end.set(to.x, to.y, to.z)
    const entity = new Entity('bullet-trace', this.game.app)
    entity.addComponent('render', {
      type: 'box',
      material: this.material,
      castShadows: false,
      receiveShadows: false,
    })
    entity.setPosition((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2)
    entity.lookAt(this.end)
    entity.setLocalScale(0.018, 0.018, this.start.distance(this.end))
    this.game.stage.addChild(entity)
    this.tracers.push({ entity, life: 0.055 })
  }
  private play(id: number, name: string, position: { x: number; y: number; z: number }): void {
    const asset = this.soundAssets.get(name)
    if (!asset) {
      return
    }
    let entity = this.emitters.get(id)
    if (!entity) {
      entity = new Entity(`sound-${id}`, this.game.app)
      entity.addComponent('sound', { positional: true, refDistance: 5, maxDistance: 65 })
      this.game.stage.addChild(entity)
      this.emitters.set(id, entity)
    }
    entity.setPosition(position.x, position.y, position.z)
    const sound = entity.sound
    if (!sound) {
      return
    }
    if (!sound.slot(name)) {
      sound.addSlot(name, { asset: asset.id, overlap: true, volume: 0.7 })
    }
    const slot = sound.slot(name)
    if (slot) {
      slot.volume = name === 'bell' ? 1 : getSettings().sfx * 0.7
    }
    sound.play(name)
  }
  private readonly update = (dt: number): void => {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tracer = this.tracers[i]
      if (!tracer) {
        continue
      }
      tracer.life -= dt
      if (tracer.life <= 0) {
        tracer.entity.destroy()
        this.tracers.splice(i, 1)
      }
    }
  }
  destroy(): void {
    this.abort.abort()
    this.game.app.off('update', this.update)
    for (const tracer of this.tracers) {
      tracer.entity.destroy()
    }
    for (const emitter of this.emitters.values()) {
      emitter.destroy()
    }
    this.tracers.length = 0
    this.emitters.clear()
    this.material.destroy()
  }
}
