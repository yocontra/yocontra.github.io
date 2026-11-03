import {
  CanvasTexture,
  CylinderGeometry,
  type InstancedMesh,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type Scene,
  SRGBColorSpace,
  Vector3,
} from 'three'
import type { AudioEngine, Loop } from '../audio/audio'
import { FEEL } from '../data/feel'
import {
  ASSIST_MS,
  BOSS_PHASE2,
  BOSS_STRIKE_INTERVAL,
  type FakeKey,
  gradeFor,
  type Look,
  legendDraw,
  OUTLAWS,
  type Outlaw,
  RIFLEMAN,
  RIFLEMAN_LOOK,
} from '../data/outlaws'
import type { Assets } from '../engine/assets'
import type { Input, Press } from '../engine/input'
import type { Renderer } from '../engine/render'
import { save as persist, resetRun, type SaveData } from '../save'
import { Actor } from '../scene/actor'
import { type CameraRig, clamp01, easeInOutCubic, easeOutCubic, type Pose } from '../scene/camera'
import { castActor } from '../scene/cast'
import {
  type Dust,
  type Flash,
  type Glint,
  makeCard,
  type Physics,
  type Puffs,
  type Tumbleweed,
} from '../scene/fx'
import { PortraitStudio } from '../scene/portrait'
import { type PropDef, propObject } from '../scene/props'
import { STREET, type World } from '../scene/world'
import type { Hud } from '../ui/hud'
import { drawPoster } from '../ui/poster'
import { type DrawPlan, dueShot, type EnemyShot, planFakes, planShots, shotsBefore } from './judge'

export interface Ctx {
  scene: Scene
  world: World
  rig: CameraRig
  renderer: Renderer
  audio: AudioEngine
  hud: Hud
  input: Input
  assets: Assets
  save: SaveData
  gun: PropDef | null
  rifle: PropDef | null
  coffins: InstancedMesh[]
  dust: Dust
  puffs: Puffs
  sparks: Puffs
  flash: Flash
  glint: Glint
  physics: Physics
  tumbleweeds: Tumbleweed[]
  debug: boolean
}

type Phase =
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
  | 'bossClock'
  | 'bossWound'
  | 'end'

interface Fake {
  at: number
  kind: FakeKey
  fired: boolean
}

const FAKE_CAPTION: Record<FakeKey, string> = {
  crow: '[crow caws]',
  door: '[saloon door slams]',
  bottle: '[bottle smashes]',
  horse: '[horse whinnies]',
  coin: '[coin lands]',
  twitch: '[his hand twitches]',
  heckle: '[from the crowd] “DRR… rinks on me!”',
  piano: '[piano stops]',
  gunshot: '[distant gunshot]',
  dog: '[dog barks]',
}

const NUMBERS = [
  'ONE',
  'TWO',
  'THREE',
  'FOUR',
  'FIVE',
  'SIX',
  'SEVEN',
  'EIGHT',
  'NINE',
  'TEN',
  'ELEVEN',
  'TWELVE',
]

const rng = Math.random
const between = (a: number, b: number) => a + (b - a) * rng()
const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z)

export class Director {
  phase: Phase = 'title'
  private phaseT = 0
  level = 0
  outlaw: Outlaw = OUTLAWS[0] as Outlaw
  player: Actor
  enemy: Actor | null = null
  rifleman: Actor | null = null
  private riflemanAlive = false
  private enemyAlive = true
  timeScale = 1
  /** Render the red silhouette frame this many more frames. */
  silhouetteFrames = 0
  paused = false
  private pausedPhase: Phase | null = null
  // walk
  private speed = 0
  private paces = 0
  private target = 6
  private pDist = 0
  private eDist = 0
  private stall = 0
  private stallHeckled = false
  private lastWalkTime = 0
  // turn / wait
  private waitMs = 0
  private waitStart = 0
  private tCall = 0
  private fakes: Fake[] = []
  private bellVoice: { stop(at?: number): void } | null = null
  private bellScheduled = false
  private ecuDone = false
  private pianoStarted = false
  private callIsScream = false
  // call
  private plan: DrawPlan | null = null
  callT = 0
  lastReaction: number | null = null
  private secondChance = false
  private targetsDown = 0
  private lastPressT = 0
  private hatShot = false
  // outcomes
  private outcomeT = 0
  private resultShown = false
  private loseReason = ''
  private bossPhase = 1
  private strikes = 0
  private nextStrike = 0
  private miscountAt = -1
  private bellPreArmed = false
  // presentation
  private dayFrom = 0
  private dayTo = 0
  private vignette: number = FEEL.vignetteBase
  private satTarget = 1
  private sat = 1
  private ca = 0
  private wind = 0.35
  private windLoop: Loop | null = null
  private cricketLoop: Loop | null = null
  private fireLoop: Loop | null = null
  private ambT = 0
  private killOrbit = 1
  private killDur: number = FEEL.killCamSeconds
  private posterTex: CanvasTexture | null = null
  private posterCanvas = document.createElement('canvas')
  private cards: Object3D[] = []
  private cardT = 0
  private coin: Mesh | null = null
  private midnightBells = 0
  private endT = 0
  private skipIntroAllowed = false
  private realTime = 0

  readonly studio: PortraitStudio

  constructor(private readonly c: Ctx) {
    this.studio = new PortraitStudio(c.renderer.gl, c.assets)
    this.player = new Actor(c.assets.player, {
      gun: c.gun ? propObject(c.gun) : null,
      cloth: c.assets.cloth,
    })
    c.scene.add(this.player.root)
    this.player.root.visible = false
    drawPoster(this.posterCanvas, this.outlaw, { index: 0, stamp: null })
    this.posterTex = new CanvasTexture(this.posterCanvas)
    this.posterTex.colorSpace = SRGBColorSpace
    this.posterTex.anisotropy = 4
    c.world.posterMat.map = this.posterTex
    c.world.posterMat.emissiveMap = this.posterTex
    c.world.posterMat.needsUpdate = true
    c.input.on((p) => this.onPress(p))
    this.titleShot()
  }

  private get portrait(): boolean {
    return this.c.rig.cam.aspect < 1
  }
  /** Walk/standoff camera offset: tighter to the street axis on portrait phones so both men stay in frame. */
  private get sideOff(): number {
    return this.portrait ? 0.45 : 1.7
  }
  private get lookOff(): number {
    return this.portrait ? 0 : 0.1
  }
  private get restFov(): number {
    return this.portrait ? 56 : FEEL.fovRest
  }
  private get wideFov(): number {
    return this.portrait ? 58 : 42
  }

  private get reduced(): boolean {
    return this.c.save.settings.reducedMotion
  }

  private get total(): number {
    return OUTLAWS.length
  }

  // ------------------------------------------------------------------ flow

  private enter(p: Phase): void {
    this.phase = p
    this.phaseT = 0
  }

  /** First press on the title. */
  begin(skipIntro: boolean): void {
    const a = this.c.audio
    a.playSong(this.c.save.level >= 15 ? 'boss' : 'intro')
    a.musicLevel(0, 0.2)
    a.musicLowpass(18000, 0.1)
    this.startAmbience()
    this.c.hud.show(true)
    if (skipIntro) {
      this.startLevel(this.c.save.level, false)
    } else {
      this.enter('intro')
      this.skipIntroAllowed = this.c.save.seenIntro
      this.titleShot()
    }
  }

  private startAmbience(): void {
    const a = this.c.audio
    if (!this.windLoop) {
      this.windLoop = a.loop('wind', 0.35)
    }
    if (!this.cricketLoop) this.cricketLoop = a.loop('crickets', 0)
  }

  private titleShot(): void {
    this.c.rig.cut('title', (t) => {
      const k = easeInOutCubic(clamp01((t % 14) / 6.5))
      const back = t % 14 > 7 ? easeInOutCubic(clamp01(((t % 14) - 7) / 7)) : 0
      const e = k * (1 - back)
      return {
        pos: V(MathUtils.lerp(0.5, 2.2, e), MathUtils.lerp(19, 2.0, e), MathUtils.lerp(56, 18, e)),
        look: V(0, MathUtils.lerp(9, 1.6, e), MathUtils.lerp(0, -12, e)),
        fov: MathUtils.lerp(38, 42, e),
        handheld: 0.15,
      }
    })
  }

  /** Every model file this outlaw (and his rifleman) needs. */
  private looksFor(o: Outlaw): Look[] {
    return o.gimmick === 'underboss' ? [o.look, RIFLEMAN_LOOK] : [o.look]
  }

