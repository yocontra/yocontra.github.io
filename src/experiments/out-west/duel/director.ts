import { MathUtils, type Object3D, SRGBColorSpace, type Vector3 } from 'three'
import { FEEL } from '../data/feel.ts'
import type { Press } from '../engine/input.ts'
import type { RankedSession } from '../net/ranked.ts'
import { save as persist } from '../save.ts'
import type { Actor } from '../scene/actor.ts'
import { clamp01, easeInOutCubic } from '../scene/camera.ts'
import { PortraitStudio } from '../scene/portrait.ts'
import { Board } from '../ui/board.ts'
import { drawPoster } from '../ui/poster.ts'
import { type ClockEvents, type DuelClock, LocalDuelClock } from './clock.ts'
import { applySettings, onPress, togglePause } from './controls.ts'
import { tickCoward } from './defeat.ts'
import { tickEnd, toEnd } from './end.ts'
import { titleShot } from './framing.ts'
import { ensureStandoff, openBoard, restartRun, setPractice, tryRanked } from './mode.ts'
import { tickBossWound, tickDying, tickFallers, tickWin } from './outcome.ts'
import { startAmbience, tickAmbience, tickPresentation } from './present.ts'
import { enterCock, nextLevel, retry, startLevel } from './stage.ts'
import {
  enterBossClock,
  enterWait,
  onCall,
  onCue,
  tickBossClock,
  tickCall,
  tickWait,
} from './standoff.ts'
import { type Ctx, DuelState, type Phase } from './state.ts'
import { onDropped, onVerdict } from './verdict.ts'
import { type DebugStats, debugText, lineup, posters } from './views.ts'
import { enterWalk, tickTurn, tickWalk } from './walk.ts'

/** Opens a ranked session (Turnstile + POST /sessions + socket), or null for practice. */
export type RankedConnect = () => Promise<RankedSession | null>

/**
 * The one seam for a server-driven Bounty Hunt duel (duel/remote.ts): while installed, it may take
 * over a phase's tick or a press. Each returns true when it handled it.
 */
export interface DirectorHooks {
  tick: (phase: Phase, now: number, dt: number) => boolean
  press: (p: Press) => boolean
}

/**
 * The duel's conductor: phases, mode (ranked or practice) and the frame loop.
 * The moments themselves live in stage, walk, standoff, outcome, defeat,
 * framing and cues; input in controls; ranked/practice in mode.
 */
export class Director extends DuelState {
  readonly studio: PortraitStudio
  readonly board: Board
  clock: DuelClock
  connectRanked = null as RankedConnect | null
  /** Pause → Saloon: back to the hub without a reload (null where there's no hub). */
  onSaloon = null as (() => void) | null
  /** Bumped by every ranked attempt and every drop to practice; stale connects are closed. */
  rankedTry = 0
  lineupActors: Actor[] = []
  readonly events: ClockEvents
  hooks = null as DirectorHooks | null

  constructor(c: Ctx) {
    super(c)
    this.studio = new PortraitStudio(c.renderer.gl, c.assets)
    this.board = new Board(c.hud.root)
    this.events = {
      cue: (duel, cue) => onCue(this, duel, cue),
      call: (duel) => onCall(this, duel),
      verdict: (v) => onVerdict(this, v),
      dropped: (reason) => onDropped(this, reason),
    }
    this.clock = new LocalDuelClock(this.events)
    c.hud.setPurse(c.save.run.total, false)
    c.scene.add(this.player.root)
    this.player.root.visible = false
    drawPoster(this.posterCanvas, this.outlaw, { index: 0, stamp: null })
    this.posterTex.colorSpace = SRGBColorSpace
    this.posterTex.anisotropy = 4
    c.world.posterMat.map = this.posterTex
    c.world.posterMat.emissiveMap = this.posterTex
    c.world.posterMat.needsUpdate = true
    c.input.on((p) => this.onPress(p))
    titleShot(this)
  }

  get ranked(): boolean {
    return this.clock.ranked
  }

  // ------------------------------------------------------------------ mode

  setPractice(note: string): void {
    setPractice(this, note)
  }

  /** Ranked: make sure the server has this attempt's standoff (a stall or an early shot). */
  ensureStandoff(): void {
    ensureStandoff(this)
  }

  openBoard(fromEnd: boolean): void {
    openBoard(this, fromEnd)
  }

  /** A fresh gauntlet (pause → restart, or play again): ranked again if possible. */
  restartRun(legend: boolean): void {
    restartRun(this, legend)
  }

  // ------------------------------------------------------------------ flow

  /** First press on the title. Ranked only for a fresh, normal run at outlaw 1. */
  begin(skipIntro: boolean, rankedEligible: boolean): void {
    const a = this.c.audio
    a.playSong(this.c.save.level >= 15 ? 'boss' : 'intro')
    a.musicLevel(0, 0.2)
    a.musicLowpass(18_000, 0.1)
    startAmbience(this)
    this.c.hud.show(true)
    if (rankedEligible && this.c.save.level === 0) {
      tryRanked(this).catch(() => undefined)
    } else {
      this.c.hud.setMode('PRACTICE · not ranked')
    }
    if (skipIntro) {
      this.startLevel(this.c.save.level, false)
    } else {
      this.enter('intro')
      this.skipIntroAllowed = this.c.save.seenIntro
      titleShot(this)
    }
  }

  startLevel(i: number, isRetry: boolean): void {
    startLevel(this, i, isRetry)
  }

