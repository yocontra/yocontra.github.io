// biome-ignore-all lint/complexity/useMaxParams: sound helpers take positional options
/**
 * What the server's events sound like (`events.ts` decides when): the report per weapon, what a
 * bullet struck, the pickups, a burning fuse from the throw to the blast, and the check that keeps
 * any other duel's bell quiet while yours waits for its call.
 */
import type { AudioEngine, Loop, SfxName } from '../../audio/audio.ts'
import {
  NONE,
  POS_SCALE,
  SHOT_HIT,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  SHOT_WALL,
} from '../../contract/town.ts'
import { TICK_MS } from '../sim/constants.ts'
import { hitSurface } from './surface.ts'

/** A one-shot, at a spot on the street (1.2 m up) or centred. */
export function play(
  s: { audio: AudioEngine | null },
  name: SfxName,
  at: { x: number; z: number; y?: number } | null,
  gain = 1,
  priority = false,
): void {
  s.audio?.play(name, {
    gain,
    priority,
    ...(at ? { pos: { x: at.x, y: (at.y ?? 0) + 1.2, z: at.z } } : {}),
  })
}

/** Fake-out cues by index (never a bell). */
export const FAKE_CUES: readonly SfxName[] = [
  'crow',
  'door',
  'bottle',
  'horse',
  'coin',
  'dog',
  'piano',
  'shout',
  'whip',
]

export interface Fuse {
  loop: Loop
  /** Backstop: stops the hiss if the blast never arrives (a dropped event, a lobby change). */
  timer: ReturnType<typeof setTimeout>
}

/** Bullet impacts farther than this from you are not played, m. */
const IMPACT_EARSHOT = 35
/** The fuse hiss outlives its fuse by at most this long, ms. */
const FUSE_GRACE_MS = 1200
/** A bag worth at least this much is a bag of coins (`coins`); less is a few (`coin`). */
const BAG_COINS = 50

/** Taking a pickup: the rifle's lever, shells into the shotgun, the dynamite into a saddlebag. */
export const PICKUP_SOUND: Readonly<Record<string, SfxName>> = {
  rifle: 'rifleLever',
  shotgun: 'shotgunLoad',
  dynamite: 'holster',
}

/** Picking up a dropped bag. */
export const bagSound = (amount: number): SfxName => (amount >= BAG_COINS ? 'coins' : 'coin')

/** The report for a shot, by weapon: the rifle's crack, the shotgun's boom, or the revolver. */
export function shotSound(flags: number): SfxName {
  if (flags & SHOT_SHOTGUN) {
    return 'shotgunFire'
  }
  if (flags & SHOT_RIFLE) {
    return 'rifleFire'
  }
  return 'fire'
}

/** What the bullet struck: a body, or the wall or cover where it stopped. */
export function impactSound(
  audio: AudioEngine | null,
  flags: number,
  pos: { x: number; y: number; z: number },
  you: { x: number; z: number; y?: number } | null,
): void {
  if (
    !you ||
    Math.hypot(pos.x - you.x, pos.y - (you.y ?? 0) - 1.2, pos.z - you.z) > IMPACT_EARSHOT
  ) {
    // a far hit is inaudible under its own report: spend no voice on it
    return
  }
  if (flags & SHOT_HIT) {
    audio?.impact('body', { pos, gain: 0.8 })
  } else if (flags & SHOT_WALL) {
    audio?.impact(hitSurface(pos.x, pos.z), { pos, gain: 0.6 })
  }
}

/** Your own showdown is waiting for its call: nothing bell-like may ring for anyone else's. */
export function waitingOnMyCall(
  showdowns: ReadonlyMap<number, { opponent: number; called: boolean }>,
): boolean {
  for (const sd of showdowns.values()) {
    if (sd.opponent !== NONE && !sd.called) {
      return true
    }
  }
  return false
}

/** Stop a thrower's fuse hiss (the blast, or a new throw). */
export function stopFuse(fuses: Map<number, Fuse>, player: number): void {
  const f = fuses.get(player)
  if (f) {
    clearTimeout(f.timer)
    f.loop.stop()
    fuses.delete(player)
  }
}

/** The fuse hisses where the stick lands, from the throw until the blast (or its fuse plus grace). */
export function startFuse(
  audio: AudioEngine | null,
  fuses: Map<number, Fuse>,
  ev: { player: number; x: number; z: number; fuseTicks: number },
): void {
  stopFuse(fuses, ev.player)
  const at = { x: ev.x / POS_SCALE, y: 0.3, z: ev.z / POS_SCALE }
  const loop = audio?.loop('fuse', 0.6, 'sfx', at)
  if (loop) {
    const ms = ev.fuseTicks * TICK_MS + FUSE_GRACE_MS
    fuses.set(ev.player, { loop, timer: setTimeout(() => stopFuse(fuses, ev.player), ms) })
  }
}
