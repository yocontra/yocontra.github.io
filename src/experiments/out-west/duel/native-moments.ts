import {
  Color,
  type GraphNode,
  LAYERID_SKYBOX,
  type LightComponent,
  type MeshInstance,
  math,
  type ParticleSystemComponent,
  type RenderComponent,
  Vec3,
} from 'playcanvas'
import { FEEL } from '../data/feel.ts'
import type { DuelActor } from './native-actor.ts'
import { clamp01, V } from './native-camera.ts'
import type { NativeDirector } from './native-director.ts'

/**
 * The duel's moments, restored from the original engine: the poster, the cock, the paced walk, the
 * standoff's tension, the call, and the kill, death and back-shot sequences. Presentation only:
 * the clock and judge decide every outcome; nothing here reads or moves their timing.
 */

/** Seconds into a win when you twirl the gun back into the holster (the slow-mo is over). */
export const BACK_TO_BACK_Z = 0.4

export const AMB = { turn: 0.4, wait: 0.57, gust: 1.4, hush: 0.14 } as const
export const WAIT_HUSH = 0.6

interface Turn {
  actor: DuelActor
  from: number
  to: number
  t: number
  secs: number
}

export interface PendingCard {
  outcome: 'win' | 'loss' | 'coward'
  ms: number | null
  show: () => void
}

/** Per-attempt presentation state. */
export class Moments {
  timeScale = 1
  pDist = 0
  eDist = 0
  paces = 0
  enemyCocked = false as boolean
  waitStart = 0
  ecuDone = false as boolean
  nextBeat = 0
  hisMs: number | null = null
  card: PendingCard | null = null
  cardShown = false as boolean
  killCamStarted = false as boolean
  swelled = false as boolean
  cowardBeat = false as boolean
  cowardEarlyMs: number | null = null
  loseReason = ''
  /** `lead`: seconds of stagger left before the Death clip; `rate`: that clip's playback rate. */
  dying: { actor: DuelActor; landed: boolean; lead: number; rate: number } | null = null
  faller: { actor: DuelActor; v: Vec3 } | null = null
  turns: Turn[] = []
  glintFired = false as boolean
  /** The level whose poster carries his mugshot. */
  printed = -1
  /** Colour: where the grade is heading (1 = full) and where it is. */
  satTarget = 1
  sat = 1
  /** The standoff vignette, 0 (rest) .. 1 (the wait's darkest). */
  vignette = 0
  glintMarkUntil = 0
  bells = 0
  nextToll = 0
  flash = 0
  baseExposure = 0
  killFrames = 0
  /** The stall back-shot's beat (0 none, 1 turning, 2 fired, 3 hit) and its clock. */
  backShotAt = 0
  backShotT = 0
  ambLevel = 1
  ambRamp = 1.5
  ambT = 10
}

export const reduced = (d: NativeDirector): boolean => d.c.save.settings.reducedMotion
export const boss = (d: NativeDirector): boolean => d.outlaw.gimmick === 'boss'
export const pos = (actor: DuelActor | null | undefined): Vec3 =>
  actor ? actor.root.getPosition().clone() : new Vec3()

// --------------------------------------------------------------------------------- ambience

export function ambience(d: NativeDirector, level: number, ramp: number): void {
  d.m.ambLevel = level
  d.m.ambRamp = ramp
}

export function duckForStandoff(d: NativeDirector, ramp: number): void {
  const a = d.c.audio
  a.musicSection('duel')
  a.musicLowpass(FEEL.waitLowpass, ramp)
  a.musicLevel(a.currentSong === 'tension' ? FEEL.tensionWaitDuckDb : FEEL.waitDuckDb, ramp)
}

/** The time-of-day bed under every duel phase, hushed for the standoff, and the odd hawk or dog. */
export function tickAmbience(d: NativeDirector, dt: number): void {
  const day = d.outlaw.day
  const level = d.m.ambLevel * (d.phase === 'wait' ? WAIT_HUSH : 1)
  d.c.audio.setTimeOfDay(day, level, d.m.ambRamp)
  d.m.ambT -= dt
  if (d.m.ambT <= 0 && (d.phase === 'walk' || d.phase === 'poster' || d.phase === 'cock')) {
    d.m.ambT = 9 + Math.random() * 9
    const r = (n: number) => (Math.random() * 2 - 1) * n
    if (day < 0.6) {
      d.c.audio.play('hawk', { gain: 0.35, pos: { x: r(40), y: 30, z: r(60) }, reverb: 0.3 })
    } else {
      d.c.audio.play('dog', { gain: 0.3, pos: { x: r(60), y: 1, z: r(60) }, reverb: 0.6 })
    }
  }
}

