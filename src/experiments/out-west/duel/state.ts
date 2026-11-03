import {
  CanvasTexture,
  type InstancedMesh,
  type Mesh,
  type Object3D,
  type Scene,
  Vector3,
} from 'three'
import type { AudioEngine, Loop } from '../audio/audio.ts'
import { FEEL } from '../data/feel.ts'
import { OUTLAWS, type Outlaw } from '../data/outlaws.ts'
import type { Assets } from '../engine/assets.ts'
import type { Input } from '../engine/input.ts'
import type { Renderer } from '../engine/render.ts'
import type { SaveData } from '../save.ts'
import { Actor } from '../scene/actor.ts'
import type { CameraRig } from '../scene/camera.ts'
import type { Dust, Flash, Glint, Physics, Puffs, Tumbleweed } from '../scene/fx.ts'
import { type PropDef, propObject } from '../scene/props.ts'
import type { World } from '../scene/world.ts'
import type { Hud } from '../ui/hud.ts'
import type { DrawPlan } from './judge.ts'

/** Everything the duel needs from the game. */
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

/** Phases in which the call can ring (or just rang): every UI sound is hushed. */
const STANDOFF_PHASES: ReadonlySet<Phase> = new Set<Phase>(['wait', 'bossClock', 'call'])

export type Phase =
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

export const rng = Math.random
export const between = (a: number, b: number): number => a + (b - a) * rng()
export const V = (x = 0, y = 0, z = 0): Vector3 => new Vector3(x, y, z)

export interface Dying {
  actor: Actor
  t: number
  contact: number
  landed: boolean
}

export interface Turning {
  a: Actor
  from: number
  to: number
  t0: number
  dur: number
}

export interface Faller {
  obj: Object3D
  v: Vector3
}

/**
 * The duel's mutable state, shared by the director and its helper modules
 * (framing, cues, outcomes, presentation). Plain fields: the modules are the
 * behaviour, this is the memory.
 */
export class DuelState {
  readonly c: Ctx
  phase = 'title' as Phase
  phaseT = 0
  realTime = 0
  level = 0
  outlaw: Outlaw = OUTLAWS[0] as Outlaw
  enemy = null as Actor | null
  rifleman = null as Actor | null
  riflemanAlive = false as boolean
  enemyAlive = true as boolean
  timeScale = 1
  /** Render the red silhouette frame this many more frames. */
  silhouetteFrames = 0
  paused = false as boolean
  pausedPhase = null as Phase | null
  skipIntroAllowed = false as boolean
  // walk
  speed = 0
  paces = 0
  target = 6
  pDist = 0
  eDist = 0
  stall = 0
  stallHeckled = false as boolean
  /** realTime the last spoken line frees the floor (chatter.ts). */
  lineFreeAt = 0
  /** Lines this outlaw has said on this walk (the opener and one beat). */
  walkLines = 0
  lastWalkTime = 0
  lastTick = 0
  turnAnim: Turning[] = []
  // standoff
  /** The attempt id shared with the clock (and the ranked server). */
  duelId = -1
  waitStart = 0
  /** perf time of the call, when known ahead (practice); 0 otherwise. */
  tCall = 0
  bellVoice = null as { stop: (at?: number) => void } | null
  bellScheduled = false as boolean
  ecuDone = false as boolean
  callIsScream = false as boolean
  pianoVoice = null as { stop: (at?: number) => void } | null
  pushStart = 0
  pushing = false as boolean
  // the call
  plan = null as DrawPlan | null
  callT = 0
  lastReaction = null as number | null
  secondChance = false as boolean
  targetsDown = 0
  shotsSent = 0
  /** Ranked underboss: the server target of the first shot. */
  firstTarget = 0
  /** This attempt's standoff has been sent to the clock. */
  standoffSent = false as boolean
  lastPressT = 0
  hatShot = false as boolean
  glintFired = false as boolean
  // outcomes
  outcomeT = 0
  resultShown = false as boolean
  loseReason = '' as string
  bossPhase = 1
  strikes = 0
  midnightBells = 0
  nextToll = 0
  clockInsertUntil = 0
  killOrbit = 0
  killDur: number = FEEL.killCamSeconds
  killCamStarted = false as boolean
  dying = null as Dying | null
  fallers: Faller[] = []
  winDelta = 0
  paidShown = false as boolean
  cowardBeat = false as boolean
  cowardCard = false as boolean
  cowardDelta = 0
  cowardNote = '' as string
  endT = 0
  // presentation
  dayFrom = 0
  dayTo = 0
  vignette: number = FEEL.vignetteBase
  satTarget = 1
  sat = 1
  ca = 0
  wind = 0.35
  /** The time-of-day bed's level (1 = resting) and how fast it moves there, s (`present.ts`). */
  ambLevel = 1
  ambRamp = 1.5
  fireLoop = null as Loop | null
  ambT = 0
  cards: Object3D[] = []
  cardT = 0
  coin = null as Mesh | null
  readonly posterCanvas = document.createElement('canvas')
  readonly posterTex: CanvasTexture
  /** Your gunslinger; replaced (not mutated) when the loadout changes, via `setPlayer`. */
  private you: Actor

  constructor(c: Ctx) {
    this.c = c
    this.posterTex = new CanvasTexture(this.posterCanvas)
    this.you = new Actor(c.assets.player, { gun: c.gun ? propObject(c.gun) : null })
  }

  /** Your gunslinger. Read it fresh each time: a new loadout swaps the whole actor. */
  get player(): Actor {
    return this.you
  }

  /** Swap in a re-dressed gunslinger (the caller disposes the old one and adds the new to the scene). */
  setPlayer(a: Actor): void {
    this.you = a
  }

  get portrait(): boolean {
    return this.c.rig.cam.aspect < 1
  }

  get reduced(): boolean {
    return this.c.save.settings.reducedMotion
  }

  get boss(): boolean {
    return this.outlaw.gimmick === 'boss'
  }

  get underboss(): boolean {
    return this.outlaw.gimmick === 'underboss'
  }

  /** True while the duellists stand back to back waiting for the bell. */
  get backsTurned(): boolean {
    return !this.boss
  }

  enter(p: Phase): void {
    this.phase = p
    this.phaseT = 0
    // no menu sound may play while the street waits for the call
    this.c.audio.hushUi(STANDOFF_PHASES.has(p))
  }
}
