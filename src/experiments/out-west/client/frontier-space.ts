/**
 * The world audio's master bus (glue, limiter and a soft-clip backstop, as on the duel's master),
 * the listener's acoustic surroundings and the two shared returns a gunshot is sent into: the
 * street's slapback (the far facade there and back, with one weaker second bounce) and a short,
 * dark room tail. Inside a building the room speaks; between facades the slap does; out in the
 * open there is only a late, faint echo off the far buildings.
 */
import { softClipCurve } from '../audio/math.ts'
import { type Building, TOWN } from '../ffa/sim/layout.ts'

export type SpaceKind = 'interior' | 'street' | 'open'
export interface Space {
  kind: SpaceKind
  /** Slapback delay, s. */
  slap: number
}

/** Return levels per space: [room, slap]. */
const RETURNS: Readonly<Record<SpaceKind, readonly [number, number]>> = {
  interior: [0.55, 0.08],
  street: [0.14, 0.5],
  open: [0.05, 0.1],
}
/** The open desert's only answer: a late echo off the edge of town. */
const OPEN_ECHO = 0.42

interface Near {
  e: number
  w: number
  n: number
  s: number
}

function facades(p: { x: number; z: number }, b: Building, near: Near): void {
  if (p.z > b.z - 2 && p.z < b.z + b.d + 2) {
    if (b.x > p.x) {
      near.e = Math.min(near.e, b.x - p.x)
    } else if (b.x + b.w < p.x) {
      near.w = Math.min(near.w, p.x - b.x - b.w)
    }
  }
  if (p.x > b.x - 2 && p.x < b.x + b.w + 2) {
    if (b.z > p.z) {
      near.s = Math.min(near.s, b.z - p.z)
    } else if (b.z + b.d < p.z) {
      near.n = Math.min(near.n, p.z - b.z - b.d)
    }
  }
}

/** Where `p` stands: inside a hollow building, in a street between facades, or in the open. */
export function spaceAt(p: { x: number; y: number; z: number }, buildings = TOWN.buildings): Space {
  const inside = buildings.find(
    (b) =>
      b.hollow &&
      p.x > b.x &&
      p.x < b.x + b.w &&
      p.z > b.z &&
      p.z < b.z + b.d &&
      p.y < b.height + 0.5,
  )
  if (inside) {
    return { kind: 'interior', slap: 0.03 }
  }
  const near: Near = { e: 99, w: 99, n: 99, s: 99 }
  for (const b of buildings) {
    if (b.height >= 3) {
      facades(p, b, near)
    }
  }
  const across = Math.min(near.n + near.s, near.e + near.w)
  if (across < 40) {
    return { kind: 'street', slap: Math.min(0.24, Math.max(0.05, (across * 2) / 343)) }
  }
  return { kind: 'open', slap: OPEN_ECHO }
}

function roomImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const ir = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c)
    let lp = 0
    for (let i = 0; i < len; i++) {
      lp = lp * 0.55 + (Math.random() * 2 - 1) * 0.45
      d[i] = lp * (1 - i / len) ** 3 * (i < 300 ? i / 300 : 1)
    }
  }
  return ir
}

/** Glue into a brickwall limiter into a soft clipper: a firefight cannot reach the DAC clipped. */
function masterBus(ctx: AudioContext): GainNode {
  const glue = ctx.createDynamicsCompressor()
  glue.threshold.value = -12
  glue.knee.value = 10
  glue.ratio.value = 2
  glue.attack.value = 0.005
  glue.release.value = 0.2
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -2
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.001
  limiter.release.value = 0.08
  const clip = ctx.createWaveShaper()
  clip.curve = softClipCurve()
  clip.oversample = '2x'
  const master = ctx.createGain()
  master.gain.value = 10 ** (-3 / 20)
  master.connect(glue).connect(limiter).connect(clip).connect(ctx.destination)
  return master
}

/**
 * The master bus and shared returns on the native sound manager's context, retuned as the
 * listener moves. Native instances reach the master through their external nodes; `mute` is the
 * silent last node PlayCanvas wires to the speakers in their place.
 */
export class SpaceReturns {
  readonly master: GainNode
  readonly mute: GainNode
  readonly room: GainNode
  readonly slap: DelayNode
  private readonly roomOut: GainNode
  private readonly slapOut: GainNode
  private readonly ctx: AudioContext

  constructor(ctx: AudioContext, space: Space) {
    this.ctx = ctx
    this.master = masterBus(ctx)
    this.mute = ctx.createGain()
    this.mute.gain.value = 0
    const convolver = ctx.createConvolver()
    convolver.buffer = roomImpulse(ctx, 1.3)
    this.room = ctx.createGain()
    this.roomOut = ctx.createGain()
    this.roomOut.gain.value = 0
    this.room.connect(convolver).connect(this.roomOut).connect(this.master)
    this.slap = ctx.createDelay(0.6)
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = 1300
    band.Q.value = 0.5
    this.slapOut = ctx.createGain()
    this.slapOut.gain.value = 0
    const bounce = ctx.createGain()
    bounce.gain.value = 0.28
    this.slap.connect(band).connect(this.slapOut).connect(this.master)
    band.connect(bounce).connect(this.slap)
    this.apply(space)
  }

  apply(space: Space): void {
    const t = this.ctx.currentTime
    const [room, slap] = RETURNS[space.kind]
    this.roomOut.gain.setTargetAtTime(room, t, 0.2)
    this.slapOut.gain.setTargetAtTime(slap, t, 0.2)
    this.slap.delayTime.setTargetAtTime(space.slap, t, 0.2)
  }

  dispose(): void {
    this.room.disconnect()
    this.roomOut.disconnect()
    this.slap.disconnect()
    this.slapOut.disconnect()
    this.master.disconnect()
    this.mute.disconnect()
  }
}
