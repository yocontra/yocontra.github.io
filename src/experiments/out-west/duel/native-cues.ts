import { Vec3 } from 'playcanvas'
import type { PlayOpts, SfxName } from '../audio/audio.ts'
import { say } from './chatter.ts'
import type { NativeDirector } from './native-director.ts'
import { AMB, ambience, pos } from './native-moments.ts'

/**
 * Fake-outs during the wait, restored from the original engine: the same cue names come from the
 * ranked server and the practice clock. Each one is a thing you see and hear somewhere in the
 * street (its own caption, its own place, its own sound), without interrupting the townsfolk.
 * Anything unknown plays as a creaking door.
 */

interface Cue {
  caption: string
  sound?: SfxName
  play?: PlayOpts
  /** Where the sound happens in the arena. */
  at?: (d: NativeDirector) => Vec3
  /** The visible part: a prop, his body, the wind. */
  act?: (d: NativeDirector) => void
}

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)
const stand = (s: { x: number; y: number; z: number }, up = 0): Vec3 => new Vec3(s.x, s.y + up, s.z)
/** Across the street from the player, on the boardwalk (bottles, heckles, lanterns). */
const boardwalk = (d: NativeDirector, y: number): Vec3 =>
  new Vec3(-10, y, rand(-5, 10) + pos(d.player).z)
const him = (d: NativeDirector): Vec3 => pos(d.enemy).add(new Vec3(0, 1.5, 0))

const door: Cue = {
  caption: '[a saloon door creaks]',
  sound: 'door',
  play: { gain: 1, reverb: 0.4 },
  at: (d) => stand(d.arenas.life.door, 1.4),
  act: (d) => {
    d.atmosphere.cue('door', d.enemy)
    const at = stand(d.arenas.life.door, 0.45)
    d.dust.emit(at, 10, { speed: 0.6, size: 0.12, life: 1.2, alpha: 0.25, up: 0.3 })
  },
}
const heckle: Cue = {
  caption: '[from the crowd] “DRR… rinks on me!”',
  sound: 'shout',
  play: { gain: 0.5, rate: 0.82, reverb: 0.4 },
  at: (d) => boardwalk(d, 1.6),
}
const pianoStop: Cue = {
  caption: '[the piano stops]',
  sound: 'piano',
  play: { gain: 0.5, offset: 6.1, duration: 0.5 },
  at: (d) => stand(d.arenas.life.door, 1.6),
}
const distantShot: Cue = {
  caption: '[a distant gunshot]',
  sound: 'fireBig',
  play: { gain: 0.35, lowpass: 1400, reverb: 0.8 },
  at: (d) => new Vec3(40, 3, pos(d.player).z - 60),
}

const CUES: Readonly<Record<string, Cue>> = {
  door,
  creak: door,
  heckle,
  'gang-drr': heckle,
  piano: pianoStop,
  'piano-stop': pianoStop,
  gunshot: distantShot,
  'distant-shot': distantShot,
  crow: {
    caption: '[a crow caws]',
    sound: 'crow',
    play: { gain: 0.9, reverb: 0.3 },
    at: (d) => stand(d.arenas.life.crows, 0.4),
    act: (d) => d.atmosphere.cue('crow', d.enemy),
  },
  dog: {
    caption: '[a dog barks]',
    sound: 'dog',
    play: { gain: 0.8, reverb: 0.5 },
    at: (d) => stand(d.arenas.life.dog, 0.5),
    act: (d) => d.atmosphere.cue('dog', d.enemy),
  },
  horse: {
    caption: '[a horse whinnies]',
    sound: 'horse',
    play: { gain: 0.8, reverb: 0.3 },
    at: (d) => stand(d.arenas.life.horses[0] ?? d.arenas.life.dog, 1.8),
    act: (d) => d.atmosphere.cue('horse', d.enemy),
  },
  coin: {
    caption: '[a coin spins in the air]',
    sound: 'coin',
    play: { gain: 0.8, reverb: 0.2 },
    at: him,
    act: (d) => d.atmosphere.cue('coin', d.enemy),
  },
  bottle: {
    caption: '[a bottle smashes]',
    sound: 'bottle',
    play: { gain: 1, reverb: 0.4 },
    at: (d) => boardwalk(d, 1),
  },
  hiccup: {
    caption: '[hic!]',
    sound: 'shout',
    play: { gain: 0.3, rate: 1.6 },
    at: him,
    act: (d) => d.enemy?.play('Idle_Drunk', 0.04),
  },
  twitch: {
    caption: '[his hand twitches]',
    sound: 'holster',
    play: { gain: 0.25, rate: 1.3 },
    at: him,
    act: (d) => d.enemy?.play('Flinch', 0.04),
  },
  whistle: {
    caption: '[his whistle stops dead]',
    sound: 'hawk',
    play: { gain: 0.25, rate: 1.25 },
    at: him,
  },
  lantern: {
    caption: '[a lantern gutters]',
    sound: 'door',
    play: { gain: 0.25, rate: 1.4, reverb: 0.3 },
    at: (d) => boardwalk(d, 2.5),
  },
  tumbleweed: {
    caption: '[a tumbleweed rolls by]',
    act: (d) => d.atmosphere.cue('tumbleweed', d.enemy),
  },
  gust: {
    caption: '[a gust of wind]',
    act: (d) => {
      ambience(d, AMB.gust, 0.2)
      d.atmosphere.cue('gust', d.enemy)
      d.dust.emit(new Vec3(-4, 0.2, pos(d.player).z + 3), 30, {
        speed: 2,
        size: 0.2,
        life: 1.6,
        alpha: 0.3,
        dir: new Vec3(3, 0, 0),
      })
    },
  },
  cards: {
    caption: '[cards scatter]',
    act: (d) => d.atmosphere.cue('cards', d.enemy),
  },
  miscount: {
    caption: '',
    act: (d) => {
      // the one line the wait allows: it is the fake-out
      say(d, d.outlaw.name, '…TWELVE!', { ms: 1100, force: true })
      d.enemy?.play('Flinch', 0.04)
    },
  },
}

/** Play a fake-out by name without changing spectator animation or placement. */
export function fakeOut(d: NativeDirector, name: string): void {
  const cue = CUES[name] ?? door
  if (cue.caption) {
    d.c.hud.fake(cue.caption)
  }
  const at = cue.at?.(d)
  if (cue.sound) {
    d.c.audio.play(cue.sound, { ...cue.play, ...(at ? { pos: at } : {}) })
  }
  cue.act?.(d)
}