  drawPosterTex(stamp: 'coward' | 'dead' | null): void {
    const portrait = this.studio.render(this.level, this.outlaw)
    drawPoster(this.posterCanvas, this.outlaw, { index: this.level, stamp, portrait })
    this.posterTex.needsUpdate = true
  }

  enterCock(): void {
    enterCock(this)
  }

  enterWait(fromPause: boolean): void {
    enterWait(this, fromPause)
  }

  enterBossClock(): void {
    enterBossClock(this)
  }

  nextLevel(): void {
    nextLevel(this)
  }

  toEnd(): void {
    toEnd(this)
  }

  retry(): void {
    retry(this)
  }

  toll(): void {
    this.c.audio.play('bell', { gain: 0.8, pos: this.c.world.bellPos, reverb: 0.6 })
    this.midnightBells++
    this.nextToll = this.realTime + 0.9
  }

  turnActor(a: Actor, from: number, to: number): void {
    this.turnAnim = this.turnAnim.filter((x) => x.a !== a)
    this.turnAnim.push({ a, from, to, t0: this.realTime, dur: FEEL.callTurn })
  }

  private tickTurns(): void {
    for (const t of this.turnAnim) {
      const k = easeInOutCubic(clamp01((this.realTime - t.t0) / t.dur))
      t.a.root.rotation.y = MathUtils.lerp(t.from, t.to, k)
    }
    this.turnAnim = this.turnAnim.filter((t) => this.realTime - t.t0 < t.dur)
  }

  screenOf(v: Vector3): { x: number; y: number } {
    const p = v.clone().project(this.c.rig.cam)
    return {
      x: (p.x * 0.5 + 0.5) * globalThis.innerWidth,
      y: (-p.y * 0.5 + 0.5) * globalThis.innerHeight,
    }
  }

  // ---------------------------------------------------------------- input

  onPress(p: Press): void {
    if (!this.hooks?.press(p)) {
      onPress(this, p)
    }
  }

  togglePause(): void {
    togglePause(this)
  }

  applySettings(): void {
    applySettings(this)
  }

  pauseIfPlaying(): void {
    if (!this.paused && this.phase !== 'title' && this.phase !== 'end') {
      this.togglePause()
    }
  }

  // ----------------------------------------------------------------- frame

  private readonly ticks: Partial<Record<Phase, (now: number, dt: number) => void>> = {
    intro: () => {
      if (this.phaseT > 6) {
        this.c.save.seenIntro = true
        persist(this.c.save)
        this.startLevel(this.c.save.level, false)
      }
    },
    poster: () => this.tickPoster(),
    cock: () => this.tickCock(),
    walk: (_n, dt) => tickWalk(this, dt),
    turn: () => tickTurn(this),
    wait: (now) => tickWait(this, now),
    bossClock: (now) => tickBossClock(this, now),
    call: (now) => tickCall(this, now),
    win: (_n, dt) => tickWin(this, dt),
    bossWound: () => tickBossWound(this),
    lose: () => {
      if (this.phaseT > FEEL.loseAutoRetry) {
        this.retry()
      }
    },
    coward: () => tickCoward(this),
    end: (_n, dt) => tickEnd(this, dt),
  }

  /** Advance the duel. `now` is the rAF timestamp. Returns game dt. */
  frame(now: number, realDt: number): number {
    this.realTime += realDt
    if (this.paused) {
      this.c.rig.update(0, 0)
      return 0
    }
    this.phaseT += realDt
    if (!this.hooks?.tick(this.phase, now, realDt)) {
      this.ticks[this.phase]?.(now, realDt)
    }
    // hitstop / slow-mo; the dying man's clip never crawls below victimMinScale
    const dt = realDt * this.timeScale
    const dyingDt = this.timeScale > 0 ? realDt * Math.max(this.timeScale, FEEL.victimMinScale) : 0
    const dying = this.dying?.actor
    this.player.update(dying === this.player ? dyingDt : dt)
    this.enemy?.update(dying === this.enemy ? dyingDt : dt)
    this.rifleman?.update(dt)
    tickDying(this, dyingDt)
    tickAmbience(this, realDt)
    tickPresentation(this, realDt)
    this.tickTurns()
    tickFallers(this, dt)
    return dt
  }

  private tickPoster(): void {
    const c = this.c
    const k = easeInOutCubic(clamp01(this.phaseT / 2.5))
    c.world.apply(MathUtils.lerp(this.dayFrom, this.dayTo, k))
    if (this.phaseT >= FEEL.posterDuration) {
      c.world.apply(this.dayTo)
      const paper = c.world.poster.userData.paper as Object3D | undefined
      paper?.scale.setScalar(1)
      c.hud.hideCard()
      this.enterCock()
    }
  }

  private tickCock(): void {
    const t = this.phaseT
    const e = this.enemy
    if (t >= FEEL.enemyCockDelay && this.lastTick < FEEL.enemyCockDelay && e) {
      this.c.audio.play('cocking', { gain: 0.8, pos: e.root.position.clone(), rate: 0.95 })
    }
    if (t >= FEEL.inputEnableDelay) {
      if (this.boss) {
        this.enterBossClock()
      } else {
        enterWalk(this)
      }
    }
    this.lastTick = t
  }

  // ------------------------------------------------------------- debug views

  async lineup(day = 0.3): Promise<void> {
    this.lineupActors = await lineup(this, day)
  }

  posters(): Promise<void> {
    return posters(this, this.studio)
  }

  debugText(st: DebugStats): string {
    return debugText(this, st)
  }
}
