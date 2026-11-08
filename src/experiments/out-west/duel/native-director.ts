import type { AudioEngine } from '../audio/audio.ts'
import type { GameApplication } from '../client/application.ts'
import { ASSETS, DYNAMIC_ASSETS } from '../content/manifest.ts'
import { DEFAULT_LOADOUT, type Loadout } from '../data/catalog.ts'
import type { Dyes } from '../data/dye.ts'
import { type DuelOutcome, money } from '../data/economy.ts'
import { OUTLAWS } from '../data/outlaws.ts'
import type { Input, Press } from '../engine/input.ts'
import type { Result } from '../net/leaderboard.ts'
import type { RankedSession } from '../net/ranked.ts'
import { type SaveData, save } from '../save.ts'
import { NativeDebris } from '../scene/native-debris.ts'
import { attachHeldWeapon, equippedActor } from '../scene/native-equipment.ts'
import { Board } from '../ui/board.ts'
import type { Hud } from '../ui/hud.ts'
import { type ClockEvents, type DuelClock, LocalDuelClock, type Verdict } from './clock.ts'
import type { DrawPlan } from './judge.ts'
import { DuelActor } from './native-actor.ts'
import { arenaForSlot, NativeArenas } from './native-arenas.ts'
import { NativeAtmosphere } from './native-atmosphere.ts'
import {
  call,
  playCue as nativeCue,
  handlePress as nativePress,
  applyVerdict as nativeVerdict,
  resolve,
  shoot,
  wait,
} from './native-combat.ts'
import { hubShot, lineup, posters, remotePace, update } from './native-presentation.ts'
import {
  advance,
  dailyDuel,
  finishRun,
  leaveSpecial,
  openBoard,
  pauseIfPlaying,
  restartRun,
  resume,
  retry as retryLevel,
  saloon,
  togglePause,
} from './native-progress.ts'
import { prepareDuelShotVisuals } from './native-shot.ts'
import { RankedDuelClock } from './ranked-clock.ts'

export type NativeRankedConnect = () => Promise<Result<RankedSession>>
export type NativePhase =
  | 'title'
  | 'intro'
  | 'poster'
  | 'cock'
  | 'walk'
  | 'turn'
  | 'wait'
  | 'call'
  | 'win'
  | 'lose'
  | 'coward'
  | 'bossWound'
  | 'end'
export interface NativeContext {
  save: SaveData
  input: Input
  hud: Hud
  audio: AudioEngine
}

