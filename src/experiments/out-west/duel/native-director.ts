import type { AudioEngine } from '../audio/audio.ts'
import type { GameApplication } from '../client/application.ts'
import { DEFAULT_LOADOUT, type Loadout } from '../data/catalog.ts'
import type { Dyes } from '../data/dye.ts'
import type { DuelOutcome } from '../data/economy.ts'
import { FEEL } from '../data/feel.ts'
import { OUTLAWS } from '../data/outlaws.ts'
import type { Input, Press } from '../engine/input.ts'
import type { Result } from '../net/leaderboard.ts'
import type { RankedSession } from '../net/ranked.ts'
import { type SaveData, save } from '../save.ts'
import { NativeDebris } from '../scene/native-debris.ts'
import { equippedActor } from '../scene/native-equipment.ts'
import { Board } from '../ui/board.ts'
import type { Hud } from '../ui/hud.ts'
import { type ClockEvents, type DuelClock, LocalDuelClock, type Verdict } from './clock.ts'
import type { DrawPlan } from './judge.ts'
import type { DuelActor } from './native-actor.ts'
import { NativeArenas } from './native-arenas.ts'
import { NativeAtmosphere } from './native-atmosphere.ts'
import { CameraRig } from './native-camera.ts'
import {
  call,
  playCue as nativeCue,
  handlePress as nativePress,
  applyVerdict as nativeVerdict,
  resolve,
  shoot,
  wait,
} from './native-combat.ts'
import { NativeDust } from './native-dust.ts'
import { clearMoments, Moments } from './native-moments.ts'
import { hubShot, lineup, posters, remotePace, update } from './native-presentation.ts'
import {
  advance,
  dailyDuel,
  finishRun,
  leaveSpecial,
  loadLevelActors,
  openBoard,
  pauseIfPlaying,
  presentLevel,
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
  | 'loading'
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
  speed = 0
  stalled = 0
  stallHeckled = false as boolean
  callTime = 0
  bellScheduled = false as boolean
  /** The perf time the scheduled bell reaches the ear; reactions count from it. */
  bellAt = 0
  steadyUntil = 0
  /** performance.now() as this frame began, before the engine's systems ran; null between frames. */
  frameStart: number | null = null
  plan: DrawPlan | null = null
  enemyAlive = true as boolean
  riflemanAlive = false as boolean
  bossPhase = 1
  hatShot = false as boolean
  handShot = false as boolean
  shots = 0
  fakes = 0
  /** He fired and missed this attempt (the grade's second chance). */
  secondChance = false as boolean
  reactionMs: number | null = null
  /** A press that came just after his hit, for the lose card only. */
  lateMs: number | null = null
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
  private readonly frameBegan = (): void => {
    this.frameStart = performance.now()
  }
  readonly arenas: NativeArenas
  readonly debris = new NativeDebris()
  readonly atmosphere: NativeAtmosphere
  readonly rig: CameraRig
  readonly dust: NativeDust
  /** Per-attempt presentation (camera beats, slow-mo, cards); see native-moments.ts. */
  m = new Moments()
  pushing = false as boolean
  pushStart = 0
  killOrbit = 0
  killDur: number = FEEL.killCamSeconds
  clockInsertUntil = 0
  lastFrame = 0
  readonly game: GameApplication
  readonly c: NativeContext
  readonly connectRanked: NativeRankedConnect | null
  private loading: { stage: boolean; input: boolean } | null = null
  loadFailed = false as boolean
  private retryLoading = false as boolean
  constructor(game: GameApplication, c: NativeContext, connectRanked: NativeRankedConnect | null) {
    this.game = game
    this.arenas = new NativeArenas(game)
    this.atmosphere = new NativeAtmosphere(game)
    this.rig = new CameraRig(game.camera)
    this.dust = new NativeDust(game)
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
    this.cancelLoading()
    this.equipmentEpoch++
    this.game.app.off('update', this.tick)
    this.game.app.off('frameupdate', this.frameBegan)
    this.remote?.close()
    this.clock.dispose()
    this.c.input.dispose()
    this.board.close()
    clearMoments(this)
    this.debris.destroy()
    this.dust.destroy()
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
      this.dust.ready,
    ])
    this.player = player
    this.player.root.enabled = false
    this.hubShot('hub')
    await prepareDuelShotVisuals(this)
    this.game.app.on('frameupdate', this.frameBegan)
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
    if (levelEpoch !== this.epoch || this.lifecycle.signal.aborted || this.loading) {
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
    if (this.lifecycle.signal.aborted) {
      return
    }
    const epoch = ++this.epoch
    this.loading ??= { stage: this.game.stage.enabled, input: this.c.input.enabled }
    this.retryLoading = retry
    this.loadFailed = false
    this.enter('loading')
    this.clock.cancel()
    this.game.stage.enabled = false
    this.c.input.enabled = false
    this.c.hud.showCard({
      kind: 'info',
      title: 'LOADING',
      big: 'Next duel',
      sub: 'Preparing the scene and riders.',
      hint: '',
    })
    this.debris.reset()
    this.level = Math.max(0, Math.min(OUTLAWS.length - 1, index))
    this.duel = -1
    this.enemy?.destroy()
    this.rifleman?.destroy()
    this.enemy = null
    this.rifleman = null
    const pending: DuelActor[] = []
    try {
      const actors = await loadLevelActors(this, epoch, pending)
      if (!actors) {
        return
      }
      this.enemy = actors.enemy
      this.rifleman = actors.rifleman
      this.atmosphere.arrange(this.arenas.life)
      this.enemyAlive = true
      this.riflemanAlive = Boolean(this.rifleman)
      presentLevel(this, retry)
      this.enemy.root.enabled = true
      if (this.rifleman) {
        this.rifleman.root.enabled = true
      }
      pending.length = 0
      this.cancelLoading()
    } catch (error) {
      if (epoch === this.epoch && !this.lifecycle.signal.aborted) {
        this.enemy = null
        this.rifleman = null
        this.loadFailed = true
        this.c.input.enabled = (this.loading?.input ?? false) && !this.paused
        this.c.hud.showCard({
          kind: 'info',
          title: 'COULD NOT LOAD DUEL',
          big: 'Try again',
          sub: error instanceof Error ? error.message : 'The scene could not be prepared.',
          hint: 'Tap to retry',
        })
      }
    } finally {
      for (const actor of pending) {
        actor.destroy()
      }
    }
  }
  /** Release only this director's stage/input gate on commit, saloon return or disposal. */
  cancelLoading(): void {
    const loading = this.loading
    if (!loading) {
      return
    }
    this.loading = null
    this.loadFailed = false
    this.game.stage.enabled = loading.stage
    this.c.input.enabled = loading.input && !this.paused
  }
  wait(): void {
    if (this.phase !== 'loading') {
      wait(this)
    }
  }
  call(): void {
    call(this)
  }
  cue(cue: string): void {
    nativeCue(this, cue)
  }
  press(press: Press): void {
    if (this.phase === 'loading' && press.action !== 'pause') {
      if (this.loadFailed && !this.c.hud.menuOpen) {
        void this.startLevel(this.level, this.retryLoading)
      }
      return
    }
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
    this.frameStart = null
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