// ---------------------------------------------------------------------------- the kill frame

const KILL_RED = new Color(1, 0, 0, 1)
/** Kept off the red frame (as the original did): the dirt, the town's life, dust and gunfire. */
const OFF_THE_RED =
  /^(?:ground-|shaft-|townsfolk-|town-|fakeout-|duel-dust|muzzle-flash|bullet-|impact-spark|gun-smoke)/u
interface KillFrameState {
  clear: Color
  layers: number[]
  hidden: MeshInstance[]
  particles: ParticleSystemComponent[]
  lights: [LightComponent, number][]
  ambient: Color
  fog: Color
  sky: number
}
const killFrames = new WeakMap<NativeDirector, KillFrameState>()

function offTheRed(d: NativeDirector): MeshInstance[] {
  const root = d.game.app.root
  const off = (from: GraphNode): boolean => {
    let node: GraphNode | null = from
    while (node && node !== root) {
      if (OFF_THE_RED.test(node.name)) {
        return true
      }
      node = node.parent
    }
    return false
  }
  const instances: MeshInstance[] = []
  const renders = root.findComponents('render') as RenderComponent[]
  for (const render of renders) {
    if (render.entity.enabled && off(render.entity)) {
      instances.push(...render.meshInstances)
    }
  }
  // Static dirt is drawn from native batches; their materials retain the source material identity.
  // Read the public scene layers, without relying on BatchManager's private batch records.
  const dirtMaterials = new Set(
    renders
      .filter((render) => render.entity.name.startsWith('ground-'))
      .flatMap((render) => render.meshInstances.map((mesh) => mesh.material)),
  )
  for (const layer of d.game.app.scene.layers.layerList) {
    for (const mesh of layer.meshInstances) {
      if (mesh.batching && dirtMaterials.has(mesh.material)) {
        instances.push(mesh)
      }
    }
  }
  const hidden = [...new Set(instances)].filter((instance) => instance.visible)
  for (const instance of hidden) {
    instance.visible = false
  }
  return hidden
}

/**
 * The red silhouette frame: the street drawn black against pure #F00 for two frames as the shot
 * lands. Every light, the ambient and sky lighting and the haze go dark (exposure stays, so the
 * HDR post stack still passes the red); the sky layer and the dirt are dropped so the camera's
 * red clear shows behind and under the men.
 */
export function killFrame(d: NativeDirector, on: boolean): void {
  const lens = d.game.camera.camera
  const scene = d.game.app.scene
  const was = killFrames.get(d)
  if (!on) {
    if (was && lens) {
      lens.clearColor = was.clear
      lens.layers = was.layers
      for (const instance of was.hidden) {
        instance.visible = true
      }
      for (const particle of was.particles) {
        particle.enabled = true
      }
      for (const [light, intensity] of was.lights) {
        light.intensity = intensity
      }
      scene.ambientLight.copy(was.ambient)
      scene.fog.color.copy(was.fog)
      scene.skyboxIntensity = was.sky
    }
    killFrames.delete(d)
    return
  }
  if (was || !lens) {
    return
  }
  if (d.m.flash > 0) {
    d.m.flash = 0
    scene.exposure = d.m.baseExposure
  }
  const lights = (d.game.app.root.findComponents('light') as LightComponent[]).map(
    (light): [LightComponent, number] => [light, light.intensity],
  )
  const particles = (
    d.game.app.root.findComponents('particlesystem') as ParticleSystemComponent[]
  ).filter((component) => component.enabled && component.entity.enabled)
  for (const particle of particles) {
    particle.enabled = false
  }
  killFrames.set(d, {
    clear: lens.clearColor.clone(),
    layers: [...lens.layers],
    hidden: offTheRed(d),
    particles,
    lights,
    ambient: scene.ambientLight.clone(),
    fog: scene.fog.color.clone(),
    sky: scene.skyboxIntensity,
  })
  for (const [light] of lights) {
    light.intensity = 0
  }
  scene.ambientLight.set(0, 0, 0)
  scene.fog.color.set(0, 0, 0)
  scene.skyboxIntensity = 0
  lens.clearColor = KILL_RED
  lens.layers = lens.layers.filter((id) => id !== LAYERID_SKYBOX)
}

