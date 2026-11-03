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
  Raycaster,
  Scene,
  Vector2,
  Vector3,
} from 'three'
import { AudioEngine, type SfxName } from '../../audio/audio.ts'
import {
  ANIM_CHANNEL,
  ANIM_DEAD,
  ANIM_DUEL,
  ANIM_IDLE,
  ANIM_RELOAD,
  ANIM_ROLL,
  ANIM_RUN,
  BOX_NONE,
  BOX_OPENING,
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
  NONE,
  SELF_ALIVE,
  SELF_DEAD_EYE_READY,
  SELF_HOLSTERED,
  SELF_IN_SHOWDOWN,
  SELF_MOST_WANTED,
  SELF_RELOADING,
  type ServerControl,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../contract/town.ts'
import { loadAssets } from '../../engine/assets.ts'
import { Renderer } from '../../engine/render.ts'
import { haptic } from '../../platform/haptics.ts'
import { presetAt } from '../../scene/presets.ts'
import { RIM } from '../../scene/style.ts'
import { installUiSounds } from '../../ui/sfx.ts'
import { TopDownCamera } from '../scene/camera.ts'
import { Crowd, type CrowdPlayer } from '../scene/crowd.ts'
import { CUT } from '../scene/cutaway.ts'
import { Effects } from '../scene/fx.ts'
import { lookFor } from '../scene/looks.ts'
import { Pickups } from '../scene/pickups.ts'
import { buildTown, type Town } from '../scene/town.ts'
import type { WireEvent } from '../sim/codec-events.ts'
import {
  BANK_CHANNEL_TICKS,
  DEAD_EYE_CLOSE_TICKS,
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
} from '../sim/constants.ts'
import { BLOCK_SHOT, rayGrid, TOWN } from '../sim/layout.ts'
import { radiansToAim } from '../sim/move.ts'
import { ThreatArrows } from './arrows.ts'
import { Autopilot } from './autopilot.ts'
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
import { FrontierSound, wearsSpurs } from './sound.ts'
import { TouchControls } from './touch.ts'
import type { Transport, TransportEvents } from './transport.ts'

/** Late-afternoon light: the sun low in the south-west, shadows reaching north-east. */
const DAY = 0.3
const SUN_DIR = new Vector3(-0.55, 0.62, 0.56).normalize()
const SHADOW_HALF = 12

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
  private map: Minimap | null = null
  private readonly desk: DesktopControls
  private readonly touch: TouchControls | null
  private readonly arrows: ThreatArrows
  /** Dev-only (`?debug=…`): scripted input for multi-page tests. */
  readonly autopilot: Autopilot | null
  private lastMw = NONE
  private readonly audio: AudioEngine | null
  private readonly sun: DirectionalLight
  private readonly opts: GameOptions
  private raf = 0
  private hiddenTimer: ReturnType<typeof setInterval> | null = null
  private last = 0
  private acc = 0
  private running = false
  private disposed = false
  private exited = false
  private readonly own = { x: 72, z: 64 }
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
  private remotes: RemoteView[] = []
  private readonly crowdList: CrowdPlayer[] = []
  private mapAt = 0
  private readonly hatlessSeen = new Set<number>()
  private wasAlive = false
  private wasReloading = false
  private wasReady = false
  private readonly sound: FrontierSound | null
  private readonly fuses = new Map<number, Fuse>()
  private readonly sink: Sink
  readonly perf = { tickMs: 0, frameMs: 0, simMs: 0 }

  constructor(root: HTMLElement, opts: GameOptions) {
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
    this.renderer = new Renderer(
      this.canvas,
      this.scene,
      this.cam.camera,
      coarse ? 'low' : 'high',
      'ffa',
    )
    this.scene.userData.owDay = DAY
    this.applyGrade()
    this.sun = new DirectionalLight(0xff_e8_c8, 3.4)
    this.setupLights()
    this.hud = new Hud(root, {
      touch: coarse,
      onLeave: () => this.desk.tap(BTN_LEAVE),
      onExit: () => this.exit('quit'),
    })
    this.desk = new DesktopControls(root)
    this.touch = coarse ? new TouchControls(root) : null
    this.arrows = new ThreatArrows(this.hud.root)
    this.net = new NetClient({
      onWelcome: () => this.onWelcome(),
      onControl: (m) => this.onControl(m),
      onEvent: (ev) => this.onEvent(ev),
      onPredictedShot: (x, z, aim, w) => this.predictedShot(x, z, aim, w),
    })
    this.sink = this.makeSink()
    this.autopilot = new URLSearchParams(location.search).has('debug')
      ? new Autopilot(this.net.grid)
      : null
    globalThis.addEventListener('resize', this.onResize)
    globalThis.addEventListener('keydown', this.onKey)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.onResize()
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
      kick: (a) => this.cam.kick(a),
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
    if (this.disposed) {
      return
    }
    onProgress(0.65, 'Raising the town')
    this.town = buildTown(TOWN, assets, SUN_DIR)
    this.scene.add(this.town.root)
    this.fx = new Effects(this.scene)
    this.pickups = new Pickups(this.scene, TOWN.pickups, assets.props)
    const near = this.nearCap()
    this.crowd = new Crowd(this.scene, assets, near)
    this.map = new Minimap(TOWN, this.touch ? 112 : 148)
    this.hud.mapSlot.append(this.map.el)
    onProgress(0.75, 'Fitting the posse')
    await this.crowd.prepare(['casual', 'worker', 'rugged', 'suit'])
    if (this.disposed) {
      return
    }
    onProgress(0.95, 'Riding in')
    this.renderer.probe.position.set(72, 1.7, 66)
    try {
      await this.renderer.gl.compileAsync(this.scene, this.cam.camera)
    } catch {
      // Older browsers compile on first use.
    }
    this.renderer.probe.captureNow()
    this.syncRoster()
    this.running = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
    this.hiddenTimer = setInterval(this.hiddenTick, TICK_MS)
    onProgress(1, '')
  }

  /** Skinned cap: 12 on the floor tier, 8 on legacy, 16 above (stream H's measurements). */
  private nearCap(): number {
    const t = this.renderer.tier
    if (t === 'legacy') {
      return 8
    }
    return t === 'floor' ? 12 : 16
  }

  private onTransport(state: string, detail?: string): void {
    if (state === 'retrying') {
      this.hud.banner('Riding back in… (connection lost)')
    } else if (state === 'open') {
      this.hud.banner(null)
    } else if (state === 'closed' && !this.exited && this.running) {
      this.hud.banner(`Lost the trail${detail ? `: ${detail}` : ''}`)
      setTimeout(() => this.exit('lost'), 2500)
    }
  }

  private onWelcome(): void {
    this.syncRoster()
    this.hud.feed(
      `Welcome to Perdition${this.net.lobbyId === 'loopback' ? ' (practice town)' : ''}.`,
      'info',
    )
  }

  private syncRoster(): void {
    const crowd = this.crowd
    if (!crowd) {
      return
    }
    for (const r of this.net.roster.values()) {
      crowd.setLook(r.id, lookFor(r.loadout, r.id))
    }
  }

  private onControl(m: ServerControl): void {
    if (m.type === 'roster_add') {
      this.crowd?.setLook(m.entry.id, lookFor(m.entry.loadout, m.entry.id))
    } else if (m.type === 'roster_remove') {
      this.crowd?.remove(m.id)
    }
    if (this.fx) {
      handleControl(this.sink, m)
    }
  }

  private onEvent(ev: WireEvent): void {
    if (this.fx && this.crowd) {
      handleEvent(this.sink, ev)
    }
  }

  private predictedShot(x: number, z: number, aim: number, weapon: number): void {
    const m = this.crowd?.muzzle(this.net.you, x, z, aim, this.tmp) ?? this.tmp.set(x, 1.3, z)
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
    this.cam.kick(0.12)
    haptic('shot')
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
    this.ndc.set((p.x / window.innerWidth) * 2 - 1, -(p.y / window.innerHeight) * 2 + 1)
    this.ray.setFromCamera(this.ndc, this.cam.camera)
    const hit = this.ray.ray.intersectPlane(this.aimPlane, this.tmp)
    if (!hit) {
      return null
    }
    return Math.atan2(hit.z - this.own.z, hit.x - this.own.x)
  }

  private sampleInput(): { moveX: number; moveZ: number; aim: number; buttons: number } {
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
      buttons,
    }
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape') {
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
    const dtMs = Math.min(100, now - this.last)
    this.last = now
    this.renderTick = this.net.renderTick(t0)
    this.acc += dtMs
    let ticks = 0
    while (this.acc >= TICK_MS && ticks < 4) {
      this.acc -= TICK_MS
      ticks++
      const intent = this.sampleInput()
      this.net.tick(intent, this.renderTick, t0)
      this.showdownInput(intent.buttons)
    }
    if (this.acc > TICK_MS * 4) {
      this.acc = 0
    }
    this.net.ownPosition(this.acc / TICK_MS, dtMs, this.own)
    this.remotes = [...this.net.views(this.renderTick)]
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
    this.renderer.adapt(dtMs, true)
    this.renderer.render(dt)
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
        anim: ownAnim(
          s.flags,
          this.net.pred.rollTicks > 0,
          speed > 0.3,
          s.reloadTicks > 0,
          s.channelKind,
        ),
        flags: ownFlags(s.flags, s.protectTicks > 0),
        self: true,
      })
    }
    for (const r of this.remotes) {
      list.push({
        id: r.id,
        x: r.x,
        z: r.z,
        aim: r.aim,
        vx: r.vx,
        vz: r.vz,
        anim: r.anim,
        flags: r.flags,
        self: false,
      })
    }
    if (this.net.alive && !this.wasAlive) {
      this.cam.snap(this.own.x, this.own.z)
      this.hatlessSeen.clear()
    }
    this.cam.update(this.own.x, this.own.z, Math.cos(this.aim), Math.sin(this.aim), dt)
    crowd.update(list, this.cam.target.x, this.cam.target.z, dt, nowS)
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
    this.sun.position.copy(this.cam.target).addScaledVector(SUN_DIR, 60)
    this.sun.target.position.copy(this.cam.target)
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
      this.net.alive && aiming ? (WEAPON_UI[this.net.weapon.weapon]?.range ?? MAX_RANGE) : null,
      Boolean(this.touch?.aiming),
    )
    this.pickups?.update(nowS, (x, y, z) => fx.spark(x, y, z))
    fx.update(dt, nowS)
    this.audio?.setListener(this.own.x, 8, this.own.z + 4, 0, -0.8, -0.6)
    this.wasAlive = this.net.alive
  }

  /** Player position on screen → the cutaway circle (render-target pixels). */
  private updateCut(): void {
    const p = this.tmp.set(this.own.x, 1, this.own.z)
    const view = p.clone().applyMatrix4(this.cam.camera.matrixWorldInverse)
    p.project(this.cam.camera)
    const size = this.renderer.gl.getDrawingBufferSize(new Vector2())
    CUT.screen.value.set((p.x * 0.5 + 0.5) * size.x, (p.y * 0.5 + 0.5) * size.y, -view.z)
    // About 4.5 m around the player, in pixels at this zoom.
    const pxPerM =
      size.y / (2 * Math.tan((this.cam.camera.fov * Math.PI) / 360) * this.cam.distance)
    CUT.radius.value = 4.5 * pxPerM
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
    const gold = new Color(1.6, 1.2, 0.4)
    const carrying = s.carried > 0
    for (const z of TOWN.zones) {
      fx.ring(z.x, z.z, z.r, carrying ? gold : new Color(0.5, 0.4, 0.2), carrying ? 3 : 0)
    }
    for (const [i, sp] of TOWN.pickups.entries()) {
      if (this.pickups?.isAvailable(i)) {
        fx.ring(sp.x, sp.z, 1.2, PICKUP_RING, 4)
      }
    }
    if (this.net.alive) {
      const mine = s.flags & SELF_MOST_WANTED ? new Color(1.8, 1.4, 0.3) : new Color(1.2, 1, 0.7)
      fx.ring(this.own.x, this.own.z, 0.7, mine, 0)
    }
    const now = performance.now()
    this.callouts = this.callouts.filter((c) => c.until > now)
    for (const c of this.callouts) {
      for (const id of [c.challenger, c.target]) {
        const p = this.posOf(id)
        if (p) {
          fx.ring(p.x, p.z, 1.1, new Color(2, 0.4, 0.2), 10)
        }
      }
    }
    for (const sd of this.showdowns.values()) {
      fx.ring(sd.cx, sd.cz, 5.5, new Color(0.9, 0.7, 0.45), sd.called ? 0 : 2)
    }
    for (const r of this.remotes) {
      if (r.flags & EF_MOST_WANTED && r.flags & EF_ALIVE) {
        fx.ring(r.x, r.z, 0.85 + Math.sin(nowS * 6) * 0.05, new Color(2, 1.5, 0.3), 0)
      }
    }
  }

  private calledBy(): number {
    const now = performance.now()
    const c = this.callouts.find((x) => x.target === this.net.you && x.until > now)
    return c ? c.challenger : NONE
  }

  private updateHud(nowS: number): void {
    const s = this.net.self
    if (!s) {
      this.hud.banner('Riding into Perdition…')
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
      prompt: this.touch ? null : (action?.prompt ?? null),
      protectedFor: s.protectTicks,
      lowPower: this.renderer.lowPower,
    })
    this.reticle(s.flags)
    this.sounds(s.flags)
    if (this.net.alive) {
      this.hud.alive()
    } else {
      const k = this.killer
      const name = k && k.id !== NONE ? this.net.name(k.id) : null
      const lvl = k && k.id !== NONE ? this.net.roster.get(k.id)?.level : undefined
      this.hud.death(
        name,
        lvl ? `Level ${lvl}. You dropped 70% of what you carried.` : 'Your carry is in the dirt.',
        s.respawnTicks / TICK_HZ,
      )
    }
    this.announceMostWanted()
    this.arrows.update(this.cam.camera, this.own.x, this.own.z, this.remotes)
    if (this.map && nowS - this.mapAt > 0.1) {
      this.mapAt = nowS
      this.drawMap(nowS)
    }
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
      x = (v.x * 0.5 + 0.5) * window.innerWidth
      y = (-v.y * 0.5 + 0.5) * window.innerHeight
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
    if (showdown) {
      this.hud.banner(null)
    }
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
    this.hud.dispose()
    this.crowd?.dispose()
    this.town?.dispose()
    this.renderer.probe.dispose()
    this.renderer.composer.dispose()
    this.renderer.gl.dispose()
    this.canvas.remove()
    this.root.classList.remove('fr-root')
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

function ownAnim(
  flags: number,
  rolling: boolean,
  moving: boolean,
  reloading: boolean,
  channel: number,
): number {
  if (!(flags & SELF_ALIVE)) {
    return ANIM_DEAD
  }
  if (flags & SELF_IN_SHOWDOWN) {
    return ANIM_DUEL
  }
  if (rolling) {
    return ANIM_ROLL
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
