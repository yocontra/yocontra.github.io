import { Color, Entity, LIGHTFALLOFF_INVERSESQUARED } from 'playcanvas'
import type { GameApplication } from '../client/application.ts'
import { NativeEnvironment } from '../client/environment.ts'
import bank from '../content/bank.json' with { type: 'json' }
import depot from '../content/depot.json' with { type: 'json' }
import lightingPresets from '../content/lighting.json' with { type: 'json' }
import { ASSETS } from '../content/manifest.ts'
import mission from '../content/mission.json' with { type: 'json' }
import streetLife from '../content/street-life.json' with { type: 'json' }
import type { ArenaLife } from '../contract/ambient.ts'

export type ArenaId = 'street' | 'depot' | 'mission' | 'bank'
export type { ArenaLife, Stand } from '../contract/ambient.ts'

/** Kit bench wood tops sit 0.496151m above their authored floor. */
export function campaignSeats(life: ArenaLife, streetClearance = false): ArenaLife {
  const clearance: Readonly<Record<number, number>> = streetClearance
    ? { 4: 0.25, 6: 0.265, 8: 0.21 }
    : {}
  return {
    ...life,
    folk: life.folk.map((spot, index) => {
      if (spot.habit !== 'sit' && spot.habit !== 'whittle') {
        return spot
      }
      const floor = spot.floor ?? 0.34
      const forward = clearance[index] ?? 0
      return {
        ...spot,
        x: spot.x + Math.sin(spot.yaw) * forward,
        z: spot.z + Math.cos(spot.yaw) * forward,
        floor,
        seatY: floor + 0.496_151,
      }
    }),
  }
}
/** Inverse-square candela-ish scale for one kerosene street lantern at full night. */
const LAMP_INTENSITY = 4
const STREET: ArenaLife = campaignSeats(streetLife, true)
const ARENAS = { depot, mission, bank }
export function arenaForSlot(slot: number): ArenaId {
  if (slot >= 6 && slot <= 9) {
    return 'depot'
  }
  if (slot >= 10 && slot <= 12) {
    return 'mission'
  }
  if (slot >= 13 && slot <= 14) {
    return 'bank'
  }
  return 'street'
}
/** One authored scene is visible; ground and distant landscape remain shared across acts. */
export class NativeArenas {
  private current: Entity | null = null
  private epoch = 0
  private currentUrl = '' as string
  private requestedUrl = '' as string
  private readonly lights: Entity[] = []
  /** Lamps beside pale masonry are dimmer than street lanterns. */
  private readonly lightScales: number[] = []
  private lampIntensity = 0
  private flickerTime = 0
  private dailyDenseFog = false as boolean
  private lightingEpoch = 0
  private readonly game: GameApplication
  private readonly environment: NativeEnvironment
  id: ArenaId = 'street'
  life: ArenaLife = STREET
  constructor(game: GameApplication) {
    this.game = game
    this.environment = new NativeEnvironment(game)
    game.app.on('update', this.flicker)
  }
  /** Kerosene flames breathe independently; daylight lamps are disabled, not merely dark. */
  private readonly flicker = (dt: number): void => {
    if (this.lampIntensity <= 0) {
      return
    }
    this.flickerTime = (this.flickerTime + dt) % 600
    const t = this.flickerTime
    for (const [index, light] of this.lights.entries()) {
      if (light.light) {
        const phase = index * 1.37
        const breath = Math.sin(t * 7.3 + phase) * 0.035 + Math.sin(t * 13.1 + phase * 2.3) * 0.025
        const gutter = Math.max(0, Math.sin(t * 2.1 + phase * 3.1) - 0.93) * 0.9
        light.light.intensity =
          this.lampIntensity * (this.lightScales[index] ?? 1) * (1 + breath - gutter)
      }
    }
  }
  async show(id: ArenaId): Promise<void> {
    const epoch = ++this.epoch
    const url = id === 'street' ? '' : ASSETS[id].url
    this.requestedUrl = url
    const next = url ? await this.game.instantiate(url, `arena-${id}`) : null
    if (epoch !== this.epoch) {
      next?.destroy()
      if (url && url !== this.requestedUrl && url !== this.currentUrl) {
        this.game.releaseContainer(url)
      }
      return
    }
    const previousUrl = this.currentUrl
    this.current?.destroy()
    this.current = next
    this.currentUrl = url
    if (previousUrl && previousUrl !== url) {
      this.game.releaseContainer(previousUrl)
    }
    this.id = id
    this.environment.street(id === 'street')
    const streetRoot = this.game.stage.findByName('duel-street')
    for (const name of ['street', 'ambiance.dressing']) {
      const node = streetRoot?.findByName(name)
      if (node) {
        node.enabled = id === 'street'
      }
    }
    this.life = id === 'street' ? STREET : campaignSeats(ARENAS[id].life)
    const root = next ?? streetRoot
    if (root instanceof Entity) {
      const asset = await this.game.loadContainer(ASSETS[id === 'street' ? 'duel' : id].url)
      if (epoch !== this.epoch) {
        return
      }
      this.environment.attach(root, asset)
    }
    await this.environment.ready
    if (epoch !== this.epoch) {
      return
    }
    this.placeLamps(id)
  }
  private placeLamps(id: ArenaId): void {
    for (const light of this.lights) {
      light.destroy()
    }
    this.lights.length = 0
    this.lightScales.length = 0
    const lamps: readonly (readonly number[])[] =
      id === 'street'
        ? [
            [10.2, 2.9, 2],
            [-10.2, 2.9, 18],
          ]
        : ARENAS[id].lamps
    for (const [index, position] of lamps.entries()) {
      const light = new Entity(`arena-lamp-${index}`, this.game.app)
      light.addComponent('light', {
        type: 'omni',
        color: new Color(1, 0.66, 0.34),
        range: 9,
        intensity: 0,
        falloffMode: LIGHTFALLOFF_INVERSESQUARED,
        castShadows: false,
        enabled: false,
      })
      light.setPosition(position[0] ?? 0, position[1] ?? 0, position[2] ?? 0)
      this.game.stage.addChild(light)
      this.lights.push(light)
      this.lightScales.push(position[3] ?? 1)
    }
    this.applyLamps()
  }
  /** Follows the authored lantern curve: dark through the afternoon, full from dusk. */
  night(day: number): void {
    const preset =
      lightingPresets[Math.max(0, Math.min(lightingPresets.length - 1, Math.round(day * 20)))]
    this.lampIntensity = (preset?.lanterns ?? 0) * LAMP_INTENSITY
    this.applyLamps()
  }
  private applyLamps(): void {
    for (const [index, light] of this.lights.entries()) {
      if (light.light) {
        light.light.intensity = this.lampIntensity * (this.lightScales[index] ?? 1)
        light.light.enabled = this.lampIntensity > 0
      }
    }
  }
  async lighting(day: number, index = 0): Promise<void> {
    const epoch = ++this.lightingEpoch
    this.night(day)
    this.environment.poster(index)
    await this.environment.setTime(day)
    if (epoch !== this.lightingEpoch) {
      return
    }
    // Native PBR uses the environment atlas; lift moonlit surfaces without adding a light.
    const night = this.dailyDenseFog ? 0 : Math.max(0, Math.min(1, (day - 0.72) / 0.28))
    this.game.app.scene.skyboxIntensity = 0.7 * (1 + night)
    this.environment.clock(day, index === 16)
  }
  toll(): void {
    this.environment.toll()
  }
  clockFace() {
    return this.environment.clockFace()
  }
  posterAnchor() {
    return this.environment.posterAnchor()
  }
  posterImage() {
    return this.environment.posterImage()
  }
  stampPoster(index: number, stamp: 'coward' | 'dead' | null): void {
    this.environment.poster(index, stamp)
  }
  posterPortrait(index: number, print: HTMLCanvasElement): void {
    this.environment.portrait(index, print)
  }
  dailyFog(enabled: boolean): void {
    this.dailyDenseFog = enabled
    this.environment.dailyFog(enabled)
  }
  destroy(): void {
    this.game.app.off('update', this.flicker)
    this.lightingEpoch++
    this.epoch++
    this.environment.destroy()
    this.current?.destroy()
    if (this.currentUrl) {
      this.game.releaseContainer(this.currentUrl)
    }
    for (const light of this.lights) {
      light.destroy()
    }
    this.lights.length = 0
  }
}
