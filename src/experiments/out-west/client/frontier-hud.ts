import {
  ANGLE_SCALE,
  CHANNEL_BANK,
  CHANNEL_LEAVE,
  CHANNEL_STAGE,
  CHANNEL_STRONGBOX,
  type RosterEntry,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../contract/town.ts'
import { Hud } from '../ffa/client/hud.ts'
import { Minimap } from '../ffa/client/minimap.ts'
import { Riders } from '../ffa/client/riders.ts'
import { Rounds } from '../ffa/client/round.ts'
import { Scoreboard } from '../ffa/client/scoreboard.ts'
import { loadSettings, saveSettings } from '../ffa/client/settings.ts'
import { SettingsPanel } from '../ffa/client/settings-panel.ts'
import { deadEyeReady } from '../ffa/sim/combat.ts'
import {
  DEAD_EYE_CLOSE_TICKS,
  RELOAD_TICKS,
  RIFLE_ROUNDS,
  SHOTGUN_SHELLS,
  TICK_HZ,
} from '../ffa/sim/constants.ts'
import { zoneAt } from '../ffa/sim/layout.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import { Buttons } from '../runtime/protocol.ts'
import type { FrontierSession } from './frontier-session.ts'
import type { GameViewport } from './viewport.ts'

const CHANNELS = new Map([
  [CHANNEL_BANK, 'Banking…'],
  [CHANNEL_STAGE, 'Shipping…'],
  [CHANNEL_STRONGBOX, 'Opening the strongbox…'],
  [CHANNEL_LEAVE, 'Leaving…'],
])
const WEAPONS = new Map([
  [WEAPON_REVOLVER, { label: 'REVOLVER', max: 6 }],
  [WEAPON_RIFLE, { label: 'RIFLE', max: RIFLE_ROUNDS }],
  [WEAPON_SHOTGUN, { label: 'SHOTGUN', max: SHOTGUN_SHELLS }],
])
const escaped = (name: string): string => {
  const element = document.createElement('span')
  element.textContent = name
  return element.innerHTML
}

/** Existing product HUD consumes domain state independently of the selected renderer. */
export class FrontierHud {
  readonly hud: Hud
  private readonly session: FrontierSession
  private readonly scoreboard: Scoreboard
  private readonly unsubscribe: () => void
  private readonly unsubscribeControl: () => void
  private readonly rounds: Rounds
  private readonly minimap: Minimap
  private readonly riders: Riders
  private readonly abort = new AbortController()
  private killer: string | null = null
  private readonly viewport: GameViewport
  constructor(
    root: HTMLElement,
    session: FrontierSession,
    viewport: GameViewport,
    onExit: () => void,
  ) {
    this.session = session
    this.viewport = viewport
    this.hud = new Hud(root, {
      touch: matchMedia('(pointer: coarse)').matches,
      onLeave: () => viewport.tap(Buttons.leave),
      onExit,
      onRiders: () => this.riders.open(),
      onKiller: () => {
        if (this.killer) {
          this.riders.poster(this.killer)
        }
      },
      onMenu: (open) => viewport.inputEnabled(!open),
    })
    this.scoreboard = new Scoreboard(root, {
      roster: () =>
        new Map(
          session.world.players.flatMap((player) =>
            player
              ? [
                  [
                    player.id,
                    {
                      id: player.id,
                      name: player.name,
                      level: player.level,
                      prestige: player.prestige,
                      bot: player.bot,
                      loadout: [],
                      saddlebag: player.saddlebag,
                    } as RosterEntry,
                  ],
                ]
              : [],
          ),
        ),
      you: () => session.selfSlot,
      mostWanted: () => session.world.mostWanted,
    })
    this.riders = new Riders({
      root,
      roster: () => this.roster(),
      you: () => session.selfSlot,
      lobbyId: () => session.lobbyId,
    })
    this.minimap = new Minimap(
      session.world.layout,
      matchMedia('(pointer:coarse)').matches ? 100 : 140,
    )
    this.hud.mapSlot.append(this.minimap.el)
    let settings = loadSettings()
    const panel = new SettingsPanel(
      {
        settings: () => settings,
        onChange: (value) => {
          settings = value
          saveSettings(value)
          viewport.configure(value)
        },
      },
      matchMedia('(pointer:coarse)').matches,
    )
    this.hud.menuSettings.append(panel.el)
    viewport.configure(settings)
    this.rounds = new Rounds(root, this.hud.root, {
      practice: session.practice,
      audio: null,
      you: () => session.selfSlot,
      alive: () => session.world.players[session.selfSlot]?.alive ?? false,
      carried: () => session.world.players[session.selfSlot]?.carried ?? 0,
      banked: () => session.banked,
      isBot: (id) => session.world.players[id]?.bot ?? false,
      send: (text) => session.control(text),
      feed: (text) => this.hud.feed(escaped(text), 'info'),
      onOpen: (open) => viewport.inputEnabled(!open),
      leave: () => viewport.tap(Buttons.leave),
      blocked: () => this.hud.menuOpen,
    })
    this.unsubscribeControl = session.subscribeControl((control) => this.rounds.control(control))
    this.unsubscribe = session.subscribe((event) => this.event(event))
    globalThis.addEventListener(
      'keydown',
      (raw) => {
        const event = raw as KeyboardEvent
        if (this.rounds.key(event.code)) {
          return
        }
        if (event.code === 'Escape') {
          this.hud.toggleMenu()
        }
        if (event.code === 'Tab') {
          event.preventDefault()
          this.scoreboard.show(true)
        }
      },
      { signal: this.abort.signal },
    )
    globalThis.addEventListener(
      'keyup',
      (raw) => {
        const event = raw as KeyboardEvent
        if (event.code === 'Tab') {
          this.scoreboard.show(false)
        }
      },
      { signal: this.abort.signal },
    )
  }
  private roster(): ReadonlyMap<number, RosterEntry> {
    return new Map(
      this.session.world.players.flatMap((player) =>
        player
          ? [
              [
                player.id,
                {
                  id: player.id,
                  name: player.name,
                  level: player.level,
                  prestige: player.prestige,
                  bot: player.bot,
                  loadout: [],
                  saddlebag: player.saddlebag,
                } as RosterEntry,
              ],
            ]
          : [],
      ),
    )
  }
  update(): void {
    const { world, selfSlot } = this.session
    const player = world.players[selfSlot]
    if (!player) {
      return
    }
    const wanted = world.players[world.mostWanted]
    const aim = this.viewport.aimPoint()
    const challenger = player.calledUntil > world.tick ? world.players[player.calledBy] : null
    this.minimap.draw(
      {
        self: { x: player.x, z: player.z, aim: player.aim },
        others: world.players.flatMap((person) =>
          person && person.id !== selfSlot && person.alive ? [{ x: person.x, z: person.z }] : [],
        ),
        bags: world.bags,
        strongbox: world.strongbox
          ? (world.layout.strongboxes[world.strongbox.spot] ?? null)
          : null,
        mostWanted: wanted ? { x: wanted.x, z: wanted.z, you: wanted.id === selfSlot } : null,
        callout: challenger ?? null,
        heading: aim.shooter ? (player.aim / ANGLE_SCALE) * Math.PI * 2 : null,
      },
      performance.now() / 1000,
    )
    const zone = zoneAt(world.layout, player.x, player.z)
    const duel = world.showdowns.get(player.showdown)
    const cue = duel?.phase === 'called' ? 'DRAW!' : 'Wait for the bell…'
    this.hud.banner(duel ? cue : null)
    let prompt = 'Q / CALL: challenge a rider · E / USE: interact'
    if (zone && player.carried > 0) {
      prompt = 'Hold E / USE to bank or ship your carry'
    }
    if (challenger) {
      prompt = `${challenger.name} called you out · Q / CALL to accept`
    }
    this.hud.update({
      hp: player.hp,
      ammo: player.weapon === WEAPON_REVOLVER ? player.ammo : player.weaponRounds,
      weapon: WEAPONS.get(player.weapon) ??
        WEAPONS.get(WEAPON_REVOLVER) ?? { label: 'REVOLVER', max: 6 },
      dynamite: player.dynamite > 0,
      reload: player.reloadTicks > 0 ? 1 - player.reloadTicks / RELOAD_TICKS : null,
      carried: player.carried,
      banked: this.session.banked,
      players: world.players.filter((person) => person && !person.gone).length,
      mostWanted: world.mostWanted === selfSlot,
      channel: player.channel
        ? {
            label: CHANNELS.get(player.channel.kind) ?? 'Interacting…',
            t: player.channel.ticks / player.channel.total,
          }
        : null,
      prompt,
      protectedFor: Math.max(0, (player.protectUntil - world.tick) / TICK_HZ),
      lowPower: false,
    })
    this.hud.setReticle(
      aim.x,
      aim.y,
      true,
      player.deadEyeStart >= 0
        ? Math.min(1, (world.tick - player.deadEyeStart) / DEAD_EYE_CLOSE_TICKS)
        : null,
      deadEyeReady(world, player),
    )
    this.hud.setCrosshair(aim.shooter, 4 + player.bloom, false)
    if (player.alive) {
      this.hud.alive()
    } else {
      this.hud.death(
        this.killer,
        'Your carry stays in town.',
        Math.max(0, (player.respawnTick - world.tick) / TICK_HZ),
      )
    }
  }
  private event(event: SimEvent): void {
    const { selfSlot, world } = this.session
    this.rounds.event(event)
    switch (event.type) {
      case 'damage':
        if (event.victim === selfSlot) {
          this.hud.hurt(event.amount)
        }
        if (event.attacker === selfSlot) {
          this.hud.hit(false)
        }
        break
      case 'kill': {
        const killer = world.players[event.killer]?.name ?? 'The frontier'
        const victim = world.players[event.victim]?.name ?? 'A rider'
        this.scoreboard.kill(event.killer, event.victim)
        this.hud.feed(
          `${escaped(killer)} shot ${escaped(victim)}`,
          event.killer === selfSlot ? 'you' : 'kill',
        )
        if (event.victim === selfSlot) {
          this.killer = killer
        }
        if (event.killer === selfSlot) {
          this.hud.hit(true)
          this.hud.killBanner(victim, event.bounty, false)
        }
        break
      }
      case 'deposit':
        if (event.player === selfSlot) {
          this.hud.toast(`Banked $${event.amount}`, 'gold')
        }
        break
      case 'showdown_call':
        break
      case 'showdown_end':
        this.hud.banner(null)
        break
      case 'left':
        if (event.player === selfSlot) {
          this.hud.toast('Left town')
        }
        break
      default:
        break
    }
  }
  destroy(): void {
    this.unsubscribe()
    this.unsubscribeControl()
    this.rounds.dispose()
    this.abort.abort()
    this.scoreboard.dispose()
    this.hud.dispose()
  }
}