export function flash(d: NativeDirector, amount: number): void {
  if (reduced(d)) {
    return
  }
  if (d.m.flash <= 0) {
    d.m.baseExposure = d.game.app.scene.exposure
  }
  d.m.flash = Math.max(d.m.flash, amount)
}

let lensEl: HTMLDivElement | null = null
let canvasFilter = ''

/** The standoff's tightening vignette, `k` 0..1 of the way from rest to the wait's darkest. */
function vignette(d: NativeDirector, k: number): void {
  if (k < 0.005) {
    if (lensEl && lensEl.style.opacity !== '0') {
      lensEl.style.opacity = '0'
    }
    return
  }
  if (!lensEl) {
    lensEl = d.c.hud.root.ownerDocument.createElement('div')
    lensEl.className = 'ow-lens'
    lensEl.setAttribute('aria-hidden', 'true')
    lensEl.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:2;opacity:0;' +
      'background:radial-gradient(ellipse 75% 70% at 50% 48%,transparent 52%,rgba(8,4,2,.62) 100%)'
  }
  if (lensEl.parentElement !== d.c.hud.root) {
    d.c.hud.root.append(lensEl)
  }
  const o = k.toFixed(3)
  if (lensEl.style.opacity !== o) {
    lensEl.style.opacity = o
  }
}

export function tickGrade(d: NativeDirector, realDt: number): void {
  const m = d.m
  // the colour drains out of the street when you're shot (and comes back for the retry)
  m.sat += (m.satTarget - m.sat) * Math.min(1, realDt * 3)
  const filter = m.sat < 0.99 ? `saturate(${m.sat.toFixed(2)})` : ''
  if (filter !== canvasFilter) {
    canvasFilter = filter
    ;(d.game.app.graphicsDevice.canvas as HTMLCanvasElement).style.filter = filter
  }
  if (d.phase !== 'wait') {
    m.vignette -= m.vignette * Math.min(1, realDt * 2)
  }
  vignette(d, reduced(d) ? 0 : m.vignette)
  if (d.m.flash > 0) {
    d.m.flash = Math.max(0, d.m.flash - realDt * 12)
    d.game.app.scene.exposure = d.m.baseExposure * (1 + d.m.flash * 1.6)
  }
  if (d.m.killFrames > 0) {
    d.m.killFrames--
    killFrame(d, d.m.killFrames > 0)
  }
}

export function facing(actor: DuelActor): number {
  const f = actor.root.forward
  return Math.atan2(-f.x, -f.z) * math.RAD_TO_DEG
}

/** Turn to `to` degrees over `secs` (the short way round), in game time. */
export function turnTo(d: NativeDirector, actor: DuelActor | null, to: number, secs: number): void {
  if (!actor) {
    return
  }
  const from = facing(actor)
  let delta = ((((to - from) % 360) + 540) % 360) - 180
  if (Math.abs(delta) < 1) {
    delta = 0
  }
  d.m.turns = d.m.turns.filter((turn) => turn.actor !== actor)
  d.m.turns.push({ actor, from, to: from + delta, t: 0, secs })
}

/** He fires: whatever his turn had got to, he is square on his man this frame. */
export function settleTurn(d: NativeDirector, actor: DuelActor): void {
  const turn = d.m.turns.find((entry) => entry.actor === actor)
  if (turn) {
    actor.face(turn.to)
    d.m.turns = d.m.turns.filter((entry) => entry !== turn)
  }
}

export function tickTurns(d: NativeDirector, dt: number): void {
  for (const turn of d.m.turns) {
    turn.t += dt
    const k = clamp01(turn.t / turn.secs)
    const e = k * k * (3 - 2 * k)
    turn.actor.face(math.lerp(turn.from, turn.to, e))
  }
  d.m.turns = d.m.turns.filter((turn) => turn.t < turn.secs)
}

