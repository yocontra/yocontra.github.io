// biome-ignore-all lint/style/noExcessiveLinesPerFile: one cohesive module (data table / scene builder); splitting would scatter tightly coupled code. Tracked for a later split.
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: class fields are flags mutated from outside the method; Biome narrows them to their literal initializer
import { MathUtils, type Object3D, SRGBColorSpace, type Vector3 } from 'three'
import { FEEL } from '../data/feel.ts'
import { type Look, OUTLAWS, type Outlaw, RIFLEMAN_LOOK } from '../data/outlaws.ts'
import type { Press } from '../engine/input.ts'
import type { RankedSession } from '../net/ranked.ts'
import { save as persist, resetRun } from '../save.ts'
import type { Actor } from '../scene/actor.ts'
import { clamp01, easeInOutCubic } from '../scene/camera.ts'
import { castActor } from '../scene/cast.ts'
import { PortraitStudio } from '../scene/portrait.ts'
import { propObject } from '../scene/props.ts'
import { STREET } from '../scene/world.ts'
import { Board } from '../ui/board.ts'
import { drawPoster } from '../ui/poster.ts'
import { type ClockEvents, type DuelClock, LocalDuelClock } from './clock.ts'
import { clearCards } from './cues.ts'
import { coward, tickCoward } from './defeat.ts'
import { tickEnd, toEnd } from './end.ts'
import { backToBackShot, otsShot, posterShot, titleShot } from './framing.ts'
import { tickBossWound, tickDying, tickFallers, tickWin } from './outcome.ts'
import { startAmbience, tickAmbience, tickPresentation } from './present.ts'
import { RankedDuelClock } from './ranked-clock.ts'
import {
  enterBossClock,
  enterWait,
  onCall,
  onCue,
  playerShoots,
  standoffSpec,
  tickBossClock,
  tickCall,
  tickWait,
} from './standoff.ts'
import { between, type Ctx, DuelState, type Phase, V } from './state.ts'
import { onDropped, onVerdict } from './verdict.ts'
import { type DebugStats, debugText, lineup, posters } from './views.ts'
import { enterWalk, tickTurn, tickWalk } from './walk.ts'

/** Opens a ranked session (Turnstile + POST /sessions + socket), or null for practice. */
export type RankedConnect = () => Promise<RankedSession | null>

/**
 * The duel's conductor: phases, input, pause, mode (ranked or practice) and
 * the frame loop. The moments themselves live in walk, standoff, outcome,
 * defeat, framing and cues.
 */
