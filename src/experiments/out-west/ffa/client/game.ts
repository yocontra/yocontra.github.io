// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the per-frame scene and HUD passes read many independent bits of state
// biome-ignore-all lint/complexity/useMaxParams: small positional helpers on the hot path
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: lifecycle flags (running, exited, disposed) are mutated from callbacks and awaits; Biome narrows them to their initialisers
// biome-ignore-all lint/style/noExcessiveLinesPerFile: the Frontier game loop ties the net, input, scene and HUD together in one place
/**
 * The Frontier game: one renderer and scene, the town, the crowd, the effects and the HUD, driven
 * by a 20 Hz input/prediction tick and a free-running render loop.
 *
 * Per frame: run any due 20 Hz ticks (sample input → predict → maybe send), resolve your own render
 * position (lerp between the last two predicted ticks plus the decaying correction), sample every
 * other player 100 ms in the past, then crowd, camera, cutaway, effects, HUD and render.
 */
import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Plane,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
} from 'three'
import { AudioEngine, type SfxName } from '../../audio/audio.ts'
import {
  ANIM_AIM,
  ANIM_CHANNEL,
  ANIM_DEAD,
  ANIM_DUEL,
  ANIM_HOP,
  ANIM_IDLE,
  ANIM_RELOAD,
  ANIM_ROLL,
  ANIM_RUN,
  ANIM_SLIDE,
  ANIM_VAULT,
  BOX_NONE,
  BOX_OPENING,
  BTN_AIM,
  BTN_CALLOUT,
  BTN_FIRE,
  BTN_INTERACT,
  BTN_LEAVE,
  CHANNEL_BANK,
  CHANNEL_LEAVE,
  CHANNEL_NONE,
  CHANNEL_STAGE,
  CHANNEL_STRONGBOX,
  EF_ALIVE,
  EF_HOLSTERED,
  EF_MOST_WANTED,
  EF_PROTECTED,
  EV_BAG_DROP,
  EV_DEPOSIT,
  EV_KILL,
  NONE,
  type RosterEntry,
  SELF_ALIVE,
  SELF_DEAD_EYE_READY,
  SELF_HOLSTERED,
  SELF_IN_SHOWDOWN,
  SELF_MOST_WANTED,
  SELF_RELOADING,
  type ServerControl,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  STANCE_ADS,
  STANCE_CROUCH,
  STANCE_SPRINT,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../contract/town.ts'
import { loadAssets } from '../../engine/assets.ts'
import { Renderer } from '../../engine/render.ts'
import { tierHint } from '../../engine/tiers.ts'
import { haptic } from '../../platform/haptics.ts'
import { presetAt } from '../../scene/presets.ts'
import { RIM } from '../../scene/style.ts'
import { installUiSounds } from '../../ui/sfx.ts'
import { bagColor, bagStyleColor } from '../scene/bags.ts'
import { TopDownCamera } from '../scene/camera.ts'
import { Crowd, type CrowdPlayer, READ_SCALE } from '../scene/crowd.ts'
import { CUT } from '../scene/cutaway.ts'
import { shareDepthByKind } from '../scene/depth-kinds.ts'
import { Effects } from '../scene/fx.ts'
import { installHotPaths } from '../scene/hot-paths.ts'
import { buildInterior } from '../scene/interior.ts'
import { lookFor } from '../scene/looks.ts'
import { loadMoves } from '../scene/moves.ts'
import { Pickups } from '../scene/pickups.ts'
import { buildTown, type Town } from '../scene/town.ts'
import { buildWilds, shadeTown, Wilds } from '../scene/wilds.ts'
import type { WireEvent } from '../sim/codec-events.ts'
import {
  BANK_CHANNEL_TICKS,
  BLOOM_DECAY_DEG,
  DEAD_EYE_CLOSE_TICKS,
  HOP_TICKS,
  LEAVE_CHANNEL_TICKS,
  MAX_RANGE,
  RELOAD_TICKS,
  REVOLVER_ROUNDS,
  RIFLE_RANGE,
  RIFLE_ROUNDS,
  SHOTGUN_RANGE,
  SHOTGUN_SHELLS,
  STAGE_CHANNEL_TICKS,
  STRONGBOX_CHANNEL_TICKS,
  TICK_HZ,
  TICK_MS,
  VAULT_TICKS,
} from '../sim/constants.ts'
import { BLOCK_SHOT, BLOCK_SIGHT, rayGrid, spawnFacing, TOWN, zoneAt } from '../sim/layout.ts'
import { airborne, radiansToAim, sliding } from '../sim/move.ts'
import { bloomAfterShot } from '../sim/spread.ts'
import type { MoveState } from '../sim/types.ts'
import { type AimResult, assistFriction, assistPull, resolveAim } from './aim.ts'
import { ThreatArrows } from './arrows.ts'
import { Autopilot } from './autopilot.ts'
import { LOCAL_BITS } from './bindings.ts'
import { assistAim, currentAction } from './context.ts'
import { DesktopControls } from './controls.ts'
import { type Fuse, shotSound, stopFuse } from './event-sounds.ts'
import {
  type Callout,
  handleControl,
  handleEvent,
  type Showdown,
  type Sink,
  shotFx,
} from './events.ts'
import { Hud } from './hud.ts'
import type { RemoteView } from './interp.ts'
import { Minimap } from './minimap.ts'
import { NetClient } from './net.ts'
import { Onboarding } from './onboarding.ts'
import { Riders } from './riders.ts'
import { Scoreboard } from './scoreboard.ts'
import { type FrontierSettings, loadSettings, saveSettings, type ViewMode } from './settings.ts'
import { SettingsPanel } from './settings-panel.ts'
import { ShooterCamera } from './shooter-camera.ts'
import { FrontierSound, wearsSpurs } from './sound.ts'
import { Stance } from './stance.ts'
import { onBoardwalk } from './surface.ts'
import { TouchControls } from './touch.ts'
import { MotionTrace, TRACE_FIELDS } from './trace.ts'
import type { Transport, TransportEvents } from './transport.ts'
import { fireIntervalMs, policyFor, spreadDeg, spreadPx } from './view.ts'
import { ViewModel } from './viewmodel.ts'
import { viewport } from './viewport.ts'
import { BankGuide } from './wayfinding.ts'

/** Late-afternoon light: the sun low in the south-west, shadows reaching north-east. */
const DAY = 0.3
const SUN_DIR = new Vector3(-0.55, 0.62, 0.56).normalize()
const SHADOW_HALF = 12
/** Input ticks catch up on at most this much wall time per frame (ms), at most this many at once. */
const MAX_CATCH_UP_MS = 250
const MAX_TICKS_PER_FRAME = 6

export interface GameOptions {
  audio?: AudioEngine | null
  /** Called once when the player leaves town (or the connection is lost for good). */
  onExit: (reason: 'left' | 'quit' | 'lost') => void
}

export type Connect = (ev: TransportEvents) => Transport

const CHANNEL_LABEL: Record<number, [string, number]> = {
  [CHANNEL_BANK]: ['Banking…', BANK_CHANNEL_TICKS],
  [CHANNEL_STAGE]: ['Shipping by stage…', STAGE_CHANNEL_TICKS],
  [CHANNEL_STRONGBOX]: ['Cracking the strongbox…', STRONGBOX_CHANNEL_TICKS],
  [CHANNEL_LEAVE]: ['Leaving town…', LEAVE_CHANNEL_TICKS],
}

export class FrontierGame {
  readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  readonly scene = new Scene()
  readonly cam = new TopDownCamera()
  readonly renderer: Renderer
  readonly net: NetClient
  private transport: Transport | null = null
  private town: Town | null = null
  private crowd: Crowd | null = null
  private fx: Effects | null = null
  private pickups: Pickups | null = null
  readonly hud: Hud
  private readonly riders: Riders
  /** What you carried a moment ago (the death card says what dropped). */
  private lastCarry = 0
  /** The last player killed: the next bag drop is theirs. */
  private lastVictim = NONE
  private map: Minimap | null = null
  private readonly desk: DesktopControls
  private readonly touch: TouchControls | null
  private readonly arrows: ThreatArrows
  /** Dev-only (`?debug=…`): scripted input for multi-page tests. */
  readonly autopilot: Autopilot | null
  private lastMw = NONE
  private readonly audio: AudioEngine | null
  private readonly sun: DirectionalLight
  /** Sky, haze, cloud shadows and wind. */
  private readonly wilds: Wilds
  private readonly opts: GameOptions
  private raf = 0
  private hiddenTimer: ReturnType<typeof setInterval> | null = null
  private last = 0
  private acc = 0
  private running = false
  private disposed = false
  private exited = false
  /** The connection's banner ("Reconnecting…", "Disconnected"), or null while connected. */
  private connBanner: string | null = null
  /** Your rendered pose (`NetClient.localRenderPose`): what the camera and the crowd follow. */
  private readonly own = { x: 72, z: 64, yaw: 0 }
  private aim = 0
  private renderTick = 0
  private readonly showdowns = new Map<number, Showdown>()
  private callouts: Callout[] = []
  private killer: { id: number; flags: number } | null = null
  private actionBit = 0
  private readonly ray = new Raycaster()
  private readonly aimPlane = new Plane(new Vector3(0, 1, 0), -1.2)
  private readonly tmp = new Vector3()
  private readonly ndc = new Vector2()
  /** Every remote rider at render time, refilled in place each frame. */
  private readonly remotes: RemoteView[] = []
  private readonly crowdList: CrowdPlayer[] = []
  /** Reused rows for `crowdList` (one per remote rider; nothing allocated per frame). */
  private readonly crowdRows: CrowdPlayer[] = []
  private mapAt = 0
  private readonly hatlessSeen = new Set<number>()
  private wasAlive = false
  /** Each rider's vault or hop (anim) as of last frame, for the landing thud. */
  private readonly airborne = new Map<number, number>()
  private wasReloading = false
  private wasReady = false
  private readonly sound: FrontierSound | null
  private readonly fuses = new Map<number, Fuse>()
  private readonly sink: Sink
  readonly perf = { tickMs: 0, frameMs: 0, simMs: 0 }
  // --- shooter views (over the shoulder, first person) ---
  private settings: FrontierSettings
  /** Drives the same camera as `cam` in the shooter views. */
  readonly shooter: ShooterCamera
  private viewModel: ViewModel | null = null
  private readonly vmSun = new Vector3()
  private readonly vmQ = new Quaternion()
  private guide: BankGuide | null = null
  private readonly coach: Onboarding
  /** Crouch toggle and slide (local crouch taps → `BTN_CROUCH`). */
  private readonly stance = new Stance()
  private readonly score: Scoreboard
  private readonly panel: SettingsPanel
  private readonly touchUi: boolean
  private readonly aimRes: AimResult = { yaw: 0, point: new Vector3(), target: -1, range: 0 }
  private readonly look = { x: 0, y: 0 }
  /** This frame's look turn (rad), for the view model's sway. */
  private readonly turned = { yaw: 0, pitch: 0 }
  /** Crosshair bloom after a shot (degrees, decays). */
  private bloom = 0
  /** Next auto-repeat shot while FIRE is held on touch (performance.now ms). */
  private nextAuto = 0
  private wasCarry = 0
  private wasInZone = false
  /** The last frame's dt (s), for the HUD's easing. */
  private dtS = 0
  private readonly cutSize = new Vector2()
  private readonly cutView = new Vector3()
  /** When the pointer lock was last lost (performance.now ms). */
  private lockLostAt = -1e9
  /** When you last fired (performance.now ms), for the raised-gun pose. */
  private lastShotAt = -1e9
  /** Dev harness ADS (desktop has no touch AIM toggle). */
  private devAdsOn = false
  private devWeapon: number | null = null
  /** Dev-only per-frame motion trace (`__frontierTrace`). */
  readonly trace = new MotionTrace()
  private ticksThisFrame = 0
  private readonly traceRow: number[] = Array.from({ length: TRACE_FIELDS.length }, () => 0)

  constructor(root: HTMLElement, opts: GameOptions) {
    installHotPaths()
    this.root = root
    this.opts = opts
    this.audio = opts.audio === undefined ? new AudioEngine() : opts.audio
    this.audio?.prefetch()
    // the guns, dynamite, bank and respawn: fetched now, decoded on the first gesture
    this.audio?.loadPack('frontier').catch(() => undefined)
    this.sound = this.audio ? new FrontierSound(this.audio) : null
    if (this.audio) {
      installUiSounds(this.audio)
    }
    root.classList.add('fr-root')
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'fr-canvas'
    this.canvas.setAttribute('aria-label', 'Frontier: the town of Perdition')
    root.append(this.canvas)
    const coarse = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
    this.touchUi = coarse
    this.settings = loadSettings()
    this.renderer = new Renderer(this.canvas, this.scene, this.cam.camera, tierHint(), 'ffa')
    this.scene.userData.owDay = DAY
    this.shooter = new ShooterCamera(this.cam.camera)
    // the first-person view model rides on the camera, so the camera joins the scene graph
    this.scene.add(this.cam.camera)
    this.applyGrade()
    this.sun = new DirectionalLight(0xff_e8_c8, 3.4)
    this.setupLights()
    this.wilds = new Wilds(this.scene, this.renderer.tier)
    this.wilds.apply(presetAt(DAY), SUN_DIR)
    this.hud = new Hud(root, {
      touch: coarse,
      onLeave: () => this.desk.tap(BTN_LEAVE),
      onExit: () => this.exit('quit'),
      onRiders: () => this.riders.open(),
      onKiller: () => this.killerPoster(),
      onMenu: (open) => this.onMenu(open),
      onHowTo: () => this.coach.show(),
    })
    this.desk = new DesktopControls(root, {
      onViewToggle: () => this.setView(this.settings.view === 'first' ? 'third' : 'first'),
      onShoulder: () => {
        this.settings.shoulder = this.settings.shoulder === 1 ? -1 : 1
        this.saveSettings()
      },
      onScoreboard: (open) => this.score.show(open && this.running),
      onLockLost: () => {
        this.lockLostAt = performance.now()
        if (!(this.coach.open || this.hud.menuOpen || this.exited)) {
          this.hud.setMenu(true)
        }
      },
    })
    this.touch = coarse ? new TouchControls(root) : null
    if (this.touch) {
      // the sticks' full-screen layer goes under the HUD: the HUD is see-through to touches
      // except its own buttons (the menu, the head count, the death card's link), which a
      // stick layer on top used to swallow
      root.insertBefore(this.touch.layer, this.hud.root)
    }
    this.arrows = new ThreatArrows(this.hud.root)
    this.coach = new Onboarding(root, this.hud.root, coarse, {
      onOpen: (open) => this.onCoachCard(open),
    })
    this.panel = new SettingsPanel(
      {
        settings: () => this.settings,
        onChange: (st) => {
          this.settings = st
          this.saveSettings()
          this.applyView()
        },
      },
      coarse,
    )
    this.hud.menuSettings.append(this.panel.el)
    this.net = new NetClient({
      onWelcome: () => this.onWelcome(),
      onControl: (m) => this.onControl(m),
      onEvent: (ev) => this.onEvent(ev),
      onPredictedShot: (x, z, aim, w) => this.predictedShot(x, z, aim, w),
    })
    this.riders = new Riders({
      root: this.hud.root,
      roster: () => this.net.roster,
      you: () => this.net.you,
      lobbyId: () => this.net.lobbyId,
    })
    this.score = new Scoreboard(this.hud.root, {
      roster: () => this.net.roster,
      you: () => this.net.you,
      mostWanted: () => this.net.town?.mostWanted ?? NONE,
    })
    this.sink = this.makeSink()
    // The scripted aim/walk/fire harness exists only in dev builds: never an aimbot API in prod.
    this.autopilot =
      import.meta.env.DEV && new URLSearchParams(location.search).has('debug')
        ? new Autopilot(this.net.grid)
        : null
    globalThis.addEventListener('resize', this.onResize)
    globalThis.addEventListener('keydown', this.onKey)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.onResize()
    this.applyView()
  }

  // --- view modes ---------------------------------------------------------------------------------

  /** Over the shoulder or first person (not the top-down map). */
  get shooterView(): boolean {
    return this.settings.view !== 'top'
  }

  get viewMode(): ViewMode {
    return this.settings.view
  }

  setView(v: ViewMode): void {
    if (v === this.settings.view) {
      return
    }
    this.settings.view = v
    this.saveSettings()
    this.applyView()
  }

  private saveSettings(): void {
    saveSettings(this.settings)
    this.panel.sync()
  }

  /** Put the camera, controls, crowd scale, fog and HUD into the current view mode. */
  private applyView(): void {
    const shooter = this.shooterView
    const was = this.root.dataset.view
    this.root.dataset.view = this.settings.view
    this.desk.setShooter(shooter)
    this.desk.adsToggle = this.settings.adsToggle
    this.touch?.setShooter(shooter)
    if (this.crowd) {
      this.crowd.readScale = shooter ? 1 : READ_SCALE
    }
    if (this.fx) {
      this.fx.flashScale = FLASH_SCALE[this.settings.view]
    }
    const pol = policyFor(this.settings.view, this.renderer.tier)
    const fog = this.scene.fog
    if (fog instanceof Fog) {
      fog.near = pol.fogNear
      fog.far = pol.fogFar
    }
    const sc = this.sun.shadow.camera
    sc.left = -pol.shadowHalf
    sc.right = pol.shadowHalf
    sc.top = pol.shadowHalf
    sc.bottom = -pol.shadowHalf
    sc.updateProjectionMatrix()
    if (!shooter) {
      // back to the map: the top-down camera owns the projection again
      this.cam.resize(window.innerWidth / window.innerHeight)
      this.cam.snap(this.own.x, this.own.z, Math.cos(this.aim), Math.sin(this.aim))
      CUT.radius.value = 0
    } else if (was === 'top' || was === undefined) {
      this.shooter.snap(this.own.x, this.own.z, this.aim)
    }
    if (this.viewModel) {
      this.viewModel.visible = this.settings.view === 'first'
    }
    this.panel.sync()
  }

  private onMenu(open: boolean): void {
    this.desk.enabled = !(open || this.coach.open)
    if (open) {
      this.desk.unlock()
      this.score.show(false)
    } else if (!(this.coach.open || this.touchUi)) {
      // "Back to the fight" is a click: a fine moment to take the mouse again
      this.desk.lock()
    }
  }

  private onCoachCard(open: boolean): void {
    this.desk.enabled = !(open || this.hud.menuOpen)
    if (open) {
      this.desk.unlock()
      this.hud.setMenu(false)
    } else if (!this.touchUi) {
      // "Ride" is a click: take the mouse straight into the fight
      this.desk.lock()
    }
  }

  private makeSink(): Sink {
    const game = this
    return {
      net: this.net,
      get fx() {
        return game.fx as Effects
      },
      get crowd() {
        return game.crowd as Crowd
      },
      hud: this.hud,
      audio: this.audio,
      kick: (a) => (this.shooterView ? this.shooter.kick(a) : this.cam.kick(a)),
      damageFrom: (from) => this.damageFrom(from),
      posOf: (id) => this.posOf(id),
      muzzleOf: (id, x, z, aim) =>
        this.crowd?.muzzle(id, x, z, aim, new Vector3()) ?? new Vector3(x, 1.3, z),
      showdowns: this.showdowns,
      get callouts() {
        return game.callouts
      },
      set callouts(c: Callout[]) {
        game.callouts = c
      },
      get killer() {
        return game.killer
      },
      set killer(k) {
        game.killer = k
      },
      onLeft: () => this.exit('left'),
      blocked: (id) => this.riders.isBlocked(id),
      fuses: this.fuses,
      get pickups() {
        return game.pickups as Pickups
      },
    }
  }

  private applyGrade(): void {
    const p = presetAt(DAY)
    const r = this.renderer
    r.grade.u('saturation').value = p.saturation * 0.92
    r.grade.u('contrast').value = p.contrast
    r.grade.u('lift').value = p.lift
    r.grade.u('exposure').value = p.exposure
    ;(r.grade.u('shadowTint').value as Vector3).set(...p.shadowTint)
    // Half the sunset warmth: Perdition is late afternoon, not a sunset.
    const [hr, hg, hb] = p.highTint
    ;(r.grade.u('highTint').value as Vector3).set((hr + 1) / 2, (hg + 1) / 2, (hb + 1) / 2)
    r.bloom.intensity = p.bloom * 0.8
    r.noise.blendMode.opacity.value = p.grain * 0.6
    r.vignette.darkness = 0.32
    RIM.color.value.copy(p.rimColor)
    RIM.strength.value = p.rim * 1.3
  }

  private setupLights(): void {
    const p = presetAt(DAY)
    this.scene.background = new Color(p.fog)
    this.scene.fog = new Fog(p.fog, 120, 260)
    const hemi = new HemisphereLight(p.hemiSky, p.hemiGround, p.hemiIntensity * 0.75)
    this.scene.add(hemi)
    this.sun.color.copy(p.sunColor).lerp(new Color(0xff_f2_e0), 0.5)
    this.sun.intensity = p.sunIntensity * 0.8
    this.sun.castShadow = true
    const size = this.renderer.spec.shadowSize
    this.sun.shadow.mapSize.set(size, size)
    const sc = this.sun.shadow.camera
    sc.left = -SHADOW_HALF
    sc.right = SHADOW_HALF
    sc.top = SHADOW_HALF
    sc.bottom = -SHADOW_HALF
    sc.near = 20
    sc.far = 100
    sc.updateProjectionMatrix()
    this.sun.shadow.bias = -0.0005
    this.sun.shadow.normalBias = 0.03
    this.scene.add(this.sun, this.sun.target)
  }

  /** Load assets and build the town while the socket connects. */
  async start(connect: Connect, onProgress: (f: number, label: string) => void): Promise<void> {
    this.transport = connect({
      onMessage: (d) => this.net.handle(d, performance.now()),
      onState: (st, detail) => this.onTransport(st, detail),
      onReopen: () => this.net.reset(),
    })
    this.net.attach(this.transport)
    const first = lookFor([], 0)
    const assets = await loadAssets(
      Math.min(8, this.renderer.gl.capabilities.getMaxAnisotropy()),
      first.look,
      (f) => onProgress(f * 0.6, 'Saddling up'),
    )
    // sprint, crouch, jump and reload clips: Frontier's own file, on top of the player's
    await loadMoves(assets).catch((e: unknown) => console.warn('moves.glb failed', e))
    if (this.disposed) {
      return
    }
    onProgress(0.65, 'Raising the town')
    this.town = buildTown(TOWN, assets, SUN_DIR, this.renderer.tier)
    this.scene.add(this.town.root)
    const inside = buildInterior(TOWN, presetAt(DAY).windows)
    shadeTown(this.town.root, inside)
    if (inside.lamps) {
      this.town.root.add(inside.lamps)
      inside.lamps.updateMatrix()
      inside.lamps.updateMatrixWorld(true)
    }
    this.scene.add(buildWilds(TOWN, this.renderer.tier))
    this.wilds.roll(TOWN)
    this.fx = new Effects(this.scene)
    this.pickups = new Pickups(this.scene, TOWN.pickups, assets.props)
    const near = this.nearCap()
    this.crowd = new Crowd(this.scene, assets, near)
    // real shadows for the nearest few: 4 on floor and legacy (each is a shadow-pass draw set)
    this.crowd.casters = near < 16 ? 4 : 6
    this.map = new Minimap(TOWN, this.touch ? 112 : 148)
    this.hud.mapSlot.append(this.map.el)
    this.viewModel = new ViewModel(assets)
    if (import.meta.env.DEV) {
      Reflect.set(globalThis, '__vm', this.viewModel)
      Reflect.set(globalThis, '__crowd', this.crowd)
    }
    // its own scene and lens, drawn over the world before the post chain
    this.renderer.setOverlay({
      scene: this.viewModel.scene,
      camera: this.viewModel.camera,
      enabled: false,
    })
    this.guide = new BankGuide(this.hud.root, this.net.grid)
    this.guide.prepare()
    onProgress(0.75, 'Fitting the posse')
    await this.crowd.prepare(['casual', 'worker', 'rugged', 'suit'])
    if (this.disposed) {
      return
    }
    onProgress(0.95, 'Riding in')
    shareDepthByKind(this.scene)
    this.renderer.probe.position.set(72, 1.7, 66)
    try {
      await this.renderer.gl.compileAsync(this.scene, this.cam.camera)
    } catch {
      // Older browsers compile on first use.
    }
    this.renderer.probe.captureNow()
    this.syncRoster()
    this.applyView()
    this.running = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
    this.hiddenTimer = setInterval(this.hiddenTick, TICK_MS)
    onProgress(1, '')
  }

  /**
   * Skinned cap: 8 on the floor tier, 6 on legacy, 16 above. Past the cap riders are VAT instances,
   * which read correctly from street level (hats included); each skinned rider costs its mixer, a
   * bone texture upload and 3–5 draws.
   */
  private nearCap(): number {
    const t = this.renderer.tier
    if (t === 'legacy') {
      return 6
    }
    return t === 'floor' ? 8 : 16
  }

  private onTransport(state: string, detail?: string): void {
    if (state === 'retrying') {
      this.connBanner = 'Connection lost. Reconnecting…'
    } else if (state === 'open') {
      this.connBanner = null
    } else if (state === 'closed' && !this.exited && this.running) {
      this.connBanner = `Disconnected${detail ? `: ${detail}` : ''}`
      setTimeout(() => this.exit('lost'), 2500)
    }
  }

  private onWelcome(): void {
    this.syncRoster()
  }

  private syncRoster(): void {
    const crowd = this.crowd
    if (!crowd) {
      return
    }
    for (const r of this.net.roster.values()) {
      this.dress(r)
    }
  }

  /** One rider's look, on the crowd (and on your first-person arms when it's you). */
  private dress(r: RosterEntry): void {
    const look = lookFor(r.loadout, r.id, r.bot)
    this.crowd?.setLook(r.id, look)
    if (r.id === this.net.you) {
      this.viewModel?.setLook(look)
    }
  }

  private onControl(m: ServerControl): void {
    if (m.type === 'roster_add') {
      this.dress(m.entry)
    } else if (m.type === 'roster_remove') {
      this.crowd?.remove(m.id)
      this.score.forget(m.id)
    }
    if (this.fx) {
      handleControl(this.sink, m)
    }
  }

  private onEvent(ev: WireEvent): void {
    if (this.fx && this.crowd) {
      handleEvent(this.sink, ev)
    }
    // a bag wears its dropper's saddlebag (spec §7): the server's `style` when it sends one,
    // else the loadout of the player who just fell where it dropped
    if (ev.type === EV_KILL) {
      this.lastVictim = ev.victim
      this.score.kill(ev.killer, ev.victim)
    } else if (ev.type === EV_DEPOSIT && ev.player === this.net.you) {
      this.coach.banked(ev.amount)
    } else if (ev.type === EV_BAG_DROP) {
      const bag = this.fx?.bags.get(ev.bagId)
      const style = (ev as { style?: number }).style
      const loadout = this.net.roster.get(this.lastVictim)?.loadout
      if (bag && style !== undefined) {
        bag.color = bagStyleColor(style)
      } else if (bag && loadout) {
        bag.color = bagColor(loadout)
      }
      this.lastVictim = NONE
    }
  }

  private predictedShot(x: number, z: number, aim: number, weapon: number): void {
    const fp = this.settings.view === 'first' && this.viewModel !== null
    const m = fp
      ? (this.viewModel?.muzzle(this.cam.camera, this.tmp) ?? this.tmp.set(x, 1.3, z))
      : (this.crowd?.muzzle(this.net.you, x, z, aim, this.tmp) ?? this.tmp.set(x, 1.3, z))
    const range = WEAPON_UI[weapon]?.range ?? MAX_RANGE
    const wall = rayToWall(this.net, x, z, aim, range)
    if (this.fx) {
      shotFx(this.sink, m, aim, wall, WEAPON_UI[weapon]?.shotFlag ?? 0)
    }
    const a = this.audio
    a?.play(shotSound(WEAPON_UI[weapon]?.shotFlag ?? 0), { gain: 1, priority: true })
    if (a && weapon === WEAPON_RIFLE && this.net.weapon.rounds > 1) {
      // the lever chambers the next round as the barrel settles
      a.play('rifleLever', { gain: 0.6, when: a.now + RIFLE_LEVER_DELAY })
    }
    this.lastShotAt = performance.now()
    if (this.shooterView) {
      // the view kicks up and settles; the crosshair blooms
      const long = weapon === WEAPON_RIFLE || weapon === WEAPON_SHOTGUN
      this.shooter.kickRecoil(long ? 0.05 : 0.03)
      this.viewModel?.fired(weapon)
      this.bloom = bloomAfterShot(weapon, this.bloom)
    } else {
      this.cam.kick(0.12)
    }
    haptic('shot')
  }

  /** The HUD's damage arc, turned into the view: straight ahead is up on the ring. */
  private damageFrom(from: { x: number; z: number }): void {
    const bearing = Math.atan2(from.z - this.own.z, from.x - this.own.x)
    // shooter views look along the yaw; top-down looks north (−z) with +x to the right
    const ahead = this.shooterView ? this.shooter.yaw : -Math.PI / 2
    this.hud.damageArc(Math.atan2(Math.sin(bearing - ahead), Math.cos(bearing - ahead)))
  }

  posOf(id: number): { x: number; z: number } | null {
    if (id === this.net.you) {
      return this.own
    }
    const r = this.remotes.find((v) => v.id === id)
    return r ? { x: r.x, z: r.z } : null
  }

  // --- input ------------------------------------------------------------------------------------

  private pointerAim(): number | null {
    const p = this.desk.pointer
    if (!p.has) {
      return null
    }
    this.ndc.set((p.x / viewport.w) * 2 - 1, -(p.y / viewport.h) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.cam.camera)
    const hit = this.ray.ray.intersectPlane(this.aimPlane, this.tmp)
    if (!hit) {
      return null
    }
    return Math.atan2(hit.z - this.own.z, hit.x - this.own.x)
  }

  private sampleInput(): { moveX: number; moveZ: number; aim: number; buttons: number } {
    if (this.shooterView) {
      return this.sampleShooter()
    }
    const d = this.desk.sample()
    const t = this.touch?.sample()
    let mx = d.mx
    let mz = d.mz
    let buttons = d.buttons
    let assist = d.assist
    let aim = d.aim ?? this.pointerAim()
    if (t) {
      if (Math.abs(t.mx) + Math.abs(t.mz) > 0) {
        mx = t.mx
        mz = t.mz
      }
      buttons |= t.buttons
      if (this.touch?.active) {
        aim = t.aim ?? aim
        assist = true
      }
    }
    const ap = this.autopilot
    if (ap?.active) {
      const st = ap.steer(this.own.x, this.own.z, (id) => this.posOf(id))
      if (ap.walking || st.mx !== 0 || st.mz !== 0) {
        mx = st.mx
        mz = st.mz
      }
      aim = st.aim ?? aim
      buttons |= st.buttons
    }
    if (aim === null) {
      // No pointer yet: face where you run.
      aim = Math.abs(mx) + Math.abs(mz) > 0 ? Math.atan2(mz, mx) : this.aim
    }
    if (assist && buttons & BTN_FIRE) {
      aim = assistAim(this.own.x, this.own.z, aim, this.remotes)
    }
    // The contextual key/button sends whatever the context says (bank, open, accept, call out).
    if (buttons & BTN_INTERACT && this.actionBit === BTN_CALLOUT) {
      buttons = (buttons & ~BTN_INTERACT) | BTN_CALLOUT
    }
    this.aim = aim
    return {
      moveX: Math.round(mx * 127),
      moveZ: Math.round(mz * 127),
      aim: radiansToAim(aim),
      buttons: buttons & ~LOCAL_BITS,
    }
  }

  /**
   * Shooter views: WASD / the left stick move relative to where the camera looks; the shot goes
   * along the yaw from you to whatever the crosshair rests on (`aim.ts`); touch FIRE repeats at
   * the gun's rate while held, with a light magnetism on each shot.
   */
  private sampleShooter(): { moveX: number; moveZ: number; aim: number; buttons: number } {
    const d = this.desk.sample()
    const t = this.touch?.sample()
    let mx = d.mx
    let mz = d.mz
    let buttons = d.buttons
    if (t) {
      if (Math.abs(t.mx) + Math.abs(t.mz) > 0) {
        mx = t.mx
        mz = t.mz
      }
      buttons |= t.buttons
      const now = performance.now()
      const held = this.touch?.fireHeld ?? false
      const interval = fireIntervalMs(this.net.weapon.weapon)
      if (t.buttons & BTN_FIRE || (held && now >= this.nextAuto)) {
        buttons |= BTN_FIRE
        this.nextAuto = now + interval
        this.magnet()
      } else if (held) {
        // a tick with the trigger up between repeats: the server fires on the press
        buttons &= ~BTN_FIRE
      }
    }
    if (this.devAdsOn) {
      buttons |= BTN_AIM
    }
    if (!this.desk.enabled) {
      // paused: stand still, hands off
      mx = 0
      mz = 0
      buttons = 0
    }
    const yaw = this.shooter.yaw
    const fwd = -mz
    const side = mx
    let wx = fwd * Math.cos(yaw) - side * Math.sin(yaw)
    let wz = fwd * Math.sin(yaw) + side * Math.cos(yaw)
    const ap = this.autopilot
    let aim = this.resolveShooterAim()
    if (ap?.active) {
      const st = ap.steer(this.own.x, this.own.z, (id) => this.posOf(id))
      if (ap.walking || st.mx !== 0 || st.mz !== 0) {
        wx = st.mx
        wz = st.mz
      }
      if (st.aim !== null) {
        aim = st.aim
        this.shooter.yaw = st.aim
      }
      buttons |= st.buttons
    }
    if (buttons & BTN_INTERACT && this.actionBit === BTN_CALLOUT) {
      buttons = (buttons & ~BTN_INTERACT) | BTN_CALLOUT
    }
    // crouch toggle and slide (local bits in, BTN_CROUCH out)
    buttons = this.stance.apply(buttons, this.net.pred.sprinting, this.net.alive)
    this.aim = aim
    return {
      moveX: Math.round(wx * 127),
      moveZ: Math.round(wz * 127),
      aim: radiansToAim(aim),
      buttons,
    }
  }

  /** The yaw the sim should fire along: from you to what the crosshair is on. */
  private resolveShooterAim(): number {
    const cam = this.cam.camera
    const origin = this.tmp.copy(cam.position)
    return resolveAim(
      origin,
      this.shooter.yaw,
      this.shooter.pitch,
      this.own.x,
      this.own.z,
      this.net.grid,
      this.remotes,
      this.aimRes,
    ).yaw
  }

  /** Touch only: on the shot, nudge the view onto the nearest rider within 2.5°. */
  private magnet(): void {
    const pull = assistPull(
      this.cam.camera.position,
      this.shooter.yaw,
      this.shooter.pitch,
      this.remotes,
    )
    if (pull) {
      this.shooter.turn(pull.dYaw, pull.dPitch, this.settings.view === 'first')
    }
  }

  /** Mouse, right stick and thumb look → the camera, once per rendered frame. */
  private applyLook(): void {
    this.turned.yaw = 0
    this.turned.pitch = 0
    if (!(this.shooterView && this.desk.enabled && this.net.alive)) {
      this.desk.takeLook(this.look)
      this.touch?.takeLook(this.look)
      return
    }
    const first = this.settings.view === 'first'
    const inv = this.settings.invertY ? -1 : 1
    // aiming down the sights slows the look with the zoom
    const zoom = 1 - this.shooter.ads * (first ? 0.32 : 0.28)
    const m = this.desk.takeLook(this.look)
    let dYaw = m.x * 0.0022 * this.settings.mouseSens * zoom
    let dPitch = -m.y * 0.0022 * this.settings.mouseSens * zoom * inv
    if (this.touch) {
      const tl = this.touch.takeLook(this.look)
      const friction = this.touch.looking
        ? assistFriction(
            this.cam.camera.position,
            this.shooter.yaw,
            this.shooter.pitch,
            this.remotes,
          )
        : 1
      const k = 0.0055 * this.settings.touchSens * zoom * friction
      dYaw += tl.x * k
      dPitch += -tl.y * k * inv
    }
    if (dYaw !== 0 || dPitch !== 0) {
      this.shooter.turn(dYaw, dPitch, first)
      this.turned.yaw = dYaw
      this.turned.pitch = dPitch
    }
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (this.coach.key(e.code)) {
      e.preventDefault()
      return
    }
    if (e.code === 'Escape' && performance.now() - this.lockLostAt > 300) {
      // (the Esc that let go of the pointer lock already opened the menu)
      this.hud.toggleMenu()
    }
  }

  // --- frame ------------------------------------------------------------------------------------

  /**
   * The 20 Hz input/prediction tick plus own and remote positions. Runs from the render loop, or
   * from a timer while the tab is hidden (rAF stops; the socket and your input must not).
   */
  private simulate(now: number): number {
    const t0 = performance.now()
    const elapsed = Math.max(0, now - this.last)
    // The scene steps at most 100 ms; input ticks catch up on up to 250 ms (a GC or a shader
    // compile) so this client's clock doesn't fall behind the server's. Longer stalls are left to
    // `TickClock`, which skips frame numbers forward.
    const dtMs = Math.min(100, elapsed)
    this.last = now
    // `now` is the frame's vsync stamp: a steady step, unlike performance.now() at callback time.
    this.renderTick = this.net.renderTick(now)
    this.acc += Math.min(MAX_CATCH_UP_MS, elapsed)
    const period = this.net.tickPeriod
    let ticks = 0
    while (this.acc >= period && ticks < MAX_TICKS_PER_FRAME) {
      this.acc -= period
      ticks++
      const intent = this.sampleInput()
      this.net.tick(intent, this.renderTick, t0)
      this.showdownInput(intent.buttons)
    }
    if (this.acc > period * MAX_TICKS_PER_FRAME) {
      this.acc = 0
    }
    this.ticksThisFrame = ticks
    this.net.localRenderPose(Math.min(1, this.acc / period), dtMs, this.own)
    this.remotes.length = 0
    for (const v of this.net.views(this.renderTick)) {
      this.remotes.push(v)
    }
    return dtMs
  }

  private readonly hiddenTick = () => {
    if (this.running && document.hidden) {
      this.simulate(performance.now())
    }
  }

  private readonly frame = (now: number) => {
    if (!this.running) {
      return
    }
    this.raf = requestAnimationFrame(this.frame)
    const t0 = performance.now()
    const dtMs = this.simulate(now)
    const dt = dtMs / 1000
    const t1 = performance.now()
    this.updateScene(dt, now / 1000)
    this.updateHud(now / 1000)
    this.perf.simMs = t1 - t0
    this.perf.frameMs = performance.now() - t0
    this.audio?.update()
    this.renderer.label = 'frontier'
    this.renderer.adapt(dtMs, true)
    this.renderer.render(dt)
    if (this.trace.on) {
      this.pushTrace(now, dtMs, performance.now() - t0)
    }
  }

  private pushTrace(now: number, dtMs: number, cpuMs: number): void {
    const r = this.traceRow
    const rem = this.remotes[0]
    r[0] = now
    r[1] = dtMs
    r[2] = this.own.x
    r[3] = this.own.z
    r[4] = this.cam.camera.position.x
    r[5] = this.cam.camera.position.z
    r[6] = this.net.pred.x
    r[7] = this.net.pred.z
    r[8] = this.net.srvX
    r[9] = this.net.srvZ
    r[10] = rem?.x ?? Number.NaN
    r[11] = rem?.z ?? Number.NaN
    r[12] = this.renderTick
    r[13] = this.ticksThisFrame
    r[14] = cpuMs
    this.trace.push(r)
  }

  private showdownInput(buttons: number): void {
    for (const sd of this.showdowns.values()) {
      if (sd.opponent !== NONE && sd.called && !sd.shot && buttons & BTN_FIRE) {
        sd.shot = true
        const localMs = Math.round(performance.now() - sd.callAt)
        this.net.sendControl(JSON.stringify({ type: 'showdown_shot', showdownId: sd.id, localMs }))
        this.audio?.play('fire', { priority: true })
      }
    }
  }

  private updateScene(dt: number, nowS: number): void {
    this.dtS = dt
    const crowd = this.crowd
    const fx = this.fx
    if (!(crowd && fx)) {
      return
    }
    const s = this.net.self
    const list = this.crowdList
    list.length = 0
    if (s && this.net.you >= 0) {
      const speed =
        Math.hypot(this.net.pred.x - this.net.prev.x, this.net.pred.z - this.net.prev.z) * TICK_HZ
      const dirX = this.net.pred.x - this.net.prev.x
      const dirZ = this.net.pred.z - this.net.prev.z
      const len = Math.hypot(dirX, dirZ) || 1
      list.push({
        id: this.net.you,
        x: this.own.x,
        z: this.own.z,
        aim: this.aim,
        vx: (dirX / len) * speed,
        vz: (dirZ / len) * speed,
        anim: this.shooterAnim(
          ownAnim(
            s.flags,
            dodgeAnim(this.net.pred),
            speed > 0.3,
            s.reloadTicks > 0,
            s.channelKind,
            jumpAnim(this.net.pred.jumpTicks, this.net.pred.vaultStep),
          ),
          speed > 0.3,
        ),
        flags: ownFlags(s.flags, s.protectTicks > 0),
        stance: this.ownStance(),
        pitch: this.shooterView ? this.shooter.pitch : 0,
        self: true,
        weapon: this.net.weapon.weapon,
      })
    }
    for (const [i, r] of this.remotes.entries()) {
      let row = this.crowdRows[i]
      if (!row) {
        row = { id: 0, x: 0, z: 0, aim: 0, vx: 0, vz: 0, anim: 0, stance: 0, flags: 0, self: false }
        this.crowdRows.push(row)
      }
      row.id = r.id
      row.x = r.x
      row.z = r.z
      row.aim = r.aim
      row.vx = r.vx
      row.vz = r.vz
      row.anim = r.anim
      row.stance = r.stance
      row.flags = r.flags
      list.push(row)
    }
    if (!this.net.alive && this.wasAlive) {
      // down: on your feet, sights dropped, for the next life
      this.stance.reset()
      this.desk.dropAds()
      this.touch?.setAds(false)
    }
    if (this.net.alive && !this.wasAlive) {
      // (re)spawned: face into town until the stick or the mouse says otherwise
      this.aim = spawnFacing(this.own)
      this.cam.snap(this.own.x, this.own.z, Math.cos(this.aim), Math.sin(this.aim))
      this.shooter.snap(this.own.x, this.own.z, this.aim)
      this.hatlessSeen.clear()
      // the first ride into town on this device: how to play
      this.coach.maybeShow()
    }
    this.landings(list)
    const shooter = this.shooterView
    const first = this.settings.view === 'first'
    const speed0 = list[0]?.self ? Math.hypot(list[0].vx, list[0].vz) : 0
    if (shooter) {
      this.applyLook()
      this.shooter.update({
        x: this.own.x,
        z: this.own.z,
        speed: speed0,
        lift: this.jumpLift(),
        first,
        ads: this.net.alive && this.adsHeld(),
        fov: first ? this.settings.fovFirst : this.settings.fovThird,
        shoulder: this.settings.shoulder,
        far: policyFor(this.settings.view, this.renderer.tier).far,
        grid: this.net.grid,
        dt,
        duck: this.duckHeight(),
        dead: this.net.alive ? null : this.own,
      })
      crowd.hideSelf = this.net.alive && (first || this.shooter.closeness > 0.85)
    } else {
      this.cam.update(this.own.x, this.own.z, Math.cos(this.aim), Math.sin(this.aim), dt)
      crowd.hideSelf = false
    }
    const cx = shooter ? this.own.x : this.cam.target.x
    const cz = shooter ? this.own.z : this.cam.target.z
    crowd.update(list, cx, cz, dt, nowS)
    this.updateViewModel(dt, speed0)
    fx.eye = first ? this.own : null
    this.wilds.tick(dt)
    this.sound?.steps(
      {
        id: this.net.you,
        x: this.own.x,
        z: this.own.z,
        moving: ownMoving(list[0], this.net.pred.rollTicks > 0),
      },
      this.remotes,
      (id) => wearsSpurs(this.net.roster.get(id)?.loadout),
      nowS,
    )
    // the sun's shadow box: around the map's centre top-down, ahead of you where you look otherwise
    const ahead = policyFor(this.settings.view, this.renderer.tier).shadowAhead
    const focus = shooter
      ? this.tmp.set(
          this.own.x + Math.cos(this.shooter.yaw) * ahead,
          0,
          this.own.z + Math.sin(this.shooter.yaw) * ahead,
        )
      : this.tmp.copy(this.cam.target)
    this.sun.target.position.copy(focus)
    this.sun.position.copy(focus).addScaledVector(SUN_DIR, 60)
    this.updateCut()
    this.updateRings(nowS)
    const town = this.net.town
    const spot =
      town && town.strongboxState !== BOX_NONE ? TOWN.strongboxes[town.strongboxSpot] : undefined
    fx.setStrongbox(
      spot?.x ?? 0,
      spot?.z ?? 0,
      spot !== undefined,
      town?.strongboxState === BOX_OPENING,
    )
    const aiming = this.touch?.aiming || this.desk.pointer.has || this.desk.usingPad
    fx.setAimLine(
      this.own.x,
      this.own.z,
      this.aim,
      this.net.alive && aiming && !shooter
        ? (WEAPON_UI[this.net.weapon.weapon]?.range ?? MAX_RANGE)
        : null,
      Boolean(this.touch?.aiming),
    )
    this.pickups?.update(nowS, (x, y, z) => fx.spark(x, y, z))
    fx.update(dt, nowS)
    if (shooter) {
      // your ears are where your head is, facing the way you look
      this.audio?.setListener(
        this.own.x,
        1.6,
        this.own.z,
        Math.cos(this.shooter.yaw),
        0,
        Math.sin(this.shooter.yaw),
      )
    } else {
      this.audio?.setListener(this.own.x, 8, this.own.z + 4, 0, -0.8, -0.6)
    }
    this.wasAlive = this.net.alive
  }

  /**
   * Over the shoulder your rider raises the gun while you aim down the sights, and for a moment
   * after a shot, instead of letting it hang at his side.
   */
  private shooterAnim(anim: number, moving: boolean): number {
    if (!this.shooterView || anim !== ANIM_IDLE || moving) {
      return anim
    }
    return this.adsHeld() || performance.now() - this.lastShotAt < 1200 ? ANIM_AIM : anim
  }

  /**
   * How high your vault or hop carries the camera right now: `peak·4t(1−t)` over the move, with
   * t interpolated between ticks so the arc is smooth at any frame rate.
   */
  private jumpLift(): number {
    const pred = this.net.pred
    if (pred.jumpTicks <= 0) {
      return 0
    }
    const vault = pred.vaultStep > 0
    const total = vault ? VAULT_TICKS : HOP_TICKS
    const t = Math.min(1, Math.max(0, (total - pred.jumpTicks + this.acc / TICK_MS) / total))
    return (vault ? VAULT_PEAK_M : HOP_PEAK_M) * 4 * t * (1 - t)
  }

  /** Your stance bits, as remote riders see them (crouched, on the sights, sprinting). */
  private ownStance(): number {
    const pred = this.net.pred
    let st = 0
    if (this.stance.crouched) {
      st |= STANCE_CROUCH
    }
    if (this.adsHeld() && !pred.sprinting) {
      st |= STANCE_ADS
    }
    if (pred.sprinting) {
      st |= STANCE_SPRINT
    }
    return st
  }

  /** How far your stance lowers the eye (m): crouched, or sliding. */
  private duckHeight(): number {
    if (sliding(this.net.pred)) {
      return 0.6
    }
    return this.stance.crouched ? 0.45 : 0
  }

  /** RMB, LT or the touch AIM toggle. */
  private adsHeld(): boolean {
    return this.desk.aimHeld || (this.touch?.ads ?? false) || this.devAdsOn
  }

  private updateViewModel(dt: number, speed: number): void {
    const vm = this.viewModel
    if (!vm) {
      return
    }
    const on = this.settings.view === 'first' && this.net.alive
    vm.visible = on
    this.renderer.setOverlay({ scene: vm.scene, camera: vm.camera, enabled: on })
    if (!on) {
      return
    }
    const s = this.net.self
    const yaw = this.shooter.yaw
    // a wall close ahead pushes the gun back rather than through it
    const wall = rayGrid(
      this.net.grid,
      { ox: this.own.x, oz: this.own.z, dx: Math.cos(yaw), dz: Math.sin(yaw), maxDist: 1.2 },
      BLOCK_SIGHT,
    )
    const cam = this.cam.camera
    vm.setLens(cam.aspect, cam.fov)
    // the sun, turned into the lens's frame (the view model lives in camera space)
    this.vmSun.copy(SUN_DIR).applyQuaternion(this.vmQ.copy(cam.quaternion).invert())
    const pred = this.net.pred
    const reloading = ((s?.flags ?? 0) & SELF_RELOADING) !== 0
    vm.update(
      {
        dt,
        lookYaw: this.turned.yaw,
        lookPitch: this.turned.pitch,
        speed,
        sprinting: pred.sprinting,
        ads: this.adsHeld(),
        crouched: this.stance.crouched,
        sliding: sliding(pred),
        lift: this.jumpLift(),
        reload: reloading && s ? 1 - s.reloadTicks / RELOAD_TICKS : null,
        weapon: this.devWeapon ?? this.net.weapon.weapon,
        wall,
      },
      this.vmSun,
    )
  }

  /** A thud of boots for every rider (you included) coming down from a vault or a hop. */
  private landings(list: readonly CrowdPlayer[]): void {
    for (const p of list) {
      const was = this.airborne.get(p.id) ?? 0
      const now = p.anim === ANIM_VAULT || p.anim === ANIM_HOP ? p.anim : 0
      if (was !== now) {
        this.airborne.set(p.id, now)
      }
      if (was !== 0 && now === 0 && p.anim !== ANIM_DEAD) {
        const vault = was === ANIM_VAULT
        this.audio?.footstep(onBoardwalk(p.x, p.z) ? 'wood' : 'dirt', {
          gain: (vault ? 1.3 : 0.8) * (p.self ? 1 : 0.8),
          rate: vault ? 0.82 : 0.95,
          pos: { x: p.x, y: 0, z: p.z },
        })
      }
    }
  }

  /**
   * Top-down: a 4.5 m circle around you, and the roof of the building you stand in fades. Over the
   * shoulder: roofs stay solid; only what stands between the lens and your rider (a porch roof, a
   * wall edge) dithers away inside a 1.2 m circle. First person: nothing fades.
   */
  private updateCut(): void {
    const view = this.settings.view
    if (view === 'first') {
      CUT.radius.value = 0
      CUT.bid.value = -1
      return
    }
    const cam = this.cam.camera
    const p = this.tmp.set(this.own.x, 1, this.own.z)
    const depth = -this.cutView.copy(p).applyMatrix4(cam.matrixWorldInverse).z
    p.project(cam)
    const size = this.renderer.gl.getDrawingBufferSize(this.cutSize)
    CUT.screen.value.set((p.x * 0.5 + 0.5) * size.x, (p.y * 0.5 + 0.5) * size.y, depth)
    const shooter = view === 'third'
    const dist = shooter ? Math.max(0.5, depth) : this.cam.distance
    const pxPerM = size.y / (2 * Math.tan((cam.fov * Math.PI) / 360) * dist)
    CUT.radius.value = (shooter ? 1.2 : 4.5) * pxPerM
    if (shooter) {
      CUT.bid.value = -1
      return
    }
    let bid = -1
    for (const [i, b] of (this.town?.roofs ?? []).entries()) {
      if (
        this.own.x > b.x &&
        this.own.x < b.x + b.w &&
        this.own.z > b.z &&
        this.own.z < b.z + b.d
      ) {
        bid = i
      }
    }
    CUT.bid.value = bid
  }

  private updateRings(nowS: number): void {
    const fx = this.fx
    const s = this.net.self
    if (!(fx && s)) {
      return
    }
    fx.beginRings()
    const carrying = s.carried > 0
    for (const z of TOWN.zones) {
      fx.ring(z.x, z.z, z.r, carrying ? RING_GOLD : RING_ZONE, carrying ? 3 : 0)
    }
    for (const [i, sp] of TOWN.pickups.entries()) {
      if (this.pickups?.isAvailable(i)) {
        fx.ring(sp.x, sp.z, 1.2, PICKUP_RING, 4)
      }
    }
    // your own ground ring is a top-down readability aid: over the shoulder it's just in the way
    if (this.net.alive && !this.shooterView) {
      const mine = s.flags & SELF_MOST_WANTED ? RING_MINE_MW : RING_MINE
      fx.ring(this.own.x, this.own.z, 0.7, mine, 0)
    }
    const now = performance.now()
    this.callouts = this.callouts.filter((c) => c.until > now)
    for (const c of this.callouts) {
      for (const id of [c.challenger, c.target]) {
        const p = this.posOf(id)
        if (p) {
          fx.ring(p.x, p.z, 1.1, RING_CALLOUT, 10)
        }
      }
    }
    for (const sd of this.showdowns.values()) {
      fx.ring(sd.cx, sd.cz, 5.5, RING_SHOWDOWN, sd.called ? 0 : 2)
    }
    for (const r of this.remotes) {
      if (r.flags & EF_MOST_WANTED && r.flags & EF_ALIVE) {
        fx.ring(r.x, r.z, 0.85 + Math.sin(nowS * 6) * 0.05, RING_MW, 0)
      }
    }
  }

  /** The death card's link: your killer's wanted poster (Report and Block on it). */
  private killerPoster(): void {
    const k = this.killer
    const who = k ? this.riders.person(k.id) : null
    if (who) {
      this.riders.poster(who.name)
    }
  }

  private calledBy(): number {
    const now = performance.now()
    const c = this.callouts.find(
      (x) => x.target === this.net.you && x.until > now && !this.riders.isBlocked(x.challenger),
    )
    return c ? c.challenger : NONE
  }

  private updateHud(nowS: number): void {
    const s = this.net.self
    // The banner is only ever the connection's state: "Riding in…" until the first snapshot
    // (cleared the moment you're in town), "Reconnecting…" while the socket retries.
    const duel = ((s?.flags ?? 0) & SELF_IN_SHOWDOWN) !== 0
    this.hud.banner(duel ? null : (this.connBanner ?? (s ? null : 'Riding into Perdition…')))
    if (!s) {
      return
    }
    const action = this.net.alive
      ? currentAction({
          net: this.net,
          layout: TOWN,
          x: this.own.x,
          z: this.own.z,
          aim: this.aim,
          remotes: this.remotes,
          calledBy: this.calledBy(),
          nowS,
        })
      : null
    this.actionBit = action?.bit ?? 0
    this.touch?.setAction(action?.bit ?? 0, action?.label ?? null)
    this.touch?.setCrouched(this.stance.crouched)
    const weapon = this.net.weapon
    this.touch?.setThrow(weapon.dynamite && this.net.alive)
    const wui = WEAPON_UI[weapon.weapon] ?? WEAPON_UI[WEAPON_REVOLVER]
    const ch = CHANNEL_LABEL[s.channelKind]
    this.hud.update({
      hp: s.hp,
      ammo: this.net.ammo,
      weapon: { label: wui?.label ?? '', max: wui?.max ?? REVOLVER_ROUNDS },
      dynamite: weapon.dynamite,
      reload: s.flags & SELF_RELOADING ? 1 - s.reloadTicks / RELOAD_TICKS : null,
      carried: s.carried,
      banked: this.net.banked,
      players: this.net.roster.size,
      mostWanted: (s.flags & SELF_MOST_WANTED) !== 0,
      channel:
        ch && s.channelKind !== CHANNEL_NONE ? { label: ch[0], t: s.channelTicks / ch[1] } : null,
      prompt: this.touch ? (action?.touchPrompt ?? null) : (action?.prompt ?? null),
      protectedFor: s.protectTicks,
      lowPower: this.renderer.lowPower,
    })
    if (this.shooterView) {
      this.crosshair(s.flags)
    } else {
      this.hud.setCrosshair(false, 0, false)
      this.reticle(s.flags)
    }
    this.sounds(s.flags)
    this.coaching(s.carried)
    if (this.net.alive) {
      this.lastCarry = s.carried
      this.hud.alive()
    } else {
      const k = this.killer
      const name = k && k.id !== NONE ? this.net.name(k.id) : null
      const lvl = k && k.id !== NONE ? this.net.roster.get(k.id)?.level : undefined
      const carry =
        this.lastCarry > 0
          ? `Your $${this.lastCarry.toLocaleString('en-US')} is in the dirt.`
          : 'You carried nothing.'
      const person = this.riders.live && k !== null && this.riders.person(k.id) !== null
      this.hud.death(name, lvl ? `Level ${lvl}. ${carry}` : carry, s.respawnTicks / TICK_HZ, person)
    }
    this.announceMostWanted()
    this.arrows.update(
      this.cam.camera,
      this.own.x,
      this.own.z,
      this.remotes,
      this.fx?.bags.values() ?? [],
    )
    this.guide?.update(
      this.cam.camera,
      this.own.x,
      this.own.z,
      s.carried,
      this.net.alive,
      zoneAt(TOWN, this.own.x, this.own.z)?.kind === 'bank',
      this.dtS,
    )
    const portrait = viewport.h > viewport.w
    this.hud.rotateHint(this.touchUi && portrait && this.shooterView && this.net.alive)
    if (this.map && nowS - this.mapAt > 0.1) {
      this.mapAt = nowS
      this.drawMap(nowS)
    }
  }

  /** The shooter crosshair: centred, ticks opening with the gun's spread and the shot bloom. */
  private crosshair(flags: number): void {
    const s = this.net.self
    const w = this.net.weapon.weapon
    const moving =
      this.net.alive &&
      Math.hypot(this.net.pred.x - this.net.prev.x, this.net.pred.z - this.net.prev.z) > 0.01
    const deadEyeReady = (flags & SELF_DEAD_EYE_READY) !== 0
    // the sim's bloom, mirrored: it settles 0.3° a tick
    this.bloom = Math.max(0, this.bloom - this.dtS * BLOOM_DECAY_DEG * TICK_HZ)
    const pred = this.net.pred
    const ads = this.adsHeld()
    const deg = spreadDeg(
      {
        weapon: w,
        ads,
        crouched: this.stance.crouched,
        moving,
        sliding: sliding(pred),
        airborne: airborne(pred),
        bloom: this.bloom,
      },
      deadEyeReady,
    )
    const gap = Math.max(2, spreadPx(deg, this.cam.camera.fov, viewport.h))
    const range = WEAPON_UI[w]?.range ?? MAX_RANGE
    const onTarget = this.aimRes.target >= 0 && this.aimRes.range <= range
    // first person on the sights: the gun's own sights are the crosshair; sprinting: no crosshair
    const sighted = this.settings.view === 'first' && (this.viewModel?.motion.pose.ads ?? 0) > 0.6
    const show =
      this.net.alive &&
      !this.hud.menuOpen &&
      !this.coach.open &&
      this.settings.view !== 'top' &&
      !(sighted && !(s && s.deadEyeTicks > 0)) &&
      !pred.sprinting
    const closing =
      s && s.deadEyeTicks > 0 ? Math.min(1, s.deadEyeTicks / DEAD_EYE_CLOSE_TICKS) : null
    this.hud.setCrosshair(true, gap, onTarget)
    this.hud.setReticle(viewport.w / 2, viewport.h / 2, show, closing, deadEyeReady)
  }

  /** The once-per-device coach lines, triggered by what just happened. */
  private coaching(carried: number): void {
    const alive = this.net.alive
    if (alive && carried > 0 && this.wasCarry === 0) {
      this.coach.firstCarry(carried)
    }
    const inZone = alive && carried > 0 && zoneAt(TOWN, this.own.x, this.own.z)?.kind === 'bank'
    if (inZone && !this.wasInZone) {
      this.coach.atWindow()
    }
    this.wasInZone = inZone
    if (!alive && this.wasCarry > 0 && this.lastCarry > 0) {
      this.coach.diedCarrying(this.lastCarry)
    }
    this.wasCarry = alive ? carried : 0
    // desktop, shooter view, no mouse yet: say how to take it
    const needClick =
      !this.touchUi &&
      this.shooterView &&
      alive &&
      this.desk.enabled &&
      !this.desk.locked &&
      !this.desk.usingPad &&
      this.autopilot === null
    this.hud.clickHint(needClick)
  }

  private reticle(flags: number): void {
    const p = this.desk.pointer
    const touchAim = this.touch?.aiming ?? false
    const deadEye = (flags & SELF_HOLSTERED) !== 0 || this.net.self?.deadEyeTicks !== 0
    const aimingHeld = touchAim || this.desk.aimHeld
    let x = p.x
    let y = p.y
    if (!p.has || touchAim) {
      // Project the aim point ahead of the player.
      const d = 6
      const v = this.tmp
        .set(this.own.x + Math.cos(this.aim) * d, 1.2, this.own.z + Math.sin(this.aim) * d)
        .project(this.cam.camera)
      x = (v.x * 0.5 + 0.5) * viewport.w
      y = (-v.y * 0.5 + 0.5) * viewport.h
    }
    const s = this.net.self
    const closing =
      s && s.deadEyeTicks > 0 ? Math.min(1, s.deadEyeTicks / DEAD_EYE_CLOSE_TICKS) : null
    const ready = (flags & SELF_DEAD_EYE_READY) !== 0
    const show = this.net.alive && (p.has || touchAim) && !this.hud.menuOpen
    this.hud.setReticle(
      x,
      y,
      show,
      deadEye && (closing !== null || aimingHeld) ? closing : null,
      ready,
    )
  }

  private sounds(flags: number): void {
    const reloading = (flags & SELF_RELOADING) !== 0
    if (reloading && !this.wasReloading) {
      this.audio?.play(RELOAD_SOUND[this.net.weapon.weapon] ?? 'cocking', { gain: 0.7 })
    }
    this.wasReloading = reloading
    const ready = (flags & SELF_DEAD_EYE_READY) !== 0
    if (ready && !this.wasReady) {
      // The spur click: deliberately not a bell.
      this.audio?.play('holster', { gain: 0.9, rate: 1.6, priority: true })
    }
    this.wasReady = ready
    const showdown = (flags & SELF_IN_SHOWDOWN) !== 0
    // no menu sound while your showdown waits for its call
    this.audio?.hushUi(showdown)
  }

  /** The Most Wanted changes hands: say so, with what their head is worth. */
  private announceMostWanted(): void {
    const mw = this.net.town?.mostWanted ?? NONE
    if (mw === this.lastMw) {
      return
    }
    this.lastMw = mw
    if (mw === NONE) {
      return
    }
    if (mw === this.net.you) {
      this.hud.toast("YOU'RE MOST WANTED: +50% ON YOUR HEAD", 'gold', 2600)
    } else {
      this.hud.feed(`★ ${this.net.name(mw)} is Most Wanted: +50% bounty`, 'gold')
    }
  }

  private drawMap(nowS: number): void {
    const town = this.net.town
    const mwId = town?.mostWanted ?? NONE
    let mw: { x: number; z: number; you: boolean } | null = null
    if (town && mwId === this.net.you) {
      mw = { x: this.own.x, z: this.own.z, you: true }
    } else if (town && mwId !== NONE) {
      mw = { x: town.mwX * 0.6, z: town.mwZ * 0.6, you: false }
    }
    const spot =
      town && town.strongboxState !== BOX_NONE ? TOWN.strongboxes[town.strongboxSpot] : undefined
    const caller = this.calledBy()
    this.map?.draw(
      {
        self: this.net.alive ? { x: this.own.x, z: this.own.z, aim: this.aim } : null,
        others: this.remotes.filter((r) => r.flags & EF_ALIVE),
        bags: [...(this.fx?.bags.values() ?? [])],
        strongbox: spot ?? null,
        mostWanted: mw,
        callout: caller === NONE ? null : this.posOf(caller),
        heading: this.shooterView ? this.shooter.yaw : null,
        bank:
          this.guide && this.net.alive && (this.net.self?.carried ?? 0) > 0
            ? this.guide.nearest(this.own.x, this.own.z)
            : null,
      },
      nowS,
    )
  }

  // --- lifecycle --------------------------------------------------------------------------------

  private readonly onResize = () => {
    this.cam.resize(window.innerWidth / window.innerHeight)
    this.renderer.resize()
    this.cam.resize(window.innerWidth / window.innerHeight)
  }

  private readonly onVisibility = () => {
    if (document.hidden) {
      this.audio?.suspend()
    } else {
      this.audio?.resume()
      this.last = performance.now()
    }
  }

  /** Start the music and ambience on the first gesture (iOS needs the AudioContext created inside one). */
  unlockAudio(): void {
    this.audio?.unlock()
    this.sound?.start(DAY)
  }

  leave(): void {
    this.desk.tap(BTN_LEAVE)
  }

  exit(reason: 'left' | 'quit' | 'lost'): void {
    if (this.exited) {
      return
    }
    this.exited = true
    this.opts.onExit(reason)
  }

  dispose(): void {
    this.disposed = true
    this.running = false
    cancelAnimationFrame(this.raf)
    if (this.hiddenTimer) {
      clearInterval(this.hiddenTimer)
    }
    this.transport?.close()
    for (const id of [...this.fuses.keys()]) {
      stopFuse(this.fuses, id)
    }
    this.sound?.dispose()
    this.audio?.hushUi(false)
    globalThis.removeEventListener('resize', this.onResize)
    globalThis.removeEventListener('keydown', this.onKey)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.desk.dispose()
    this.touch?.dispose()
    this.score.dispose()
    this.coach.dispose()
    this.hud.dispose()
    this.crowd?.dispose()
    this.town?.dispose()
    this.renderer.probe.dispose()
    this.renderer.composer.dispose()
    this.renderer.gl.dispose()
    this.canvas.remove()
    this.root.classList.remove('fr-root')
  }

  /** Dev harness only: look as if the mouse moved (pointer lock doesn't run headless). */
  devLook(dx: number, dy: number): void {
    this.desk.injectLook(dx, dy)
  }

  /** Dev harness only: show a weapon in the first-person hands (null: the one you hold). */
  devShowWeapon(w: number | null): void {
    this.devWeapon = w
  }

  /** Dev harness only: hold or release aim-down-sights. */
  devAds(on: boolean): void {
    this.touch?.setAds(on)
    this.devAdsOn = on
  }

  /** Dev harness only: close the How to play card without a click. */
  devCloseHowTo(): void {
    this.coach.close()
  }

  /** Numbers for the perf overlay and the Playwright harness. */
  debug(): Record<string, unknown> {
    return {
      ...this.perf,
      tier: this.renderer.tier,
      draws: this.renderer.frame.calls,
      tris: this.renderer.frame.triangles,
      crowd: this.crowd?.stats,
      remotes: this.remotes.length,
      reconErrCm: Math.round(this.net.reconErr * 1000) / 10,
      snaps: this.net.snaps,
      jitterTicks: Math.round(this.net.clock.jitter * 100) / 100,
      kbIn: Math.round(this.net.bytesIn / 1024),
      kbOut: Math.round(this.net.bytesOut / 1024),
      camDist: Math.round(this.cam.distance),
      view: this.settings.view,
      yaw: Math.round(this.shooter.yaw * 1000) / 1000,
      pitch: Math.round(this.shooter.pitch * 1000) / 1000,
      aimTarget: this.aimRes.target,
      locked: this.desk.locked,
      howto: this.coach.open,
      menu: this.hud.menuOpen,
      guide: this.guide?.state ?? null,
      fov: Math.round(this.cam.camera.fov * 10) / 10,
      textures: this.renderer.gl.info.memory.textures,
      geometries: this.renderer.gl.info.memory.geometries,
      x: Math.round(this.own.x * 10) / 10,
      z: Math.round(this.own.z * 10) / 10,
      you: this.net.you,
      alive: this.net.alive,
      hp: this.net.self?.hp ?? 0,
      carried: this.net.self?.carried ?? 0,
      banked: this.net.banked,
      selfFlags: this.net.self?.flags ?? 0,
      channel: this.net.self?.channelKind ?? 0,
      weapon: this.net.weapon,
      ammo: this.net.ammo,
      mostWanted: this.net.town?.mostWanted ?? NONE,
      strongbox: this.net.town
        ? {
            spot: this.net.town.strongboxSpot,
            state: this.net.town.strongboxState,
            value: this.net.town.strongboxValue,
          }
        : null,
      others: this.remotes.map((r) => ({
        id: r.id,
        x: Math.round(r.x),
        z: Math.round(r.z),
        alive: (r.flags & EF_ALIVE) !== 0,
        carry: r.carry * 20,
        flags: r.flags,
      })),
      bags: [...(this.fx?.bags.values() ?? [])].map((b) => ({
        id: b.id,
        x: b.x,
        z: b.z,
        amount: b.amount,
      })),
      pickups: TOWN.pickups.map((p, i) => ({
        kind: p.kind,
        x: p.x,
        z: p.z,
        up: this.pickups?.isAvailable(i) ?? false,
      })),
      showdowns: [...this.showdowns.values()].map((d) => ({
        id: d.id,
        opponent: d.opponent,
        called: d.called,
      })),
    }
  }
}

/** `ANIM_VAULT` or `ANIM_HOP` while one is under way, else 0. */
function jumpAnim(jumpTicks: number, vaultStep: number): number {
  if (jumpTicks <= 0) {
    return 0
  }
  return vaultStep > 0 ? ANIM_VAULT : ANIM_HOP
}

/** `ANIM_ROLL` or `ANIM_SLIDE` while one is under way, else 0. */
function dodgeAnim(m: MoveState): number {
  if (m.rollTicks > 0) {
    return ANIM_ROLL
  }
  return m.slideTicks > 0 ? ANIM_SLIDE : 0
}

function ownAnim(
  flags: number,
  dodge: number,
  moving: boolean,
  reloading: boolean,
  channel: number,
  jump: number,
): number {
  if (!(flags & SELF_ALIVE)) {
    return ANIM_DEAD
  }
  if (flags & SELF_IN_SHOWDOWN) {
    return ANIM_DUEL
  }
  if (dodge !== 0) {
    return dodge
  }
  if (jump !== 0) {
    return jump
  }
  if (reloading) {
    return ANIM_RELOAD
  }
  if (channel !== CHANNEL_NONE) {
    return ANIM_CHANNEL
  }
  return moving ? ANIM_RUN : ANIM_IDLE
}

/** The self flags in remote-entity terms, for the crowd. */
function ownFlags(selfFlags: number, prot: boolean): number {
  let f = selfFlags & SELF_ALIVE ? EF_ALIVE : 0
  if (prot) {
    f |= EF_PROTECTED
  }
  if (selfFlags & SELF_HOLSTERED) {
    f |= EF_HOLSTERED
  }
  return f
}

function rayToWall(net: NetClient, x: number, z: number, aim: number, range: number): number {
  return rayGrid(
    net.grid,
    { ox: x, oz: z, dx: Math.cos(aim), dz: Math.sin(aim), maxDist: range },
    BLOCK_SHOT,
  )
}

const PICKUP_RING = new Color(1.4, 0.6, 0.3)
/** Ground ring colours (shared, never mutated: the fx reads them the same frame). */
const RING_GOLD = new Color(1.6, 1.2, 0.4)
const RING_ZONE = new Color(0.5, 0.4, 0.2)
const RING_MINE = new Color(1.2, 1, 0.7)
const RING_MINE_MW = new Color(1.8, 1.4, 0.3)
const RING_CALLOUT = new Color(2, 0.4, 0.2)
const RING_SHOWDOWN = new Color(0.9, 0.7, 0.45)
const RING_MW = new Color(2, 1.5, 0.3)

/** Muzzle-flash size by view (the top-down flash would fill a shoulder or an eye). */
const FLASH_SCALE: Record<ViewMode, number> = { top: 1, third: 0.45, first: 0.18 }

/** How high the camera rides a vault and a hop (m): the body's arc. */
const VAULT_PEAK_M = 0.55
const HOP_PEAK_M = 0.3

/** From a rifle shot to the lever working the next round in, s (the rifle fires every 0.9 s). */
const RIFLE_LEVER_DELAY = 0.32

/** The reload, by weapon: the rifle's lever, shells into the shotgun, the revolver's hammer. */
const RELOAD_SOUND: Record<number, SfxName> = {
  [WEAPON_REVOLVER]: 'cocking',
  [WEAPON_RIFLE]: 'rifleLever',
  [WEAPON_SHOTGUN]: 'shotgunLoad',
}

/** HUD label, magazine, reach and tracer style per weapon. */
const WEAPON_UI: Record<number, { label: string; max: number; range: number; shotFlag: number }> = {
  [WEAPON_REVOLVER]: { label: '', max: REVOLVER_ROUNDS, range: MAX_RANGE, shotFlag: 0 },
  [WEAPON_SHOTGUN]: {
    label: 'SHOTGUN',
    max: SHOTGUN_SHELLS,
    range: SHOTGUN_RANGE,
    shotFlag: SHOT_SHOTGUN,
  },
  [WEAPON_RIFLE]: { label: 'RIFLE', max: RIFLE_ROUNDS, range: RIFLE_RANGE, shotFlag: SHOT_RIFLE },
}

/** Your feet are on the move: alive, running (or reloading on the run), and not mid-roll. */
function ownMoving(me: CrowdPlayer | undefined, rolling: boolean): boolean {
  return (
    me?.self === true &&
    !rolling &&
    (me.flags & EF_ALIVE) !== 0 &&
    me.anim !== ANIM_DUEL &&
    Math.hypot(me.vx, me.vz) > 0.3
  )
}