/** His draw time from his first planned shot: aimed just before it lands. */
export function tickBodies(d: NativeDirector, dt: number): void {
  const dying = d.m.dying
  const layer = dying?.actor.model.anim?.baseLayer
  if (
    dying &&
    !dying.landed &&
    layer?.activeState.startsWith('Death') &&
    layer.activeStateProgress >= 0.62
  ) {
    dying.landed = true
    const at = pos(dying.actor)
    d.c.audio.play('bodyfall', { gain: 0.9, pos: at })
    const away = at.clone().sub(pos(d.player))
    away.y = 0
    away.normalize()
    d.dust.emit(at.add(away.mulScalar(0.7)).add(V(0, 0.05, 0)), 40, {
      speed: 1.2,
      size: 0.16,
      life: 1.5,
      alpha: 0.4,
      up: 0.5,
    })
  }
  const f = d.m.faller
  if (f) {
    f.v.y -= 9.8 * dt
    const p = pos(f.actor).add(f.v.clone().mulScalar(dt))
    const e = f.actor.root.getLocalEulerAngles()
    f.actor.root.setLocalEulerAngles(e.x, e.y, e.z + dt * 140)
    if (p.y <= 0) {
      p.y = 0
      d.m.faller = null
    }
    f.actor.root.setPosition(p)
  }
}

// ------------------------------------------------------------------------------- every frame

const SLOW_PHASES = new Set(['win', 'coward', 'bossWound'])

/** Advance the presentation on the real clock; returns the game time scale for this frame. */
export function tickMoments(d: NativeDirector, realDt: number, gameDt: number): void {
  tickGrade(d, realDt)
  tickTurns(d, gameDt)
  tickBodies(d, gameDt)
  d.dust.update(gameDt)
  if (d.phase !== 'title' && d.phase !== 'end' && d.phase !== 'loading') {
    tickAmbience(d, realDt)
  }
  const scale = SLOW_PHASES.has(d.phase) ? d.m.timeScale : 1
  d.game.app.timeScale = scale
  // the dying man's clip never crawls below victimMinScale
  const dying = d.m.dying
  const anim = dying?.actor.model.anim
  if (!(dying && anim) || scale <= 0) {
    return
  }
  const floor = Math.max(scale, FEEL.victimMinScale)
  if (dying.lead > 0) {
    dying.lead -= realDt * floor
    if (dying.lead <= 0) {
      dying.actor.play('Death', 0.12)
    }
  }
  const want = (floor / scale) * (dying.lead > 0 ? STAGGER_RATE : dying.rate)
  if (Math.abs(anim.speed - want) > 1e-3) {
    anim.speed = want
  }
}

const STAGGER_RATE = 1.3

interface DeathStyle {
  lead: 'HitRecieve' | 'HitRecieve_2' | null
  leadS: number
  rate: number
}

/** His fall by the grade of your draw: the fast ones drop clean, the slow ones stagger first. */
const DEATH_STYLES: Record<string, DeathStyle> = {
  LIGHTNING: { lead: null, leadS: 0, rate: 0.62 },
  DEADEYE: { lead: null, leadS: 0, rate: 1.15 },
  QUICK: { lead: 'HitRecieve', leadS: 0.22, rate: 1 },
  STEADY: { lead: 'HitRecieve_2', leadS: 0.36, rate: 0.9 },
  LUCKY: { lead: 'HitRecieve', leadS: 0.5, rate: 0.8 },
}

/** Start `victim`'s death in the style of `grade`. */
export function dieInStyle(d: NativeDirector, victim: DuelActor, grade: string): void {
  const st = DEATH_STYLES[grade] ?? { lead: 'HitRecieve', leadS: 0.5, rate: 0.8 }
  const lead = st.lead && victim.hasAnimation(st.lead) ? st.lead : null
  d.m.dying = { actor: victim, landed: false, lead: lead ? st.leadS : 0, rate: st.rate }
  victim.play(lead ?? 'Death', lead ? 0.05 : 0.06)
}

/** Leave the duel's presentation cleanly (the saloon, a special mode, disposal). */
export function clearMoments(d: NativeDirector, preserveCamera = false): void {
  d.game.app.timeScale = 1
  if (d.m.flash > 0) {
    d.game.app.scene.exposure = d.m.baseExposure
  }
  d.m = new Moments()
  killFrame(d, false)
  vignette(d, 0)
  if (canvasFilter) {
    canvasFilter = ''
    ;(d.game.app.graphicsDevice.canvas as HTMLCanvasElement).style.filter = ''
  }
  d.c.hud.letterbox(false)
  d.c.hud.marker(null, null)
  d.c.audio.stopAmbience()
  if (!preserveCamera) {
    d.rig.release()
  }
}