  startLevel(i: number, retry: boolean): void {
    const c = this.c
    const idx = Math.min(Math.max(0, i), this.total - 1)
    const next = OUTLAWS[idx] as Outlaw
    const looks = this.looksFor(next)
    if (!looks.every((l) => c.assets.lookLoaded(l))) {
      // Lazy-loaded per outlaw; normally prefetched a duel ahead so this is rare.
      c.hud.fake('[saddling up…]')
      void Promise.all(looks.map((l) => c.assets.lookReady(l))).then(() =>
        this.startLevel(idx, retry),
      )
      return
    }
    // prefetch the next two outlaws while this duel plays
    for (const k of [idx + 1, idx + 2]) {
      const n = OUTLAWS[k]
      if (n) for (const l of this.looksFor(n)) void c.assets.lookReady(l)
    }
    this.level = idx
    this.outlaw = next
    c.save.level = this.level
    persist(c.save)
    c.hud.setCounter(this.level, this.total, c.save.legend)
    c.hud.hideCard()
    c.hud.clearCaptions()
    c.hud.clearCall()
    c.hud.irisRed(false)
    c.hud.letterbox(false)
    c.physics.clear()
    this.clearCards()
    this.timeScale = 1
    this.satTarget = 1
    this.bossPhase = 1
    this.callIsScream = false
    const boss = this.outlaw.gimmick === 'boss'
    const under = this.outlaw.gimmick === 'underboss'
    if (this.level >= 11) c.audio.preloadSong('boss')
    c.audio.playSong(this.level >= 15 ? 'boss' : 'intro')
    c.world.setFires(under)
    if (under && !this.fireLoop) this.fireLoop = c.audio.loop('fire_loop', 0.5)
    if (!under && this.fireLoop) {
      this.fireLoop.stop()
      this.fireLoop = null
    }
    this.spawnActors()
    // coffins outside the undertaker: one per man you've put down
    for (const im of c.coffins) im.count = Math.min(im.instanceMatrix.count, 2 + this.level)
    this.dayFrom = c.world.day
    this.dayTo = this.outlaw.day
    if (boss) c.world.setClock(11, 59)
    else
      c.world.setClock(
        this.outlaw.day < 0.5
          ? 12 + Math.round(this.outlaw.day * 12)
          : Math.round(this.outlaw.day * 12),
        0,
      )
    const seen = c.save.seenPosters.includes(this.level)
    if (retry) {
      c.world.apply(this.dayTo)
      this.enterCock()
      return
    }
    this.drawPosterTex(null)
    this.enter('poster')
    if (!seen) c.save.seenPosters.push(this.level)
    persist(c.save)
    c.audio.musicLevel(0, 0.4)
    c.audio.musicLowpass(18000, 0.3)
    c.hud.whipPan()
    c.audio.play('whip', { gain: 0.7 })
    if (c.save.legend && this.level === 0) {
      c.hud.showCard('info', 'LEGEND MODE', '2019', 'This is how it was in 2019. Good luck.', '')
    }
    this.posterShot()
  }

  private drawPosterTex(stamp: 'coward' | 'dead' | null): void {
    const portrait = this.studio.render(this.level, this.outlaw)
    drawPoster(this.posterCanvas, this.outlaw, { index: this.level, stamp, portrait })
    if (this.posterTex) this.posterTex.needsUpdate = true
  }

  private posterShot(): void {
    const pp = STREET.posterPos
    const paper = this.c.world.poster.userData['paper'] as Object3D | undefined
    this.c.rig.cut('poster', (t) => {
      const k = easeOutCubic(clamp01(t / 2.2))
      if (paper) {
        const s = t < FEEL.posterSlam ? 1.35 - 0.35 * easeOutCubic(t / FEEL.posterSlam) : 1
        paper.scale.setScalar(s)
      }
      const d = MathUtils.lerp(2.1, 1.35, k)
      return {
        pos: V(pp.x + 0.12 + d, 1.75, pp.z + 0.02),
        look: V(pp.x + 0.12, 1.75, pp.z),
        fov: 35,
        handheld: 0.2,
      }
    })
  }

  private spawnActors(): void {
    const c = this.c
    this.enemy?.dispose()
    this.rifleman?.dispose()
    this.rifleman = null
    const o = this.outlaw
    const gun = c.gun ? propObject(c.gun) : null
    this.enemy = castActor(c.assets, {
      look: o.look,
      hat: o.hat,
      hatColor: o.hatColor,
      bandana: o.bandana,
      gun,
      offGun: o.gimmick === 'two-guns' || o.gimmick === 'boss',
    })
    c.scene.add(this.enemy.root)
    this.enemyAlive = true
    this.riflemanAlive = false
    if (o.gimmick === 'underboss' && c.rifle) {
      const r = castActor(c.assets, {
        look: RIFLEMAN_LOOK,
        hat: 'cowboy',
        hatColor: 0x1a1410,
        bandana: 0x3a2a1a,
        rifle: propObject(c.rifle),
      })
      r.root.position.copy(STREET.saloonRoof)
      r.root.rotation.y = Math.atan2(0 - STREET.saloonRoof.x, -5 - STREET.saloonRoof.z)
      c.scene.add(r.root)
      this.rifleman = r
      this.riflemanAlive = true
    }
    // player
    const p = this.player
    p.root.visible = true
    p.mixer.stopAllAction()
    p.holsterGun()
    p.play('Idle', 0)
    this.resetPositions()
  }

  private resetPositions(): void {
    const boss = this.outlaw.gimmick === 'boss'
    const p = this.player
    const e = this.enemy
    this.pDist = 0
    this.eDist = 0
    this.paces = 0
    this.speed = 0
    if (boss) {
      // Face to face under the clock tower.
      p.root.position.set(0, 0, 44)
      p.root.rotation.set(0, 0, 0)
      e?.root.position.set(0, 0, 53)
      e?.root.rotation.set(0, Math.PI, 0)
    } else {
      p.root.position.set(0, 0, -0.28)
      p.root.rotation.set(0, Math.PI, 0)
      e?.root.position.set(0, 0, 0.28)
      e?.root.rotation.set(0, 0, 0)
    }
    p.root.rotation.z = 0
    p.root.rotation.x = 0
    if (e) {
      e.root.rotation.x = 0
      e.root.rotation.z = 0
    }
    this.c.world.focusShadow(V(0, 0, boss ? 48 : 0))
  }

  private enterCock(): void {
    const c = this.c
    const o = this.outlaw
    this.enter('cock')
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
    c.audio.musicLowpass(18000, 0.3)
    this.windLoop?.set(0.35, 0.6)
    const [lo, hi] = o.paces
    this.target = Math.round(between(lo, hi + 0.999) - 0.5)
    this.target = Math.max(lo, Math.min(hi, this.target))
    this.clearCards()
    if (o.gimmick === 'boss') {
      this.bossShot()
    } else {
      this.backToBackShot()
    }
  }

  private backToBackShot(): void {
    this.c.rig.cut(
      'b2b',
      (t) => ({
        pos: V(3.4 - Math.min(t, 3) * 0.12, 1.15, 0.4),
        look: V(0, 1.15, 0),
        fov: 38,
        handheld: 0.3,
      }),
      0,
    )
  }

  // ---------------------------------------------------------------- input

  onPress(p: Press): void {
    const c = this.c
    if (p.action === 'pause') {
      if (this.phase === 'title' || this.phase === 'end') return
      this.togglePause()
      return
    }
    if (this.paused || c.hud.menuOpen) return
    if (p.action === 'walk') {
      if (this.phase === 'intro' && this.skipIntroAllowed) this.startLevel(c.save.level, false)
      return
    }
    if (p.action === 'retry') {
      if (this.phase === 'lose' || this.phase === 'coward') this.retry()
      return
    }
    if (p.action === 'skip') {
      if (this.phase === 'poster' && this.phaseT > 0.2) this.skipPoster()
      else if (this.phase === 'intro' && this.skipIntroAllowed) this.startLevel(c.save.level, false)
      return
    }
    // fire (key) or any pointer press
    switch (this.phase) {
      case 'intro':
        if (this.skipIntroAllowed) this.startLevel(c.save.level, false)
        break
      case 'poster':
        if (this.phaseT > 0.25 && c.save.seenPosters.includes(this.level)) this.skipPoster()
        break
      case 'walk':
        // Pointer presses during the walk are walking; a fire key is a back-shot.
        if (p.source === 'key') this.coward()
        break
      case 'turn':
      case 'wait':
        this.coward()
        break
      case 'bossClock':
        this.coward()
        break
      case 'call':
        this.playerShoots(p)
        break
      case 'win':
        if (this.phaseT > 0.9) this.nextLevel()
        break
      case 'lose':
        if (this.phaseT > FEEL.loseRetryPress) this.retry()
        break
      case 'coward':
        if (this.phaseT > 1.0) this.retry()
        break
      default:
        break
    }
  }