/** Duel timing and progression are independent of the engine's presentation objects. */
export class NativeDirector {
  phase: NativePhase = 'title'
  phaseT = 0
  level = 0
  paused = false as boolean
  interluding = false as boolean
  clock: DuelClock
  readonly board: Board
  readonly events: ClockEvents
  player: DuelActor | null = null
  enemy: DuelActor | null = null
  rifleman: DuelActor | null = null
  onSaloon: (() => void) | null = null
  realTime = 0
  lineFreeAt = 0
  walkLines = 0
  epoch = 0
  duel = -1
  targetPaces = 6
  walked = 0
  stalled = 0
  callTime = 0
  bellScheduled = false as boolean
  steadyUntil = 0
  plan: DrawPlan | null = null
  enemyAlive = true as boolean
  riflemanAlive = false as boolean
  bossPhase = 1
  hatShot = false as boolean
  handShot = false as boolean
  shots = 0
  fakes = 0
  reactionMs: number | null = null
  exitDuel: ((verdict: Verdict | null, ms: number | null) => void) | null = null
  dailyModifiers: readonly string[] = []
  dailyVerdict: Verdict | null = null
  specialSave: SaveData | null = null
  remote: {
    tick: (now: number, dt: number) => void
    press: (p: Press) => void
    close: () => void
    pause: () => void
  } | null = null
  readonly lifecycle = new AbortController()
  readonly tick = (dt: number): void => this.update(dt)
  readonly arenas: NativeArenas
  readonly debris = new NativeDebris()
  readonly atmosphere: NativeAtmosphere
  readonly game: GameApplication
  readonly c: NativeContext
  readonly connectRanked: NativeRankedConnect | null
  constructor(game: GameApplication, c: NativeContext, connectRanked: NativeRankedConnect | null) {
    this.game = game
    this.arenas = new NativeArenas(game)
    this.atmosphere = new NativeAtmosphere(game)
    this.c = c
    this.connectRanked = connectRanked
    this.board = new Board(c.hud.root)
    this.events = {
      cue: (_duel, cue) => this.cue(cue),
      call: (duel) => {
        if (duel === this.duel) {
          this.call()
        }
      },
      verdict: (verdict) => this.verdict(verdict),
      dropped: (reason) => {
        if (this.exitDuel) {
          this.c.hud.fake(reason, 3000)
          this.leaveSpecial()
          return
        }
        this.practice(reason)
        if (this.phase === 'wait' || this.phase === 'call') {
          this.wait()
        }
      },
      reconnecting: (on) => c.hud.setMode(on ? 'RECONNECTING…' : 'RANKED'),
      resumed: (purse) => {
        c.save.run.total = purse
        c.hud.setPurse(purse, false)
        this.wait()
      },
    }
    this.clock = new LocalDuelClock(this.events)
    c.input.on((press) => this.press(press))
    c.hud.pauseBtn.addEventListener('click', () => this.togglePause(), {
      signal: this.lifecycle.signal,
    })
    this.applySettings()
  }
  dispose(): void {
    if (this.lifecycle.signal.aborted) {
      return
    }
    this.lifecycle.abort()
    this.epoch++
    this.equipmentEpoch++
    this.game.app.off('update', this.tick)
    this.remote?.close()
    this.clock.dispose()
    this.c.input.dispose()
    this.board.close()
    this.debris.destroy()
    this.arenas.destroy()
    this.atmosphere.destroy()
    this.player?.destroy()
    this.enemy?.destroy()
    this.rifleman?.destroy()
    this.leaveSpecial()
  }
  get outlaw() {
    const outlaw = OUTLAWS[this.level] ?? OUTLAWS[0]
    if (!outlaw) {
      throw new Error('The outlaw roster is empty')
    }
    return outlaw
  }
  get ranked(): boolean {
    return this.clock.ranked
  }
  get daily(): boolean {
    return this.exitDuel !== null
  }
  async initialize(): Promise<void> {
    const [player] = await Promise.all([
      equippedActor(this.game, DEFAULT_LOADOUT),
      this.atmosphere.load(),
      this.debris.ready,
    ])
    this.player = player
    this.player.root.enabled = false
    this.hubShot('hub')
    await prepareDuelShotVisuals(this)
    this.game.app.on('update', this.tick)
  }
  applySettings(): void {
    this.c.input.toggleWalk = this.c.save.settings.toggleWalk
    this.c.input.keys = this.c.save.settings.keys
    this.c.hud.captions = this.c.save.settings.captions
    this.c.audio.setMono(this.c.save.settings.mono)
  }
  enter(phase: NativePhase): void {
    this.phase = phase
    this.phaseT = 0
    this.c.hud.phase(phase)
    this.c.audio.hushUi(phase === 'wait' || phase === 'call')
  }
  async begin(skipIntro: boolean, rankedEligible: boolean): Promise<void> {
    this.remote?.close()
    this.remote = null
    this.leaveSpecial()
    this.practice('')
    const epoch = ++this.epoch
    this.level = this.c.save.level
    this.c.hud.show(true)
    this.c.hud.hideEnd()
    this.c.audio.playSong('intro')
    if (rankedEligible && this.level === 0 && !this.c.save.legend && this.connectRanked) {
      this.c.hud.setMode('CONNECTING…')
      const result = await this.connectRanked()
      if (epoch !== this.epoch) {
        if (result.ok) {
          result.value.close()
        }
        return
      }
      if (result.ok) {
        this.clock.dispose()
        this.clock = new RankedDuelClock(result.value, this.events)
        this.c.hud.setMode('RANKED')
      } else {
        this.c.hud.fake(result.error, 4000)
      }
    }
    this.c.save.seenIntro = true
    save(this.c.save)
    const levelEpoch = this.epoch + 1
    await this.startLevel(this.level)
    if (levelEpoch !== this.epoch || this.lifecycle.signal.aborted) {
      return
    }
    if (!skipIntro) {
      this.enter('intro')
    }
  }
  practice(note: string): void {
    this.clock.dispose()
    this.clock = new LocalDuelClock(this.events)
    this.c.hud.setMode('PRACTICE')
    if (note) {
      this.c.hud.fake(note, 4000)
    }
  }
  async startLevel(index: number, retry = false): Promise<void> {
    const epoch = ++this.epoch
    this.debris.reset()
    this.level = Math.max(0, Math.min(OUTLAWS.length - 1, index))
    this.duel = -1
    this.enemy?.destroy()
    this.rifleman?.destroy()
    this.enemy = null
    this.rifleman = null
    const asset = ASSETS[`outlaw-${this.level}` as keyof typeof ASSETS]
    const [enemy] = await Promise.all([
      DuelActor.create(this.game, asset.url, 'outlaw'),
      this.arenas.show(arenaForSlot(this.level)),
    ])
    if (epoch !== this.epoch) {
      enemy.destroy()
      return
    }
    this.enemy = enemy
    this.atmosphere.arrange(this.arenas.life)
    this.enemyAlive = true
    this.riflemanAlive = this.outlaw.gimmick === 'underboss'
    if (this.riflemanAlive) {
      const rifleman = await DuelActor.create(this.game, ASSETS.player.url, 'rifleman')
      if (epoch !== this.epoch) {
        rifleman.destroy()
        return
      }
      this.rifleman = rifleman
      rifleman.place(11, 4, 8)
      this.rifleman.face(180)
      try {
        const rifle = await attachHeldWeapon(
          this.game,
          rifleman,
          'rifle',
          DYNAMIC_ASSETS['held-rifle'].url,
        )
        if (epoch !== this.epoch) {
          rifle.destroy()
          return
        }
        rifleman.hold('rifle', true)
        rifleman.idle('Hold_rifle')
        rifleman.play('Hold_rifle', 0)
      } catch (error) {
        if (epoch !== this.epoch || this.lifecycle.signal.aborted) {
          return
        }
        throw error
      }
    }
    this.player?.root.setLocalScale(1, 1, 1)
    if (this.player) {
      this.player.root.enabled = true
    }
    this.player?.place(0, 0, -0.4)
    this.player?.face(180)
    this.player?.play('Idle')
    enemy.place(0, 0, 0.4)
    enemy.face(0)
    this.bossPhase = 1
    const night = this.outlaw.day
    await this.arenas.lighting(night, this.level)
    this.c.audio.playSong('intro')
    this.walkLines = 0
    this.walked = 0
    this.stalled = 0
    this.targetPaces =
      this.outlaw.paces[0] +
      Math.floor(Math.random() * (this.outlaw.paces[1] - this.outlaw.paces[0] + 1))
    this.c.save.attempts[this.level] = (this.c.save.attempts[this.level] ?? 0) + 1
    this.c.hud.setCounter(this.level, OUTLAWS.length, this.c.save.legend)
    this.c.hud.setPurse(this.c.save.run.total, false)
    this.c.hud.hideCard()
    this.c.hud.clearCall()
    this.c.hud.setPips(0, false)
    this.c.hud.show(true)
    this.enter(retry ? 'cock' : 'poster')
    if (!retry) {
      this.c.hud.showCard({
        kind: 'info',
        title: 'WANTED',
        big: this.outlaw?.name ?? '',
        sub: `${money(this.outlaw?.bounty ?? 0)} bounty`,
        hint: 'Hold to walk · Draw only after the call',
      })
      if (!this.c.save.seenPosters.includes(this.level)) {
        this.c.save.seenPosters.push(this.level)
      }
    }
    if (!(this.daily || this.remote)) {
      save(this.c.save)
    }
  }
  wait(): void {
    wait(this)
  }
  call(): void {
    call(this)
  }
  cue(cue: string): void {
    nativeCue(this, cue)
  }
  press(press: Press): void {
    nativePress(this, press)
  }
  shoot(press: Press): void {
    shoot(this, press)
  }
  verdict(verdict: Verdict): void {
    nativeVerdict(this, verdict)
  }
  resolve(outcome: DuelOutcome, ms: number | null, verdict?: Verdict): void {
    resolve(this, outcome, ms, verdict)
  }
  advance(): void {
    advance(this)
  }
  retry(): void {
    retryLevel(this)
  }
  restartRun(legend: boolean): void {
    restartRun(this, legend)
  }
  finishRun(): void {
    finishRun(this)
  }
  openBoard(): void {
    openBoard(this)
  }
  togglePause(): void {
    if (this.remote) {
      this.remote.pause()
      return
    }
    togglePause(this)
  }
  pauseIfPlaying(): void {
    pauseIfPlaying(this)
  }
  resume(): void {
    resume(this)
  }
  saloon(): void {
    saloon(this)
  }
  hubShot(shot: string): void {
    hubShot(this, shot)
  }
  equipmentEpoch = 0
  dress(loadout: Loadout, dyes: Dyes = {}): void {
    const epoch = ++this.equipmentEpoch
    void equippedActor(this.game, loadout, dyes)
      .then((next) => {
        if (epoch !== this.equipmentEpoch) {
          next.destroy()
          return
        }
        const old = this.player
        if (old) {
          next.root.setPosition(old.root.getPosition())
          next.root.setRotation(old.root.getRotation())
          next.root.enabled = old.root.enabled
        }
        this.player = next
        old?.destroy()
      })
      .catch((error: unknown) =>
        this.c.hud.fake(
          error instanceof Error ? error.message : 'Could not load this outfit.',
          4000,
        ),
      )
  }
  update(dt: number): void {
    update(this, dt)
  }
  dailyDuel(
    spec: { outlaw: number; modifiers: readonly string[] },
    session: RankedSession,
    exit: (verdict: Verdict | null, ms: number | null) => void,
  ): Promise<void> {
    return dailyDuel(this, spec, session, exit)
  }
  leaveSpecial(): void {
    leaveSpecial(this)
  }
  attachRemote(remote: NonNullable<NativeDirector['remote']>, clock: DuelClock): void {
    this.remote?.close()
    this.leaveSpecial()
    this.clock.dispose()
    this.clock = clock
    this.remote = remote
    this.specialSave = this.c.save
    this.c.save = structuredClone(this.c.save)
    this.c.hud.setMode('BOUNTY HUNT')
  }
  remotePace(paces: number): void {
    remotePace(this, paces)
  }
  lineup(_day = 0.3): Promise<void> {
    return lineup(this, _day)
  }
  posters(): Promise<void> {
    return posters(this)
  }
}