export class Director extends DuelState {
  readonly studio: PortraitStudio
  readonly board: Board
  clock: DuelClock
  connectRanked = null as RankedConnect | null
  lineupActors: Actor[] = []
  private readonly events: ClockEvents

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
    this.clock.dispose()
    this.clock = new LocalDuelClock(this.events)
    this.c.hud.setMode('PRACTICE · not ranked')
    if (note) {
      this.c.hud.fake(note, 4000)
    }
  }

  /** Try to start a ranked run at outlaw 1; stays in practice if anything fails. */
  async tryRanked(): Promise<void> {
    const connect = this.connectRanked
    this.c.hud.setMode('PRACTICE · not ranked')
    if (!connect) {
      return
    }
    this.c.hud.setMode('connecting…')
    const session = await connect()
    // only a fresh run, before the first standoff, can become ranked
    if (!session || this.level !== 0 || this.duelId >= 0 || this.standoffSent) {
      session?.close()
      this.c.hud.setMode('PRACTICE · not ranked')
      return
    }
    this.clock.dispose()
    this.clock = new RankedDuelClock(session, this.events)
    this.c.save.run = { version: 1, duels: [], total: 0 }
    persist(this.c.save)
    this.c.hud.setPurse(0, false)
    this.c.hud.setMode('RANKED')
  }

  /** Ranked: make sure the server has this attempt's standoff (a stall or an early shot). */
  ensureStandoff(): void {
    if (!this.standoffSent) {
      this.standoffSent = true
      this.duelId = this.clock.standoff(standoffSpec(this))
    }
  }

  /** The leaderboard: bank a ranked run with a name, or just look. */
  openBoard(fromEnd: boolean): void {
    const clock = this.clock
    const total = this.c.save.run.total
    if (clock instanceof RankedDuelClock && total > 0) {
      this.board.open({
        purse: total,
        submitLabel: fromEnd ? 'Submit to leaderboard' : 'Bank this run and end it',
        submit: async (name) => {
          clock.markFinished()
          const r = await clock.session.finish(name)
          if (r.ok && !fromEnd) {
            this.setPractice('[Run banked. Practice from here.]')
          }
          return r
        },
      })
      return
    }
    this.board.open({
      note: this.ranked ? 'Earn a bounty to get on the board.' : 'Practice runs aren’t ranked.',
    })
  }

  // ------------------------------------------------------------------ flow

  /** First press on the title. */
  begin(skipIntro: boolean, rankedEligible: boolean): void {
    const a = this.c.audio
    a.playSong(this.c.save.level >= 15 ? 'boss' : 'intro')
    a.musicLevel(0, 0.2)
    a.musicLowpass(18_000, 0.1)
    startAmbience(this)
    this.c.hud.show(true)
    if (rankedEligible && this.c.save.level === 0) {
      void this.tryRanked()
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

  /** A fresh gauntlet (pause → restart, or play again): ranked again if possible. */
  restartRun(legend: boolean): void {
    const c = this.c
    this.board.close()
    c.hud.hideEnd()
    c.hud.show(true)
    resetRun(c.save, legend)
    persist(c.save)
    c.hud.setPurse(0, false)
    this.setPractice('')
    this.duelId = -1
    this.standoffSent = false
    if (!legend) {
      void this.tryRanked()
    }
    this.startLevel(0, false)
  }

  /** Every model file this outlaw (and his rifleman) needs. */
  private looksFor(o: Outlaw): Look[] {
    return o.gimmick === 'underboss' && this.c.rifle ? [o.look, RIFLEMAN_LOOK] : [o.look]
  }

  private prepare(idx: number): boolean {
    const c = this.c
    const next = OUTLAWS[idx] as Outlaw
    const looks = this.looksFor(next)
    if (!looks.every((l) => c.assets.lookLoaded(l))) {
      // Lazy-loaded per outlaw; normally prefetched a duel ahead so this is rare.
      c.hud.fake('[saddling up…]')
      return false
    }
    for (const k of [idx + 1, idx + 2]) {
      const n = OUTLAWS[k]
      for (const l of n ? this.looksFor(n) : []) {
        c.assets.lookReady(l).catch(() => undefined)
      }
    }
    return true
  }

  startLevel(i: number, retry: boolean): void {
    const c = this.c
    const idx = Math.min(Math.max(0, i), OUTLAWS.length - 1)
    if (!this.prepare(idx)) {
      Promise.all(this.looksFor(OUTLAWS[idx] as Outlaw).map((l) => c.assets.lookReady(l))).then(
        () => this.startLevel(idx, retry),
        () => undefined,
      )
      return
    }
    this.level = idx
    this.outlaw = OUTLAWS[idx] as Outlaw
    c.save.level = idx
    persist(c.save)
    c.hud.setCounter(idx, OUTLAWS.length, c.save.legend)
    c.hud.hideCard()
    c.hud.clearCaptions()
    c.hud.clearCall()
    c.hud.irisRed(false)
    c.hud.letterbox(false)
    c.physics.clear()
    clearCards(this)
    this.timeScale = 1
    this.satTarget = 1
    this.bossPhase = 1
    this.midnightBells = 0
    this.callIsScream = false
    this.setStage()
    this.spawnActors()
    if (retry) {
      c.world.apply(this.dayTo)
      this.enterCock()
      return
    }
    this.drawPosterTex(null)
    this.enter('poster')
    if (!c.save.seenPosters.includes(idx)) {
      c.save.seenPosters.push(idx)
    }
    persist(c.save)
    c.audio.musicLevel(0, 0.4)
    c.audio.musicLowpass(18_000, 0.3)
    c.hud.whipPan()
    c.audio.play('whip', { gain: 0.7 })
    if (c.save.legend && idx === 0) {
      c.hud.showCard({
        kind: 'info',
        title: 'LEGEND MODE',
        big: '2019',
        sub: 'This is how it was in 2019. Good luck.',
        hint: '',
      })
    }
    posterShot(this)
  }

  /** Music, fires, coffins and the clock for this outlaw. */
  private setStage(): void {
    const c = this.c
    const under = this.underboss
    if (this.level >= 11) {
      c.audio.preloadSong('boss')
    }
    c.audio.playSong(this.level >= 15 ? 'boss' : 'intro')
    c.world.setFires(under)
    if (under) {
      this.fireLoop ??= c.audio.loop('fire_loop', 0.5)
    } else {
      this.fireLoop?.stop()
      this.fireLoop = null
    }
    // coffins outside the undertaker: one per man you've put down
    for (const im of c.coffins) {
      im.count = Math.min(im.instanceMatrix.count, 2 + this.level)
    }
    this.dayFrom = c.world.day
    this.dayTo = this.outlaw.day
    const day = this.outlaw.day
    const hour = day < 0.5 ? 12 + Math.round(day * 12) : Math.round(day * 12)
    c.world.setClock(this.boss ? 11 : hour, this.boss ? 59 : 0)
  }

  drawPosterTex(stamp: 'coward' | 'dead' | null): void {
    const portrait = this.studio.render(this.level, this.outlaw)
    drawPoster(this.posterCanvas, this.outlaw, { index: this.level, stamp, portrait })
    this.posterTex.needsUpdate = true
  }

  private spawnActors(): void {
    const c = this.c
    this.enemy?.dispose()
    this.rifleman?.dispose()
    this.rifleman = null
    const o = this.outlaw
    this.enemy = castActor(c.assets, {
      look: o.look,
      hat: o.hat,
      hatColor: o.hatColor,
      bandana: o.bandana,
      gun: c.gun ? propObject(c.gun) : null,
      offGun: o.gimmick === 'two-guns' || o.gimmick === 'boss',
    })
    c.scene.add(this.enemy.root)
    this.enemyAlive = true
    this.riflemanAlive = false
    if (this.underboss && c.rifle) {
      const r = castActor(c.assets, {
        look: RIFLEMAN_LOOK,
        hat: 'cowboy',
        hatColor: 0x1a_14_10,
        bandana: 0x3a_2a_1a,
        rifle: propObject(c.rifle),
      })
      r.root.position.copy(STREET.saloonRoof)
      r.root.rotation.y = Math.atan2(-STREET.saloonRoof.x, -5 - STREET.saloonRoof.z)
      c.scene.add(r.root)
      this.rifleman = r
      this.riflemanAlive = true
    }
    const p = this.player
    p.root.visible = true
    p.mixer.stopAllAction()
    p.holsterGun()
    p.play('Idle', 0)
    this.resetPositions()
  }

  private resetPositions(): void {
    const p = this.player
    const e = this.enemy
    this.pDist = 0
    this.eDist = 0
    this.paces = 0
    this.speed = 0
    // the boss: face to face under the clock tower; everyone else back to back
    const [pz, ez, pr, er] = this.boss ? [44, 53, 0, Math.PI] : [-0.28, 0.28, Math.PI, 0]
    p.root.position.set(0, 0, pz)
    p.root.rotation.set(0, pr, 0)
    e?.root.position.set(0, 0, ez)
    e?.root.rotation.set(0, er, 0)
    this.c.world.focusShadow(V(0, 0, this.boss ? 48 : 0))
  }

  enterCock(): void {
    const c = this.c
    const o = this.outlaw
    this.enter('cock')
    this.dying = null
    this.standoffSent = false
    this.pianoVoice?.stop()
    this.pianoVoice = null
    c.save.attempts[this.level] = (c.save.attempts[this.level] ?? 0) + 1
    persist(c.save)
    this.resetPositions()
    this.player.root.visible = true
    this.player.holsterGun()
    this.player.play('Idle', 0.1)
    this.enemy?.holsterGun()
    this.enemy?.play('Idle', 0.1)
    if (this.enemy) {
      this.enemy.sway = o.gimmick === 'drunk' ? 1 : 0
      this.enemy.shake = o.gimmick === 'shaky' ? 0.6 : 0
    }
    this.stall = 0
    this.stallHeckled = false
    this.lastWalkTime = 0
    this.hatShot = false
    this.lastReaction = null
    this.secondChance = false
    this.targetsDown = 0
    this.vignette = FEEL.vignetteBase
    this.satTarget = 1
    c.hud.hideCard()
    c.hud.setPips(0, false)
    c.input.resetToggle()
    c.audio.play('cocking', { gain: 0.9 })
    c.audio.musicLevel(0, 0.3)
    c.audio.musicLowpass(18_000, 0.3)
    this.windLoop?.set(0.35, 0.6)
    const [lo, hi] = o.paces
    this.target = Math.max(lo, Math.min(hi, Math.round(between(lo, hi + 0.999) - 0.5)))
    clearCards(this)
    if (this.boss) {
      otsShot(this, false)
    } else {
      backToBackShot(this)
    }
  }

  enterWait(fromPause: boolean): void {
    enterWait(this, fromPause)
  }

  enterBossClock(): void {
    enterBossClock(this)
  }

  nextLevel(): void {
    this.c.hud.hideCard()
    this.timeScale = 1
    if (this.level + 1 >= OUTLAWS.length) {
      this.toEnd()
      return
    }
    this.c.save.level = this.level + 1
    persist(this.c.save)
    this.startLevel(this.level + 1, false)
  }

  toEnd(): void {
    toEnd(this)
  }

  toll(): void {
    this.c.audio.play('bell', { gain: 0.8, pos: this.c.world.bellPos, reverb: 0.6 })
    this.midnightBells++
    this.nextToll = this.realTime + 0.9
  }

  retry(): void {
    const c = this.c
    c.hud.hideCard()
    c.physics.clear()
    this.satTarget = 1
    this.timeScale = 1
    this.fallers = []
    if (this.boss && this.bossPhase === 2 && this.phase === 'lose') {
      // phase 2 restarts on its own
      this.player.root.visible = true
      this.player.holsterGun()
      this.player.play('Idle', 0.1)
      this.enemyAlive = true
      this.enemy?.play('Idle', 0.1)
      this.enemy?.holsterGun()
      c.save.attempts[this.level] = (c.save.attempts[this.level] ?? 0) + 1
      this.lastReaction = null
      this.secondChance = false
      this.dying = null
      this.enterWait(false)
      return
    }
    this.spawnActors()
    this.drawPosterTex(null)
    this.enterCock()
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

  private readonly onFire: Partial<Record<Phase, (p: Press) => void>> = {
    intro: () => this.skipIntro(),
    poster: () => {
      if (this.phaseT > 0.25 && this.c.save.seenPosters.includes(this.level)) {
        this.phaseT = FEEL.posterDuration
      }
    },
    // pointer presses during the walk are walking; a fire key is a back-shot
    walk: (p) => {
      if (p.source === 'key') {
        this.cowardNow()
      }
    },
    turn: () => this.cowardNow(),
    wait: () => this.cowardNow(),
    bossClock: () => this.cowardNow(),
    call: (p) => playerShoots(this, p),
    win: () => {
      if (this.phaseT > 0.9) {
        this.nextLevel()
      }
    },
    lose: () => this.retryAfterPress(),
    coward: () => this.retryAfterPress(),
  }

  private skipIntro(): void {
    if (this.phase === 'intro' && this.skipIntroAllowed) {
      this.startLevel(this.c.save.level, false)
    }
  }

  private retryAfterPress(): void {
    if (this.phaseT > FEEL.loseRetryPress) {
      this.retry()
    }
  }

  /** Drew before the call. Ranked: the server judges it too (and fines it). */
  private cowardNow(): void {
    if (this.ranked) {
      this.ensureStandoff()
      this.clock.shot(0, null)
    }
    coward(this, '')
  }

  onPress(p: Press): void {
    if (p.action === 'pause') {
      if (this.phase !== 'title' && this.phase !== 'end') {
        this.togglePause()
      }
      return
    }
    if (this.paused || this.c.hud.menuOpen || this.board.isOpen) {
      return
    }
    switch (p.action) {
      case 'walk':
        this.skipIntro()
        break
      case 'retry':
        if (this.phase === 'lose' || this.phase === 'coward') {
          this.retry()
        }
        break
      case 'skip':
        if (this.phase === 'poster' && this.phaseT > 0.2) {
          this.phaseT = FEEL.posterDuration
        } else {
          this.skipIntro()
        }
        break
      default:
        this.onFire[this.phase]?.(p)
        break
    }
  }

  togglePause(): void {
    const c = this.c
    if (this.paused) {
      this.paused = false
      c.hud.closeMenu()
      c.input.enabled = true
      c.audio.resume()
      const ph = this.pausedPhase
      this.pausedPhase = null
      // Practice: pausing voids the wait, a fresh W on resume, no scumming.
      // Ranked: the server's clock never stopped; its verdict stands.
      if (!this.ranked && (ph === 'wait' || ph === 'call' || ph === 'turn')) {
        this.clock.cancel()
        this.enterWait(true)
      }
      if (!this.ranked && ph === 'bossClock') {
        this.clock.cancel()
        this.enterBossClock()
      }
      return
    }
    this.paused = true
    this.pausedPhase = this.phase
    if (!this.ranked) {
      this.bellVoice?.stop()
      this.bellVoice = null
    }
    c.audio.heartbeat(0)
    c.input.enabled = false
    c.audio.suspend()
    c.hud.openMenu(c.save.settings, {
      resume: () => this.togglePause(),
      change: (s) => {
        c.save.settings = s
        persist(c.save)
        this.applySettings()
      },
      restart: () => {
        this.togglePause()
        this.restartRun(c.save.legend)
      },
      leaderboard: () => this.openBoard(false),
      remap: (_a, done) => {
        c.input.capture = (code) => {
          c.input.capture = null
          done(code)
        }
      },
    })
  }

  applySettings(): void {
    const s = this.c.save.settings
    this.c.input.toggleWalk = s.toggleWalk
    this.c.input.keys = s.keys
    this.c.hud.captions = s.captions
    this.c.rig.reduced = s.reducedMotion
    this.c.audio.setMono(s.mono)
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
    this.ticks[this.phase]?.(now, realDt)
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
    if (t >= FEEL.enemyCockDelay && t - this.lastTick < FEEL.enemyCockDelay && e) {
      this.c.audio.play('cocking', { gain: 0.8, pos: e.root.position, rate: 0.95 })
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