  private skipPoster(): void {
    this.phaseT = FEEL.posterDuration
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
      // Pausing voids the wait: a fresh W on resume, no scumming.
      if (ph === 'wait' || ph === 'call' || ph === 'turn') this.enterWait(true)
      if (ph === 'bossClock') this.enterBossClock()
      return
    }
    this.paused = true
    this.pausedPhase = this.phase
    this.bellVoice?.stop()
    this.bellVoice = null
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
        resetRun(c.save, c.save.legend)
        persist(c.save)
        this.startLevel(0, false)
      },
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
    if (!this.paused && this.phase !== 'title' && this.phase !== 'end') this.togglePause()
  }

  // ----------------------------------------------------------------- frame

  /** Advance the duel. `now` is the rAF timestamp. Returns game dt. */
  frame(now: number, realDt: number): number {
    this.realTime += realDt
    const c = this.c
    if (this.paused) {
      c.rig.update(0, 0)
      return 0
    }
    this.phaseT += realDt
    switch (this.phase) {
      case 'title':
        break
      case 'intro':
        if (this.phaseT > 6) {
          c.save.seenIntro = true
          persist(c.save)
          this.startLevel(c.save.level, false)
        }
        break
      case 'poster':
        this.tickPoster()
        break
      case 'cock':
        this.tickCock()
        break
      case 'walk':
        this.tickWalk(realDt)
        break
      case 'turn':
        this.tickTurn()
        break
      case 'wait':
        this.tickWait(now)
        break
      case 'bossClock':
        this.tickBossClock(now)
        break
      case 'call':
        this.tickCall(now)
        break
      case 'win':
        this.tickWin(realDt)
        break
      case 'bossWound':
        this.tickBossWound()
        break
      case 'lose':
        if (this.phaseT > FEEL.loseAutoRetry) this.retry()
        break
      case 'coward':
        if (this.phaseT > FEEL.cowardAutoRetry) this.retry()
        break
      case 'end':
        this.tickEnd(realDt)
        break
    }
    // hitstop / slow-mo
    const dt = realDt * this.timeScale
    this.player.update(dt)
    this.enemy?.update(dt)
    this.rifleman?.update(dt)
    this.tickAmbience(realDt)
    this.tickPresentation(realDt)
    this.tickCards(dt)
    return dt
  }

  private tickPoster(): void {
    const c = this.c
    const k = easeInOutCubic(clamp01(this.phaseT / 2.5))
    c.world.apply(MathUtils.lerp(this.dayFrom, this.dayTo, k))
    if (this.phaseT >= FEEL.posterDuration) {
      c.world.apply(this.dayTo)
      const paper = c.world.poster.userData['paper'] as Object3D | undefined
      paper?.scale.setScalar(1)
      c.hud.hideCard()
      this.enterCock()
    }
  }

  private tickCock(): void {
    const c = this.c
    const t = this.phaseT
    if (t >= FEEL.enemyCockDelay && t - this.lastTick < FEEL.enemyCockDelay && this.enemy) {
      c.audio.play('cocking', { gain: 0.8, pos: this.enemy.root.position, rate: 0.95 })
    }
    if (t >= FEEL.inputEnableDelay) {
      if (this.outlaw.gimmick === 'boss') this.enterBossClock()
      else this.enterWalk()
    }
    this.lastTick = t
  }
  private lastTick = 0

  private enterWalk(): void {
    this.enter('walk')
    this.c.hud.setPips(0, true)
    this.c.audio.musicLevel(0, 0.6)
    this.walkShot()
    if (this.outlaw.gimmick === 'windy') this.wind = 0.4
  }

  private walkShot(): void {
    const p = this.player
    this.c.rig.cut(
      'walk',
      () => {
        const P = p.root.position
        return {
          pos: V(P.x + this.sideOff, 1.2, P.z - 3.4),
          look: V(P.x, 1.15, P.z + 1.2),
          fov: this.wideFov,
          handheld: 0.25,
        }
      },
      1.4,
    )
  }

  private tickWalk(dt: number): void {
    const c = this.c
    const o = this.outlaw
    const want = c.input.walking ? 1 : 0
    const rate = dt / FEEL.walkRamp
    this.speed = want > this.speed ? Math.min(1, this.speed + rate) : Math.max(0, this.speed - rate)
    const p = this.player
    const e = this.enemy
    const cadence = p.walkDuration / 2 / FEEL.paceSeconds
    p.locomote(this.speed, cadence)
    const pStep = (this.speed * p.paceLength * dt) / FEEL.paceSeconds
    this.pDist += pStep
    p.root.position.z = -0.28 - this.pDist
    // pace counting on heel strikes
    const wt = p.walkTime
    if (this.speed > 0.05) {
      for (const hs of p.heelStrikes) {
        const crossed =
          this.lastWalkTime <= wt
            ? hs > this.lastWalkTime && hs <= wt
            : hs > this.lastWalkTime || hs <= wt
        if (crossed) this.onPace()
      }
    }
    this.lastWalkTime = wt
    if (e) {
      const ec = e.walkDuration / 2 / FEEL.paceSeconds
      e.locomote(this.speed, ec)
      this.eDist += (this.speed * e.paceLength * dt) / FEEL.paceSeconds
      e.root.position.z = 0.28 + this.eDist
    }
    // stall
    if (this.speed < 0.05) this.stall += dt
    else this.stall = 0
    if (this.stall > FEEL.stallHeckle && !this.stallHeckled) {
      this.stallHeckled = true
      c.hud.line(o.name, this.stallLine())
    }
    if (this.stall > FEEL.stallBackShot) {
      this.backShotByEnemy()
      return
    }
    if (o.gimmick === 'windy') {
      this.wind = Math.min(2.6, this.wind + dt * 0.25)
      c.world.windyFog(clamp01((this.wind - 0.4) / 2.2))
    }
    if (o.gimmick === 'cards') this.spawnCards(dt)
  }

  private stallLine(): string {
    const lines = [
      'You plannin’ on walkin’ today?',
      'I ain’t got all day, friend.',
      'My grandma walks faster.',
      'Scared?',
    ]
    return lines[Math.floor(rng() * lines.length)] ?? 'Walk.'
  }

  private onPace(): void {
    const c = this.c
    const o = this.outlaw
    this.paces++
    c.hud.setPips(this.paces, true)
    const a = c.audio
    const i = Math.floor(rng() * 8)
    a.play('spursteps', { offset: i + 0.0, duration: 0.7, gain: 0.55, rate: 0.95 + rng() * 0.1 })
    a.play('dirtsteps', { offset: Math.floor(rng() * 6) * 0.6, duration: 0.5, gain: 0.45 })
    const e = this.enemy
    if (e) {
      const when = a.now + FEEL.enemyStepOffset
      a.play('spursteps', {
        offset: Math.floor(rng() * 8),
        duration: 0.7,
        gain: 0.45,
        when,
        pos: e.root.position,
      })
      c.puffs.emit(V(0, 0.05, e.root.position.z), 6, {
        speed: 0.6,
        size: 0.12,
        life: 1,
        alpha: 0.35,
      })
    }
    c.puffs.emit(V(0, 0.05, this.player.root.position.z), 8, {
      speed: 0.7,
      size: 0.12,
      life: 1.1,
      alpha: 0.4,
    })
    // per-pace gimmicks
    if (o.gimmick === 'talker')
      c.hud.line(o.name, o.lines[(this.paces - 1) % o.lines.length] ?? '', 1100)
    if (o.gimmick === 'counter')
      c.hud.line(o.name, o.lines[(this.paces - 1) % o.lines.length] ?? '', 900)
    if (o.gimmick === 'drunk' && rng() < 0.3)
      c.hud.line(o.name, o.lines[Math.floor(rng() * o.lines.length)] ?? '*hic*', 1000)
    if (o.gimmick === 'impatient' && this.paces === 2) c.hud.line(o.name, o.lines[0] ?? '', 1400)
    if (o.gimmick === 'whistler' && this.paces % 2 === 1) c.hud.fake('[he whistles a dirge]')
    if (this.paces >= this.target) this.enterTurn()
  }

  private turnAnim: { a: Actor; from: number; to: number; t0: number; dur: number }[] = []

  private turnActor(a: Actor, from: number, to: number, dur: number): void {
    this.turnAnim = this.turnAnim.filter((x) => x.a !== a)
    this.turnAnim.push({ a, from, to, t0: this.realTime, dur })
  }

  private tickTurns(): void {
    for (const t of this.turnAnim) {
      const k = easeInOutCubic(clamp01((this.realTime - t.t0) / t.dur))
      t.a.root.rotation.y = MathUtils.lerp(t.from, t.to, k)
    }
    this.turnAnim = this.turnAnim.filter((t) => this.realTime - t.t0 < t.dur)
  }

  /**
   * Pace N: both men plant their feet with their backs to each other. Nobody
   * turns until the bell (the turn is the call).
   */
  private enterTurn(): void {
    const c = this.c
    this.enter('turn')
    this.speed = 0
    c.hud.setPips(this.paces, false)
    this.player.stopWalk(0.2)
    this.enemy?.stopWalk(0.2)
    // music ducks and muffles (still present), wind drops
    c.audio.musicLowpass(900, 0.9)
    c.audio.musicLevel(-9, 0.9)
    this.windLoop?.set(0.14, 0.9)
    this.standoffShot(false, 0.8)
  }

  /** True while the duellists stand back to back waiting for the bell. */
  private get backsTurned(): boolean {
    return this.outlaw.gimmick !== 'boss'
  }

  /** The walk framing, held: in front of you, his back far behind you. */
  private standoffShot(dolly: boolean, blend: number): void {
    const p = this.player
    this.pushing = dolly
    this.pushStart = this.realTime
    this.c.rig.cut(
      dolly ? 'wait' : 'stop',
      () => {
        const P = p.root.position
        const k = this.waitPush()
        return {
          pos: V(P.x + this.sideOff - k * 0.3, 1.2, P.z - 3.4 + k),
          look: V(P.x, 1.2, P.z + 1.2),
          fov: this.wideFov,
          handheld: 0.2,
        }
      },
      blend,
    )
  }

  private pushStart = 0
  private pushing = false

  /** Current slow dolly-in distance during the wait (0.15 m/s, capped). */
  private waitPush(): number {
    if (!this.pushing || this.reduced) return 0
    return Math.min(1.2, (this.realTime - this.pushStart) * 0.15)
  }

  /** Over-the-shoulder standoff framing; `dolly` adds the slow push-in of the wait. */
  private otsShot(dolly: boolean, blend = 0.9): void {
    const p = this.player
    const e = this.enemy
    this.pushing = dolly
    this.pushStart = this.realTime
    this.c.rig.cut(
      dolly ? 'wait' : 'ots',
      () => {
        const P = p.root.position
        const E = e ? e.root.position : V(0, 0, 10)
        const dist = Math.abs(E.z - P.z)
        const look = V(-dist * this.lookOff, 1.4, E.z)
        const pos = V(P.x - 0.55, 1.65, P.z - 1.8 + this.waitPush())
        return { pos, look, fov: this.restFov, handheld: 0.2 }
      },
      blend,
    )
  }

  private tickTurn(): void {
    if (this.phaseT >= FEEL.turnDuration) {
      this.player.play('Idle', 0.25)
      this.enemy?.play('Idle', 0.25)
      this.enterWait(false)
    }
  }

  private enterWait(fromPause: boolean): void {
    const c = this.c
    const o = this.outlaw
    const boss2 = o.gimmick === 'boss' && this.bossPhase === 2
    this.enter('wait')
    this.turnAnim = []
    if (this.backsTurned) {
      this.player.root.rotation.y = Math.PI
      if (this.enemy && this.enemyAlive) this.enemy.root.rotation.y = 0
    } else {
      this.player.root.rotation.y = 0
      if (this.enemy && this.enemyAlive) this.enemy.root.rotation.y = Math.PI
    }
    const [lo, hi] = boss2 ? [1.5, 4] : o.wait
    this.waitMs = between(lo, hi) * 1000
    this.waitStart = performance.now()
    this.tCall = this.waitStart + this.waitMs
    this.bellScheduled = false
    this.bellVoice = null
    this.ecuDone = false
    this.pianoStarted = false
    this.callIsScream = boss2
    const maxF =
      o.gimmick === 'boss' || o.gimmick === 'underboss' ? FEEL.maxFakesBoss : FEEL.maxFakes
    const times = planFakes(this.waitMs, o.fakeChance, maxF, rng)
    this.fakes = times.map((at) => ({
      at,
      kind: o.fakes[Math.floor(rng() * o.fakes.length)] ?? 'crow',
      fired: false,
    }))
    // the gambler's piano always plays and always stops
    if (o.gimmick === 'piano' && !this.fakes.some((f) => f.kind === 'piano')) {
      this.fakes.push({ at: between(0.4, 0.75) * this.waitMs, kind: 'piano', fired: false })
    }
    if (o.gimmick === 'coin' && !this.fakes.some((f) => f.kind === 'coin') && rng() < 0.7) {
      this.fakes.push({ at: between(0.45, 0.75) * this.waitMs, kind: 'coin', fired: false })
    }
    this.fakes.sort((a, b) => a.at - b.at)
    c.audio.heartbeat(FEEL.heartStartBpm)
    c.audio.musicLevel(-9, fromPause ? 0.1 : 0.5)
    this.windLoop?.set(0.12, 0.6)
    if (rng() < 0.3) {
      const tw = c.tumbleweeds.find((t) => !t.active)
      const mid = this.enemy ? (this.player.root.position.z + this.enemy.root.position.z) / 2 : 0
      tw?.launch(mid + between(-1, 1), rng() < 0.5 ? 1 : -1, between(3.5, 5))
    }
    if (this.enemy) this.enemy.shake = o.gimmick === 'shaky' ? 1 : o.gimmick === 'drunk' ? 0.3 : 0
    if (this.backsTurned) this.standoffShot(true, 0.4)
    else this.otsShot(true, 0.4)
    c.hud.letterbox(false)
  }

  private fireFake(f: Fake): void {
    const c = this.c
    const a = c.audio
    const e = this.enemy
    c.hud.fake(FAKE_CAPTION[f.kind])
    switch (f.kind) {
      case 'crow':
        a.play('crow', { gain: 0.9, pos: V(-12, 8, between(-10, 15)), reverb: 0.3 })
        break
      case 'door': {
        a.play('door', { gain: 1, pos: V(11, 1.5, 2), reverb: 0.4 })
        for (const d of c.world.saloonDoors) d.userData['kick'] = true
        setTimeout(() => {
          for (const d of c.world.saloonDoors) d.userData['kick'] = false
        }, 900)
        break
      }
      case 'bottle':
        a.play('bottle', { gain: 1, pos: V(-10, 1, between(-5, 10)), reverb: 0.4 })
        break
      case 'horse':
        a.play('horse', { gain: 0.8, pos: V(14, 1.5, -46), reverb: 0.3 })
        break
      case 'coin':
        a.play('coin', { gain: 0.8, pos: e?.root.position ?? V(), reverb: 0.2 })
        break
      case 'twitch':
        if (e) e.twitch = 1
        a.play('holster', { gain: 0.25, pos: e?.root.position ?? V(), rate: 1.3 })
        break
      case 'heckle':
        a.play('shout', { gain: 0.5, rate: 0.82, pos: V(-10, 1.6, 4), reverb: 0.4 })
        break
      case 'piano':
        // the stop itself is the fake; the music was started earlier
        break
      case 'gunshot':
        a.play('fireBig', { gain: 0.35, pos: V(40, 3, -60), lowpass: 1400, reverb: 0.8 })
        break
      case 'dog':
        a.play('dog', { gain: 0.8, pos: V(-30, 1, 30), reverb: 0.5 })
        break
    }
  }

  private tickWait(now: number): void {
    const c = this.c
    const elapsed = now - this.waitStart
    const sec = elapsed / 1000
    // heartbeat rises
    c.audio.heartbeat(Math.min(FEEL.heartMaxBpm, FEEL.heartStartBpm + FEEL.heartBpmPerSecond * sec))
    this.vignette = MathUtils.lerp(FEEL.vignetteBase, FEEL.vignetteWait, clamp01(sec / 2))
    // fakes
    for (const f of this.fakes) {
      if (!f.fired && elapsed >= f.at) {
        f.fired = true
        this.fireFake(f)
      }
      // piano plays up to its stop
      if (f.kind === 'piano' && !this.pianoStarted) {
        const pianoLen = 6.6
        const startAt = f.at / 1000 - pianoLen
        if (sec >= startAt) {
          this.pianoStarted = true
          const off = Math.max(0, sec - startAt)
          c.audio.play('piano', { gain: 0.55, pos: V(11.5, 1.6, 2), offset: off, reverb: 0.3 })
        }
      }
      if (f.kind === 'coin' && !f.fired && this.enemy && !this.coin && elapsed >= f.at - 650) {
        this.tossCoin()
      }
    }
    // tension without cutting: the letterbox closes in at 2 s, the camera keeps its slow push
    if (!this.ecuDone && sec >= 2 && this.waitMs - elapsed > 900) {
      this.ecuDone = true
      if (!this.reduced) c.hud.letterbox(true)
    }
    // bell: scheduled on the audio clock ahead of the call so it lands on the call frame
    const lookahead = FEEL.bellLookaheadMs
    if (!this.bellScheduled && now >= this.tCall - lookahead) {
      this.bellScheduled = true
      const when = c.audio.perfToCtx(this.tCall)
      this.bellVoice = c.audio.play('bell', { gain: 1.0, when, pos: c.world.bellPos, reverb: 0.5 })
      if (this.callIsScream)
        c.audio.play('shout', { gain: 1.0, when, rate: 0.7, pos: this.enemy?.root.position ?? V() })
    }
    // the call: the first frame at/after tCall (within half a frame)
    if (now >= this.tCall - 8) this.call(now)
  }

  private tossCoin(): void {
    const e = this.enemy
    if (!e) return
    const coin = new Mesh(
      new CylinderGeometry(0.025, 0.025, 0.004, 14),
      new MeshStandardMaterial({ color: 0xd4a640, metalness: 0.9, roughness: 0.3 }),
    )
    const p = e.root.position
    coin.position.set(p.x - 0.25, 1.2, p.z - 0.2)
    this.c.scene.add(coin)
    this.c.physics.add(coin, V(0, 3.1, -0.1), V(30, 0, 0), { rest: 0.1 })
    this.coin = coin
  }

  // --------------------------------------------------------------- the call

  private call(now: number): void {
    const c = this.c
    const o = this.outlaw
    this.enter('call')
    this.callT = now
    // The bell, caption and dolly-zoom start on this frame.
    if (!this.bellScheduled) {
      this.bellVoice = c.audio.play('bell', { gain: 1, pos: c.world.bellPos, reverb: 0.5 })
    }
    c.hud.call(this.callIsScream ? 'DRAW!' : 'DRAW!', 1400)
    c.hud.fake(this.callIsScream ? '[HE SCREAMS] [BELL TOLLS]' : '[BELL TOLLS]')
    c.hud.letterbox(false)
    c.audio.heartbeat(0)
    if (!this.reduced) c.renderer.grade.u('flash').value = 0.5
    const boss2 = o.gimmick === 'boss' && this.bossPhase === 2
    const legend = c.save.legend
    const draw = legend ? legendDraw(this.level) : boss2 ? BOSS_PHASE2.draw : o.draw
    const jitter = legend ? 0 : boss2 ? BOSS_PHASE2.jitter : o.jitter
    this.plan = planShots(
      now,
      {
        draw,
        jitter,
        accuracy: o.accuracy,
        assist: c.save.settings.assist ? ASSIST_MS : 0,
        twoGuns: o.gimmick === 'two-guns',
        rifleman: o.gimmick === 'underboss' && this.riflemanAlive ? RIFLEMAN : null,
        secondShotMs: FEEL.secondShotMs,
        delmerGapMs: FEEL.delmerGapMs,
      },
      rng,
    )
    if (c.save.settings.assist) c.save.assistUsed = true
    this.glintFired = false
    // The turn IS the call: both men spin on the bell, in the same frame.
    if (this.backsTurned) {
      this.turnActor(this.player, Math.PI, Math.PI * 2, FEEL.callTurn)
      if (this.enemy && this.enemyAlive) this.turnActor(this.enemy, 0, Math.PI, FEEL.callTurn)
      if (o.gimmick === 'shaky' && this.enemy) {
        const hat = this.enemy.popHat()
        if (hat) c.physics.add(hat, V(0.3, 1.4, -0.4), V(2, 1, 3))
      }
    }
    this.callShot()
    // outlaw goes for his gun
    const e = this.enemy
    if (e) {
      e.shake = 0
      e.twitch = 0.6
    }
  }
  private glintFired = false

  /** The call: a gentle, eased push-in on the same framing (no dolly-zoom whip). */
  private callShot(): void {
    const p = this.player
    const e = this.enemy
    const start = this.realTime
    const reduced = this.reduced
    const push0 = this.waitPush()
    this.c.rig.cut('call', () => {
      const P = p.root.position
      const E = e ? e.root.position : V(0, 0, 10)
      const dist = Math.abs(E.z - P.z)
      const look = V(-dist * this.lookOff, 1.4, E.z)
      const pos = V(P.x - 0.55, 1.65, P.z - 1.8 + push0)
      if (reduced) return { pos, look, fov: this.restFov }
      const k = easeInOutCubic(clamp01(((this.realTime - start) * 1000) / FEEL.callPushMs))
      return {
        pos,
        look,
        fov: MathUtils.lerp(this.restFov, this.restFov - (FEEL.fovRest - FEEL.fovCall), k),
        handheld: 0.1,
      }
    })
  }

  private alive = (who: number): boolean => (who === 0 ? this.enemyAlive : this.riflemanAlive)

  private tickCall(now: number): void {
    const c = this.c
    const plan = this.plan
    if (!plan) return
    // rifleman's scope glint, 150 ms after the call
    if (
      this.rifleman &&
      this.riflemanAlive &&
      !this.glintFired &&
      now - this.callT >= RIFLEMAN.glintAt
    ) {
      this.glintFired = true
      c.glint.fire(this.rifleman.headPos(V()).add(V(-0.35, -0.02, 0)))
      c.hud.fake('[a glint on the saloon roof]')
    }
    const s = dueShot(plan, now, FEEL.tieMs, this.alive)
    if (s) this.enemyFires(s)
  }

  private enemyFires(s: EnemyShot): void {
    const c = this.c
    s.done = true
    const shooter = s.who === 1 ? this.rifleman : this.enemy
    if (!shooter) return
    this.finishTurn(shooter)
    shooter.draw()
    if (s.who === 0) shooter.play('Gun_Shoot', 0.05, true, 1.6)
    const m = shooter.muzzle(V())
    c.flash.fire(m, 0.8)
    c.world.flashLight.position.copy(m)
    c.world.flashLight.intensity = 30
    c.puffs.emit(m, 10, {
      speed: 0.8,
      size: 0.12,
      grow: 0.8,
      life: 1.6,
      color: 0xb8b0a8,
      alpha: 0.35,
      up: 0.2,
    })
    c.audio.play('fireBig', { gain: 1.1, pos: shooter.root.position, reverb: 0.7 })
    if (!this.reduced) this.ca = 0.012
    if (s.hit) {
      this.playerHit(s.who === 1 ? 'The rifleman got you.' : '')
    } else {
      // Miss: whizz, ricochet, dust kick by your boots. You can still win.
      c.audio.whizz(rng() < 0.5 ? -0.7 : 0.7)
      c.audio.play('ricochet', {
        offset: Math.floor(rng() * 4),
        duration: 0.8,
        gain: 0.8,
        when: c.audio.now + 0.08,
        pos: this.player.root.position.clone().add(V(between(-2, 2), 0, between(-3, -1))),
      })
      const hitP = this.player.root.position
        .clone()
        .add(V(between(-1.2, 1.2), 0.05, between(-2.5, -0.8)))
      c.puffs.emit(hitP, 30, { speed: 1.6, size: 0.1, life: 1.2, alpha: 0.5, up: 1.4 })
      c.sparks.emit(hitP.setY(0.1), 12, {
        speed: 3,
        size: 0.03,
        life: 0.25,
        color: 0xffd080,
        alpha: 1,
        up: 2,
        drag: 1,
      })
      c.rig.addTrauma(FEEL.shake.whizz)
      this.secondChance = true
    }
  }

  private playerShoots(p: Press): void {
    const plan = this.plan
    if (!plan) return
    // Judge on timestamps: any hitting shot that went off before this press wins first.
    const before = shotsBefore(plan, p.t, FEEL.tieMs, this.alive)
    for (const s of before) {
      this.enemyFires(s)
      if (this.phase !== 'call') return
    }
    const under = this.outlaw.gimmick === 'underboss'
    if (under && this.targetsDown > 0 && p.t - this.lastPressT < FEEL.twoTargetGapMs) return
    const r = p.t - this.callT
    this.lastPressT = p.t
    if (this.lastReaction === null) this.lastReaction = r
    // who gets it?
    let who = 0
    if (under && this.riflemanAlive && this.enemyAlive) {
      who = 1
      if (p.source === 'pointer' && p.x >= 0) {
        const ePos = this.screenOf(this.enemy?.headPos(V()) ?? V())
        const rPos = this.screenOf(this.rifleman?.headPos(V()) ?? V())
        const dE = Math.hypot(ePos.x - p.x, ePos.y - p.y)
        const dR = Math.hypot(rPos.x - p.x, rPos.y - p.y)
        who = dE < dR ? 0 : 1
      }
    } else if (under && this.riflemanAlive) who = 1
    // hat shot (cosmetic): a click on his head
    if (p.source === 'pointer' && this.enemy && who === 0) {
      const h = this.screenOf(this.enemy.headPos(V()).add(V(0, 0.12, 0)))
      if (Math.hypot(h.x - p.x, h.y - p.y) < Math.max(40, window.innerHeight * 0.06))
        this.hatShot = true
    }
    this.playerFireFx()
    if (who === 1 && this.rifleman) {
      this.riflemanAlive = false
      this.killRifleman()
      this.targetsDown++
      if (this.enemyAlive) return
    } else {
      this.enemyAlive = false
      this.targetsDown++
      if (under && this.riflemanAlive) {
        // shot Curly first: the rifleman still gets you
        this.killEnemyAnim()
        return
      }
    }
    this.win(r)
  }

  private screenOf(v: Vector3): { x: number; y: number } {
    const p = v.clone().project(this.c.rig.cam)
    return { x: (p.x * 0.5 + 0.5) * window.innerWidth, y: (-p.y * 0.5 + 0.5) * window.innerHeight }
  }

  /** Snap a still-turning actor to its final facing (a shot can't wait for the spin). */
  private finishTurn(a: Actor | null): void {
    if (!a) return
    const t = this.turnAnim.find((x) => x.a === a)
    if (t) a.root.rotation.y = t.to
    this.turnAnim = this.turnAnim.filter((x) => x.a !== a)
  }

  private playerFireFx(): void {
    const c = this.c
    const p = this.player
    this.finishTurn(p)
    p.draw()
    p.play('Gun_Shoot', 0.04, true, 1.8)
    p.root.updateMatrixWorld(true)
    const m = p.muzzle(V())
    c.flash.fire(m, 0.9)
    c.world.flashLight.position.copy(m)
    c.world.flashLight.intensity = 40
    c.puffs.emit(m, 14, {
      speed: 0.9,
      size: 0.14,
      grow: 1,
      life: 2.2,
      color: 0xc8c0b8,
      alpha: 0.4,
      up: 0.25,
    })
    c.audio.play('fire', { gain: 1.2, reverb: 0.6 })
    c.rig.addTrauma(FEEL.shake.own)
    if (!this.reduced) this.ca = 0.012
  }

  private killEnemyAnim(): void {
    const c = this.c
    const e = this.enemy
    if (!e) return
    e.play('Death', 0.06, true)
    const hp = e.headPos(V())
    c.puffs.emit(hp.clone().setY(1.2), 12, {
      speed: 1,
      size: 0.1,
      life: 0.8,
      color: 0x7a2a1a,
      alpha: 0.5,
    })
    setTimeout(() => {
      c.audio.play('bodyfall', { gain: 0.9, pos: e.root.position })
      c.puffs.emit(e.root.position.clone().add(V(0, 0.05, 0.6)), 40, {
        speed: 1.4,
        size: 0.18,
        life: 1.6,
        alpha: 0.45,
        up: 0.6,
      })
    }, 650)
    const hat = e.popHat()
    this.flyingHat = hat
    if (hat) {
      const big = this.hatShot
      c.physics.add(
        hat,
        V(between(-0.4, 0.4), big ? 4.5 : 2.2, big ? 1.6 : 1.0),
        V(between(-6, 6), between(-4, 4), big ? 14 : 6),
      )
    }
  }

  private flyingHat: Object3D | null = null

  private killRifleman(): void {
    const c = this.c
    const r = this.rifleman
    if (!r) return
    r.play('Death', 0.05, true)
    // tumble off the roof
    const start = r.root.position.clone()
    this.fallers.push({ obj: r.root, v: V(-2.2, 2.5, 0), start })
    c.audio.play('bodyfall', { gain: 0.9, pos: start, when: c.audio.now + 0.9 })
  }
  private fallers: { obj: Object3D; v: Vector3; start: Vector3 }[] = []

  private tickFallers(dt: number): void {
    for (const f of this.fallers) {
      f.v.y -= 9.8 * dt
      f.obj.position.addScaledVector(f.v, dt)
      f.obj.rotation.z += dt * 2.5
      if (f.obj.position.y <= 0) {
        f.obj.position.y = 0
        f.v.set(0, 0, 0)
      }
    }
    this.fallers = this.fallers.filter((f) => f.obj.position.y > 0)
  }

  private win(r: number): void {
    const c = this.c
    const o = this.outlaw
    this.enter('win')
    this.outcomeT = 0
    this.resultShown = false
    this.killEnemyAnim()
    c.audio.heartbeat(0)
    c.hud.clearCall()
    const grade = gradeFor(r, this.secondChance)
    const best = c.save.best[this.level]
    if (!best || r < best.ms) {
      c.save.best[this.level] = { ms: r, grade, attempts: c.save.attempts[this.level] ?? 1 }
    } else best.attempts = c.save.attempts[this.level] ?? best.attempts
    persist(c.save)
    // 70 ms hitstop, then the red frame, then 0.15× kill cam.
    this.timeScale = 0
    this.killDur = this.reduced ? FEEL.killCamSecondsReduced : FEEL.killCamSeconds
    if (o.gimmick === 'boss' && this.bossPhase === 1) {
      this.enter('bossWound')
      return
    }
    if (o.gimmick === 'boss') this.killDur = this.reduced ? 1 : 3
    this.killOrbit = o.gimmick === 'boss' ? Math.PI * 2 : MathUtils.degToRad(25)
    c.audio.play('shout', { gain: 0.9, when: c.audio.now + 0.35 })
    this.killShot()
    this.drawPosterTex('dead')
  }

  private killShot(): void {
    const p = this.player
    const e = this.enemy
    const r = this.rifleman
    const start = this.realTime
    const hatFollow = this.hatShot
    const dur = this.killDur
    const orbit = this.killOrbit
    const under = this.outlaw.gimmick === 'underboss'
    const side = rng() < 0.5 ? 1 : -1
    this.c.rig.cut(
      'kill',
      () => {
        const t = this.realTime - start
        const P = p.root.position
        const E = e ? e.root.position : V(0, 0, 10)
        let rp: Pose | null = null
        if (under && r) {
          const R = r.root.position
          rp = { pos: V(R.x - 5, R.y + 0.4, R.z - 5), look: V(R.x, R.y + 1.0, R.z), fov: 40 }
          if (t < dur * 0.45) return rp
        }
        const mid = P.clone().add(E).multiplyScalar(0.5)
        const sep = Math.abs(E.z - P.z)
        const dist = Math.min(7, sep * 0.45 + 3)
        // widen the lens rather than backing into the storefronts
        const aspect = this.c.rig.cam.aspect
        const halfW = Math.atan((sep * 0.3 + 1.4) / dist)
        const kfov = MathUtils.clamp(
          MathUtils.radToDeg(2 * Math.atan(Math.tan(halfW) / aspect)),
          32,
          75,
        )
        const focus = mid.clone().lerp(E, 0.55)
        const a = side * orbit * easeInOutCubic(clamp01(t / Math.max(dur, 0.01)))
        const pos = V(side * Math.cos(a) * dist, 1.15, focus.z + Math.sin(a) * dist)
        const hat = this.flyingHat
        if (hatFollow && hat) {
          const hp = hat.position
          return {
            pos: V(hp.x + 1.8 * side, Math.max(0.4, hp.y + 0.3), hp.z - 1.6),
            look: hp.clone(),
            fov: 34,
          }
        }
        const main: Pose = { pos, look: V(0, 1.0, focus.z), fov: kfov, handheld: 0.1 }
        if (rp && t < dur * 0.45 + 0.5) {
          // ease from the roof down to the street instead of snapping
          const k = easeInOutCubic(clamp01((t - dur * 0.45) / 0.5))
          main.pos = rp.pos.clone().lerp(main.pos, k)
          main.look = rp.look.clone().lerp(main.look, k)
        }
        return main
      },
      0.5,
    )
  }

  private tickWin(realDt: number): void {
    const c = this.c
    const t = this.phaseT
    const hit = FEEL.hitstopMs / 1000
    if (t < hit) {
      this.timeScale = 0
      return
    }
    if (this.outcomeT === 0) {
      this.outcomeT = t
      if (!this.reduced) this.silhouetteFrames = FEEL.redFrames
      else c.renderer.grade.u('flash').value = 0.25
    }
    const k = t - hit
    if (k < this.killDur) this.timeScale = FEEL.killCamScale
    else
      this.timeScale = Math.min(
        1,
        FEEL.killCamScale + ((k - this.killDur) / FEEL.rampBack) * (1 - FEEL.killCamScale),
      )
    if (k > this.killDur && c.rig.name === 'kill' && this.outlaw.gimmick !== 'boss') {
      // ease back to the OTS while time ramps up
      this.otsShot(false, 1.0)
    }
    // music swells back 400 ms after the kill
    if (k > 0.4 && k - realDt <= 0.4) {
      c.audio.musicLowpass(18000, 0.4)
      c.audio.musicLevel(0, 0.4)
    }
    if (this.outlaw.gimmick === 'boss') {
      if (k > 0.5 && this.midnightBells < 12 && k > 0.5 + this.midnightBells * 0.9) {
        c.audio.play('bell', { gain: 0.8, pos: c.world.bellPos, reverb: 0.6 })
        this.midnightBells++
      }
      if (k > this.killDur + 0.5) this.toEnd()
      return
    }
    if (!this.resultShown && t >= FEEL.resultAt) {
      this.resultShown = true
      const r = this.lastReaction ?? 0
      c.hud.showCard(
        'win',
        `${this.outlaw.name.toUpperCase()} IS DEAD`,
        `${Math.round(r)} ms`,
        gradeFor(r, this.secondChance),
        'press to continue',
      )
    }
    if (t >= FEEL.resultAt + FEEL.resultFor) this.nextLevel()
  }

  private nextLevel(): void {
    const c = this.c
    c.hud.hideCard()
    this.timeScale = 1
    if (this.level + 1 >= this.total) {
      this.toEnd()
      return
    }
    c.save.level = this.level + 1
    persist(c.save)
    this.startLevel(this.level + 1, false)
  }

  private tickBossWound(): void {
    const c = this.c
    const t = this.phaseT
    if (t < FEEL.hitstopMs / 1000) {
      this.timeScale = 0
      return
    }
    const e = this.enemy
    if (this.outcomeT === 0) {
      this.outcomeT = t
      this.timeScale = 0.3
      e?.play('HitRecieve', 0.05, true)
      const g = e?.dropOffGun()
      if (g && e) {
        const p = e.root.position.clone().add(V(0.3, 1.0, 0))
        c.scene.add(g)
        g.position.copy(p)
        c.physics.add(g, V(0.6, 1.0, -0.5), V(4, 2, 6))
      }
      c.hud.line(this.outlaw.name, 'That… that’s just a scratch.', 2200)
      c.audio.play('shout', { gain: 0.7, rate: 0.6, pos: e?.root.position ?? V() })
    }
    if (t > 1.1) this.timeScale = 1
    if (t > 2.4) {
      this.bossPhase = 2
      this.lastReaction = null
      this.secondChance = false
      this.enemyAlive = true
      e?.play('Idle', 0.3)
      this.player.holsterGun()
      this.player.play('Idle', 0.3)
      this.enemy?.holsterGun()
      this.enterWait(false)
    }
  }

  private playerHit(reason: string): void {
    const c = this.c
    this.enter('lose')
    this.loseReason = reason
    c.audio.heartbeat(0)
    c.hud.clearCall()
    c.rig.addTrauma(FEEL.shake.hit)
    c.audio.play('bodyfall', { gain: 0.8, when: c.audio.now + 0.5 })
    c.audio.play('bell', {
      gain: 0.7,
      rate: 0.6,
      lowpass: 900,
      pos: c.world.bellPos,
      when: c.audio.now + 0.3,
      reverb: 0.8,
    })
    this.satTarget = 0.2
    this.timeScale = 1
    this.deathShot()
    setTimeout(() => {
      if (this.phase !== 'lose') return
      c.hud.showCard(
        'lose',
        'YOU LOSE',
        '',
        this.loseReason || `${this.outlaw.name} was quicker.`,
        'press to try again',
      )
    }, 450)
    this.player.root.visible = false
  }

  private deathShot(): void {
    const p = this.player
    const e = this.enemy
    const reduced = this.reduced
    this.c.rig.cut(
      'death',
      (t) => {
        const P = p.root.position
        const E = e ? e.root.position : V(0, 0, 10)
        const facing = Math.sign(E.z - P.z) || 1
        const k = easeInOutCubic(clamp01(t / FEEL.loseFall))
        const y = MathUtils.lerp(1.62, 0.55, reduced ? 0 : k)
        const roll = reduced ? 0 : MathUtils.degToRad(22) * k
        return {
          pos: V(P.x, y, P.z + facing * 0.1),
          look: V(E.x, MathUtils.lerp(1.5, 1.0, reduced ? 0 : k), E.z),
          fov: 42,
          roll,
          handheld: 0.15,
        }
      },
      0.35,
    )
  }

  /** Stalled too long: he turns and shoots you in the back. */
  private backShotByEnemy(): void {
    const c = this.c
    const e = this.enemy
    this.player.stopWalk(0.1)
    if (e) {
      e.stopWalk(0.1)
      this.turnActor(e, e.root.rotation.y, Math.PI, 0.3)
      setTimeout(() => {
        e.draw()
        e.play('Gun_Shoot', 0.05, true, 1.6)
        const m = e.muzzle(V())
        c.flash.fire(m)
        c.audio.play('fireBig', { gain: 1.1, pos: e.root.position, reverb: 0.7 })
      }, 320)
    }
    this.enter('lose')
    setTimeout(() => {
      this.playerHit('SHOT IN THE BACK. HE DIDN’T WAIT EITHER.')
    }, 340)
  }

  private coward(): void {
    const c = this.c
    const e = this.enemy
    this.enter('coward')
    this.bellVoice?.stop()
    this.bellVoice = null
    c.audio.heartbeat(0)
    c.hud.letterbox(false)
    c.hud.clearCall()
    this.player.stopWalk(0.08)
    e?.stopWalk(0.08)
    this.turnAnim = []
    // You turn and shoot him where he stands.
    this.player.root.rotation.y = 0
    this.playerFireFx()
    this.enemyAlive = false
    this.killEnemyAnim()
    // hard cut to silence, then the town gasps
    c.audio.musicLevel(-Infinity, 0.12)
    this.windLoop?.set(0.05, 0.05)
    c.audio.play('gasp', { gain: 1, when: c.audio.now + 0.5, reverb: 0.4 })
    c.save.cowardice++
    persist(c.save)
    this.drawPosterTex('coward')
    const p = this.player
    this.c.rig.cut(
      'coward',
      (t) => {
        const P = p.root.position
        const E = e ? e.root.position : V(0, 0, 3)
        const mid = P.clone().add(E).multiplyScalar(0.5)
        return { pos: V(6 + t * 0.1, 1.3, mid.z), look: V(0, 1.0, mid.z), fov: 40 }
      },
      0.6,
    )
    setTimeout(() => {
      if (this.phase !== 'coward') return
      const img = this.posterCanvas.toDataURL('image/jpeg', 0.8)
      c.hud.showCard(
        'coward',
        'COWARD.',
        '',
        `${c.save.cowardice} shot in the back. No bounty.`,
        'press to try again',
      )
      const card = c.hud.root.querySelector('.ow-card-big')
      if (card)
        card.innerHTML = `<img alt="Wanted poster stamped: shot in the back, no bounty" src="${img}">`
    }, 700)
  }

  private retry(): void {
    const c = this.c
    c.hud.hideCard()
    c.physics.clear()
    this.satTarget = 1
    this.timeScale = 1
    this.fallers = []
    const boss = this.outlaw.gimmick === 'boss'
    if (boss && this.bossPhase === 2 && this.phase === 'lose') {
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
      this.otsShot(true)
      this.enterWait(false)
      return
    }
    this.spawnActors()
    this.drawPosterTex(null)
    this.enterCock()
  }

  // ----------------------------------------------------------------- boss

  private bossShot(): void {
    this.otsShot(false)
  }

  private enterBossClock(): void {
    const c = this.c
    this.enter('bossClock')
    this.bossPhase = 1
    this.strikes = 0
    this.nextStrike = performance.now() + 1600
    this.miscountAt = Math.floor(between(8, 11))
    this.bellPreArmed = false
    this.bellScheduled = false
    c.world.setClock(11, 59)
    c.audio.musicLevel(-9, 0.6)
    c.audio.musicLowpass(900, 0.6)
    c.audio.heartbeat(FEEL.heartStartBpm)
    this.windLoop?.set(0.1, 0.6)
    this.player.root.rotation.y = 0
    this.enemy?.root.rotation.set(0, Math.PI, 0)
    this.otsShot(true)
  }

  private tickBossClock(now: number): void {
    const c = this.c
    const sec = this.phaseT
    c.audio.heartbeat(Math.min(FEEL.heartMaxBpm, FEEL.heartStartBpm + 4 * sec))
    this.vignette = MathUtils.lerp(FEEL.vignetteBase, FEEL.vignetteWait, clamp01(sec / 6))
    const isLast = this.strikes === 11
    // schedule each strike on the audio clock slightly ahead
    if (!this.bellPreArmed && now >= this.nextStrike - FEEL.bellLookaheadMs) {
      this.bellPreArmed = true
      const when = c.audio.perfToCtx(this.nextStrike)
      this.bellVoice = c.audio.play('bell', {
        gain: isLast ? 1 : 0.8,
        when,
        pos: c.world.bellPos,
        reverb: 0.5,
      })
      this.bellScheduled = true
    }
    if (now >= this.nextStrike - 8) {
      if (isLast) {
        this.callIsScream = false
        c.world.setClock(12, 0)
        this.call(now)
        return
      }
      this.strikes++
      this.bellPreArmed = false
      c.world.setClock(this.strikes === 0 ? 11 : 12, 0)
      const n = this.strikes
      if (n === this.miscountAt) {
        c.hud.line(this.outlaw.name, '…TWELVE!', 1100)
        if (this.enemy) this.enemy.twitch = 1
      } else {
        c.hud.line(this.outlaw.name, `${NUMBERS[n - 1] ?? ''}…`, 900)
      }
      c.hud.fake(`[bell strikes ${n}]`)
      this.nextStrike = now + between(BOSS_STRIKE_INTERVAL[0], BOSS_STRIKE_INTERVAL[1]) * 1000
      if (n === 6 && !this.reduced) c.hud.letterbox(true)
    }
  }

  // ------------------------------------------------------------------ end

  private toEnd(): void {
    const c = this.c
    this.enter('end')
    this.timeScale = 1
    c.save.legendUnlocked = true
    persist(c.save)
    c.hud.hideCard()
    c.hud.show(false)
    c.audio.musicLevel(0, 1)
    c.audio.musicLowpass(18000, 1)
    this.endT = 0
    const rows = OUTLAWS.map((o, i) => {
      const b = c.save.best[i]
      return {
        name: o.name,
        ms: b ? b.ms : null,
        grade: b ? b.grade : '—',
        attempts: c.save.attempts[i] ?? 0,
      }
    })
    const ms = rows.map((r) => r.ms).filter((m): m is number => m !== null)
    const avg = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null
    setTimeout(() => {
      c.hud.showEnd(
        rows,
        {
          cowardice: c.save.cowardice,
          avg,
          assist: c.save.assistUsed,
          legend: c.save.legend,
          legendUnlocked: c.save.legendUnlocked,
        },
        () => {
          c.hud.hideEnd()
          c.hud.show(true)
          resetRun(c.save, false)
          persist(c.save)
          this.startLevel(0, false)
        },
        () => {
          c.hud.hideEnd()
          c.hud.show(true)
          resetRun(c.save, true)
          persist(c.save)
          this.startLevel(0, false)
        },
      )
    }, 1800)
    this.c.rig.cut(
      'end',
      (t) => {
        const k = easeInOutCubic(clamp01(t / 10))
        return {
          pos: V(3, MathUtils.lerp(1.6, 22, k), MathUtils.lerp(30, 10, k)),
          look: V(0, MathUtils.lerp(4, 14, k), STREET.churchZ),
          fov: 45,
        }
      },
      1.5,
    )
  }

  private tickEnd(dt: number): void {
    this.endT += dt
  }

  // --------------------------------------------------------- presentation

  private spawnCards(dt: number): void {
    this.cardT -= dt
    if (this.cardT > 0 || this.cards.length > 14) return
    this.cardT = between(0.4, 1.0)
    const card = makeCard()
    const e = this.enemy
    card.position.set(between(-6, -3), between(0.5, 2), (e?.root.position.z ?? 0) + between(-4, 6))
    this.c.scene.add(card)
    this.c.physics.add(
      card,
      V(2, between(0, 1), between(-0.5, 0.5)),
      V(between(-8, 8), between(-8, 8), between(-8, 8)),
      {
        flutter: 3,
        ground: 0.01,
      },
    )
    this.cards.push(card)
  }

  private clearCards(): void {
    for (const card of this.cards) card.removeFromParent()
    this.cards = []
    this.coin?.removeFromParent()
    this.coin = null
  }

  private tickCards(dt: number): void {
    this.tickTurns()
    this.tickFallers(dt)
  }

  private tickAmbience(dt: number): void {
    const c = this.c
    const night = clamp01((c.world.day - 0.6) / 0.25)
    this.cricketLoop?.set(night * 0.35 * (this.phase === 'wait' ? 0.6 : 1), 1)
    this.ambT -= dt
    if (
      this.ambT <= 0 &&
      (this.phase === 'walk' || this.phase === 'poster' || this.phase === 'intro')
    ) {
      this.ambT = between(9, 18)
      if (night < 0.5)
        c.audio.play('hawk', {
          gain: 0.35,
          pos: V(between(-40, 40), 30, between(-60, 60)),
          reverb: 0.3,
        })
      else
        c.audio.play('dog', {
          gain: 0.3,
          pos: V(between(-60, 60), 1, between(-60, 60)),
          reverb: 0.6,
        })
    }
    if (this.outlaw.gimmick === 'windy' && (this.phase === 'walk' || this.phase === 'wait')) {
      this.windLoop?.set(0.25 + this.wind * 0.15, 0.4)
    }
  }

  private tickPresentation(realDt: number): void {
    const c = this.c
    const r = c.renderer
    const p = c.world.preset
    // grade
    this.sat += (this.satTarget - this.sat) * Math.min(1, realDt * 3)
    r.grade.u('saturation').value = p.saturation * this.sat
    r.grade.u('contrast').value = p.contrast
    r.grade.u('lift').value = p.lift
    r.grade.u('exposure').value = p.exposure
    ;(r.grade.u('shadowTint').value as Vector3).set(...p.shadowTint)
    ;(r.grade.u('highTint').value as Vector3).set(...p.highTint)
    const f = r.grade.u('flash')
    f.value = Math.max(0, (f.value as number) - realDt * 30)
    r.bloom.intensity = p.bloom
    r.noise.blendMode.opacity.value = p.grain
    r.vignette.darkness = this.reduced ? FEEL.vignetteBase : this.vignette
    if (this.phase !== 'wait' && this.phase !== 'bossClock')
      this.vignette += (FEEL.vignetteBase - this.vignette) * Math.min(1, realDt * 2)
    this.ca = Math.max(0, this.ca - realDt * (0.012 / 0.2))
    r.setLens(this.ca, p.shimmer, this.satTarget < 1 ? clamp01(this.phaseT) * 0.6 : 0)
    // dust
    const windy = this.outlaw.gimmick === 'windy' ? this.wind : 0.35
    c.dust.wind = 0.6 + windy * 1.6
    if (
      this.outlaw.gimmick !== 'windy' ||
      (this.phase !== 'walk' && this.phase !== 'wait' && this.phase !== 'call')
    )
      this.wind += (0.35 - this.wind) * Math.min(1, realDt)
    // muzzle light decay
    c.world.flashLight.intensity *= Math.exp(-realDt * 30)
  }

  // ------------------------------------------------------------- debug views

  /** #lineup: every outlaw side by side in the street (for review screenshots). */
  async lineup(day = 0.3): Promise<void> {
    const c = this.c
    const all = [...OUTLAWS.map((o) => o.look), RIFLEMAN_LOOK]
    await Promise.all(all.map((l) => c.assets.lookReady(l)))
    c.world.apply(day)
    this.player.root.visible = false
    const row = (o: Outlaw | null, look: Look, i: number) => {
      const a = castActor(c.assets, {
        look,
        hat: o?.hat ?? 'cowboy',
        hatColor: o?.hatColor ?? 0x1a1410,
        bandana: o?.bandana ?? 0x3a2a1a,
        gun: c.gun ? propObject(c.gun) : null,
        offGun: o?.gimmick === 'two-guns' || o?.gimmick === 'boss',
      })
      const front = i < 9
      const k = front ? i : i - 9
      a.root.position.set(-6.4 + k * 1.6 + (front ? 0 : 0.8), 0, front ? 3 : 6)
      a.root.rotation.y = Math.PI
      a.play('Idle', 0)
      a.mixer.update(Math.random())
      c.scene.add(a.root)
      this.lineupActors.push(a)
    }
    OUTLAWS.forEach((o, i) => {
      row(o, o.look, i)
    })
    row(null, RIFLEMAN_LOOK, 17)
    c.world.focusShadow(V(0, 0, 4))
    this.phase = 'end'
    const focus = Number(new URLSearchParams(location.hash.slice(1)).get('focus') ?? '-1')
    const fa = this.lineupActors[focus]
    if (fa) {
      const h = fa.headPos(V())
      c.rig.cut('lineup', () => ({
        pos: V(h.x - 0.35, h.y + 0.05, h.z - 1.1),
        look: V(h.x, h.y - 0.1, h.z),
        fov: 35,
      }))
    } else c.rig.cut('lineup', () => ({ pos: V(0, 1.55, -4.6), look: V(0, 1.05, 4.5), fov: 52 }))
  }
  private readonly lineupActors: Actor[] = []

  /** #posters: all wanted posters in a grid. */
  async posters(): Promise<void> {
    const c = this.c
    await Promise.all(OUTLAWS.map((o) => c.assets.lookReady(o.look)))
    const grid = document.createElement('div')
    grid.className = 'ow-poster-grid'
    OUTLAWS.forEach((o, i) => {
      const cv = document.createElement('canvas')
      drawPoster(cv, o, { index: i, stamp: null, portrait: this.studio.render(i, o) })
      grid.appendChild(cv)
    })
    c.hud.root.appendChild(grid)
  }

  /** Debug overlay text. */
  debugText(fps: number, ms: number): string {
    return [
      `fps ${fps.toFixed(0)}  frame ${ms.toFixed(1)} ms  dpr ${this.c.renderer.dpr.toFixed(2)} ${this.c.renderer.tier}`,
      `level ${this.level + 1} ${this.outlaw.name}  phase ${this.phase}${this.paused ? ' (paused)' : ''}`,
      `paces ${this.paces}/${this.target}  W ${(this.waitMs / 1000).toFixed(2)} s  E ${this.plan ? this.plan.e.toFixed(0) : '-'} ms`,
      `last reaction ${this.lastReaction === null ? '-' : `${this.lastReaction.toFixed(1)} ms`}`,
      `draws ${this.c.renderer.gl.info.render.calls}  tris ${this.c.renderer.gl.info.render.triangles}`,
    ].join('\n')
  }
}
