// biome-ignore-all lint/complexity/useMaxParams: DSP helpers take positional numeric args (counts, times, levels)
// biome-ignore-all lint/correctness/noUndeclaredVariables: Bun is a global in this Bun script
/**
 * How every shipped out west 3D sound is made from its raw take (`manifest.ts`) or a first-party /
 * CC0 original. Run with `build.ts`. Each recipe returns audio at 48 kHz; `build.ts` masters it to
 * its loudness target (true peak ≤ −1 dBTP) and encodes AAC `.m4a`.
 *
 * Mono for everything positional or centred (half the decoded memory); stereo only where width is
 * the point: the gunshot town tail, the ambience beds and the music.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  type Ch,
  concat,
  events,
  fade,
  filt,
  gain,
  linToDb,
  load,
  loopify,
  mixInto,
  mono,
  onset,
  type Packed,
  pack,
  peak,
  secs,
  silence,
  slice,
  thump,
  tick,
} from './dsp.ts'
import { findLoop } from './loops.ts'

const HERE = import.meta.dir
const RAW = resolve(HERE, 'raw')
const ROOT = resolve(HERE, '../..')
/** The redesign commit the 2019 / CC0 originals are read from, so a rebuild never re-processes its own output. */
const ORIGIN = 'ed10ef6'

export interface Recipe {
  /** Output path under `public/experiments/out-west/3d/`. */
  out: string
  /** Loudness target, LUFS (integrated; loudest momentary for one-shots). */
  lufs: number
  /** Most the limiter may take off the peaks, dB. */
  maxGR?: number
  kbps?: number
  credit: string
  make: () => Ch | Packed
}

const raw = (id: string) => `${RAW}/${id}.mp3`

/** An original from the repo at ORIGIN, extracted once into raw/orig. */
function orig(path: string): string {
  const out = `${RAW}/orig/${path.replaceAll('/', '_')}`
  if (!existsSync(out)) {
    mkdirSync(dirname(out), { recursive: true })
    const p = Bun.spawnSync(['git', 'show', `${ORIGIN}:${path}`], { cwd: ROOT, stdout: 'pipe' })
    if (p.exitCode !== 0) {
      throw new Error(`git show ${ORIGIN}:${path} failed`)
    }
    Bun.write(out, p.stdout)
  }
  return out
}
const OLD = (f: string) => orig(`public/experiments/out-west/assets/${f}`)
const OLD3D = (f: string) => orig(`public/experiments/out-west/3d/sfx/${f}`)

/** Normalise to a sample peak, so layer gains below mean something. */
const norm = (ch: Ch, db = 0) => gain(ch, db - linToDb(peak(ch)))

/** Cut from just before the attack, keep `len` s, fade the end. */
function shot(ch: Ch, len: number, fadeOut = Math.min(0.25, len * 0.4), rel = -30): Ch {
  const o = Math.max(0, onset(ch, rel) - 0.003)
  return fade(slice(ch, o, o + len), 0.002, fadeOut)
}

/** Lay `n` separate events from a performance onto a fixed grid (`step` s apart, `len` s each). */
function grid(ch: Ch, n: number, step: number, len: number, minGap: number): Ch {
  const at = events(ch, n, minGap)
  let out = silence(step * n, 1)
  at.forEach((t, i) => {
    const one = fade(slice(ch, Math.max(0, t - 0.008), t + len), 0.003, len * 0.45)
    out = mixInto(out, norm(one, -1), i * step)
  })
  return out
}

/** Seamless streamed loop from a take that is already loop-shaped (ElevenLabs `--loop`). */
function bed(ch: Ch, x = 1, post = 2): Packed {
  const body = loopify(ch, 0, secs(ch), x)
  return pack(body, slice(body, secs(body) - post), post)
}

/** Pseudo-stereo from mono: two different short early-reflection patterns, one per side. */
function widen(m: Ch, a = '23|61', b = '37|79'): Ch {
  const l = filt(m, `aecho=1:0.7:${a}:0.22|0.14`)[0]
  const r = filt(m, `aecho=1:0.7:${b}:0.22|0.14`)[0]
  const n = Math.min(l?.length ?? 0, r?.length ?? 0)
  return [l?.slice(0, n) ?? new Float32Array(0), r?.slice(0, n) ?? new Float32Array(0)]
}

/** Pitch by semitones, keeping tempo (`keep`) or letting it follow like tape (darker, slower). */
function pitch(path: string, ch: 1 | 2, semis: number, keep: boolean): Ch {
  const r = 2 ** (semis / 12)
  const tempo = keep ? `,atempo=${(1 / r).toFixed(6)}` : ''
  return load(path, ch, `asetrate=${Math.round(48_000 * r)},aresample=48000${tempo}`)
}

/** A through-composed theme: play from the top, loop [start, end) found by `findLoop`. */
function theme(path: string, sMax: number, endBy: number): Packed {
  const ch = load(path, 2)
  const lp = findLoop(ch, 2, sMax, endBy * 0.6, endBy)
  const body = loopify(ch, lp.start, lp.end, 0.35)
  const intro = slice(ch, 0, lp.start)
  return pack(body, fade(intro, 0.01, 0), 2)
}

const GEN = 'generated (ElevenLabs)'
/** Wind takes are mostly sub-80 Hz rumble that phone speakers can't play: thin it, add air. */
const WIND_AIR = 'highpass=f=55,equalizer=f=900:t=q:w=1:g=3,highshelf=f=2500:g=6'

// --------------------------------------------------------------------------- the gunshot kit

function revClose(): Ch {
  const x = load(
    raw('rev_close'),
    1,
    'highpass=f=28,equalizer=f=110:t=q:w=0.9:g=4,equalizer=f=2800:t=q:w=1:g=2.5,equalizer=f=8500:t=q:w=1:g=3',
  )
  const body = norm(shot(x, 0.75, 0.35), -1)
  // A pitch-dropping sub thump under the crack: the chest punch a mic at arm's length misses.
  return mixInto(body, norm(thump(110, 46, 0.06, 0.3), -1), 0, -7)
}

function revTail(): Ch {
  const town = load(raw('rev_town'), 1, 'highpass=f=140,lowpass=f=7000')
  // The take's own crack is clipped: keep only its slap and rumble, faded in under the close layer.
  const t = fade(slice(town, 0.26, 3.3), 0.05, 1.2)
  return norm(widen(t, '29|67', '43|83'), -1)
}

export const RECIPES: Record<string, Recipe> = {
  rev_close: { out: 'sfx/rev_close.m4a', lufs: -14, maxGR: 6, credit: GEN, make: revClose },
  rev_tail: { out: 'sfx/rev_tail.m4a', lufs: -16, maxGR: 4, credit: GEN, make: revTail },
  cock: {
    out: 'sfx/cock.m4a',
    lufs: -16,
    credit: GEN,
    make: () => shot(load(raw('rev_cock'), 1), 0.42, 0.08),
  },
  hammer: {
    out: 'sfx/hammer.m4a',
    lufs: -16,
    credit: GEN,
    make: () => shot(load(raw('rev_hammer'), 1), 0.26, 0.08),
  },
  holster: {
    out: 'sfx/holster.m4a',
    lufs: -16,
    credit: GEN,
    make: () => shot(load(raw('holster'), 1, 'highpass=f=60'), 0.48, 0.15),
  },
  whip: {
    out: 'sfx/whip.m4a',
    lufs: -16,
    credit: '2019 original (`assets/whip.m4a`), remastered',
    make: () => fade(load(OLD('whip.m4a'), 1), 0.003, 0.12),
  },
  rifle: {
    out: 'sfx/rifle.m4a',
    lufs: -14,
    maxGR: 6,
    credit: GEN,
    make: () =>
      shot(load(raw('rifle_fire'), 1, 'highpass=f=30,equalizer=f=4000:t=q:w=1:g=2'), 2.6, 0.8),
  },
  rifle_lever: {
    out: 'sfx/rifle_lever.m4a',
    lufs: -16,
    credit: GEN,
    make: () => shot(load(raw('rifle_reload'), 1), 0.95, 0.12),
  },
  shotgun: {
    out: 'sfx/shotgun.m4a',
    lufs: -13,
    maxGR: 6,
    credit: GEN,
    make: () => shot(load(raw('shotgun_fire'), 1, 'adeclip,highpass=f=28'), 2.2, 0.9),
  },
  shotgun_load: {
    out: 'sfx/shotgun_load.m4a',
    lufs: -16,
    credit: GEN,
    make: () => shot(load(raw('shotgun_reload'), 1), 0.85, 0.12),
  },
  fuse: {
    out: 'sfx/fuse.m4a',
    lufs: -16,
    credit: GEN,
    // Even out the take's slow crescendo, then make it loop on itself (decoded buffer loop).
    make: () => {
      const x = load(raw('fuse'), 1, 'adeclip,dynaudnorm=f=200:g=11:p=0.9')
      const body = loopify(x, 0, secs(x), 0.4)
      return pack(body, slice(body, secs(body) - 0.15), 0.15)
    },
  },
  explosion: {
    out: 'sfx/explosion.m4a',
    lufs: -12,
    maxGR: 6,
    credit: GEN,
    // Take 1 has the crack and debris; take 2 adds the sub. Both arrive hot, so declip first.
    make: () => {
      const body = norm(load(raw('explosion'), 1, 'adeclip,highpass=f=30'), -1)
      const sub = norm(load(raw('explosion2'), 1, 'adeclip,lowpass=f=110'), -1)
      return fade(slice(mixInto(body, sub, 0, -5), 0, 3.6), 0.002, 1.4)
    },
  },
  hit_body: {
    out: 'sfx/hit_body.m4a',
    lufs: -16,
    maxGR: 3,
    credit: GEN,
    make: () => shot(load(raw('hit_body'), 1, 'adeclip'), 0.42, 0.15),
  },
  hit_wood: {
    out: 'sfx/hit_wood.m4a',
    lufs: -16,
    maxGR: 3,
    credit: GEN,
    make: () => shot(load(raw('hit_wood'), 1), 0.5, 0.2),
  },
  hit_dirt: {
    out: 'sfx/hit_dirt.m4a',
    lufs: -16,
    credit: GEN,
    make: () => shot(load(raw('hit_dirt'), 1), 0.5, 0.2),
  },
  ricochet: {
    out: 'sfx/ricochet.m4a',
    lufs: -16,
    credit: GEN,
    // Four variants on a 1 s grid (call sites pick `offset: 0..3`, 0.8 s each): the take's own
    // ricochet and three re-pitched copies, so repeats never sound identical.
    make: () => {
      const one = shot(load(raw('ricochet'), 1), 0.8, 0.35)
      let out = silence(4, 1)
      ;[1, 1.09, 0.93, 1.17].forEach((r, i) => {
        const v = r === 1 ? one : filt(one, `asetrate=${Math.round(48_000 * r)},aresample=48000`)
        out = mixInto(out, fade(slice(v, 0, 0.8), 0.002, 0.3), i)
      })
      return out
    },
  },
  // ---------------------------------------------------------------- footsteps (grids the call sites slice)
  dirtsteps: {
    out: 'sfx/dirtsteps.m4a',
    lufs: -18,
    credit: GEN,
    make: () => grid(load(raw('steps_dirt'), 1, 'highpass=f=40'), 6, 0.6, 0.45, 0.35),
  },
  woodsteps: {
    out: 'sfx/woodsteps.m4a',
    lufs: -18,
    credit: GEN,
    make: () => grid(load(raw('steps_wood'), 1, 'highpass=f=50'), 6, 0.6, 0.45, 0.35),
  },
  spursteps: {
    out: 'sfx/spursteps.m4a',
    lufs: -18,
    credit: GEN,
    make: () => grid(load(raw('spurs'), 1, 'highpass=f=300'), 8, 1, 0.65, 0.4),
  },
  // ---------------------------------------------------------------- ambience beds (streamed)
  amb_wind_day: {
    out: 'sfx/amb_wind_day.m4a',
    lufs: -16,
    maxGR: 8,
    credit: GEN,
    make: () => bed(load(raw('wind_day'), 2, WIND_AIR)),
  },
  amb_wind_dusk: {
    out: 'sfx/amb_wind_dusk.m4a',
    lufs: -16,
    maxGR: 8,
    credit: GEN,
    make: () => bed(load(raw('wind_dusk'), 2, 'highpass=f=45,highshelf=f=2500:g=3')),
  },
  amb_wind_night: {
    out: 'sfx/amb_wind_night.m4a',
    lufs: -16,
    maxGR: 8,
    credit: GEN,
    make: () => bed(load(raw('wind_night'), 2, 'highpass=f=35')),
  },
  amb_crickets: {
    out: 'sfx/amb_crickets.m4a',
    lufs: -16,
    maxGR: 4,
    credit: GEN,
    make: () => bed(load(raw('crickets'), 2)),
  },
  amb_saloon: {
    out: 'sfx/amb_saloon.m4a',
    lufs: -16,
    maxGR: 8,
    credit: GEN,
    make: () => bed(load(raw('saloon'), 2, 'adeclip')),
  },
  amb_piano: {
    out: 'sfx/amb_piano.m4a',
    lufs: -16,
    credit: GEN,
    make: () => bed(load(raw('s_piano'), 2), 0.5),
  },
  amb_fire: {
    out: 'sfx/amb_fire.m4a',
    lufs: -16,
    maxGR: 8,
    credit: '"Fire Crackle and Flames 002" by TheWoodlandNomad (CC0), looped',
    make: () => bed(load(OLD3D('fire.m4a'), 1), 1.5),
  },
  // ---------------------------------------------------------------- wildlife, town
  crow: {
    out: 'sfx/crow.m4a',
    lufs: -16,
    credit: GEN,
    make: () => shot(load(raw('crow'), 1), 2.15, 0.3),
  },
  dog: {
    out: 'sfx/dog.m4a',
    lufs: -16,
    credit: GEN,
    make: () => shot(load(raw('dog'), 1, 'highpass=f=120'), 1.9, 0.9, -40),
  },
  heart: {
    out: 'sfx/heart.m4a',
    lufs: -16,
    credit: GEN,
    // One soft beat; the engine plays the lub and a quieter, lower dub from it.
    make: () => {
      // biome-ignore lint/security/noSecrets: an ffmpeg filter, not a secret
      const x = shot(load(raw('heart'), 1, 'lowpass=f=180'), 0.3, 0.12)
      return mixInto(norm(x, -1), norm(thump(62, 44, 0.06, 0.25), -1), 0, -9)
    },
  },
  // ---------------------------------------------------------------- money
  coins: {
    out: 'sfx/coins.m4a',
    lufs: -16,
    credit: GEN,
    make: () => shot(load(raw('coins'), 1), 1.1, 0.35),
  },
  register: {
    out: 'sfx/register.m4a',
    lufs: -16,
    credit: GEN,
    make: () => shot(load(raw('register'), 1), 0.95, 0.3, -24),
  },
  deposit: {
    out: 'sfx/deposit.m4a',
    lufs: -16,
    maxGR: 3,
    credit: GEN,
    make: () => shot(load(raw('deposit'), 1, 'adeclip'), 2.4, 0.3),
  },
  // ---------------------------------------------------------------- UI
  ui_paper: {
    out: 'sfx/ui_paper.m4a',
    lufs: -18,
    credit: GEN,
    make: () => shot(load(raw('ui_paper'), 1, 'highpass=f=150'), 0.45, 0.15, -20),
  },
  ui_stamp: {
    out: 'sfx/ui_stamp.m4a',
    lufs: -16,
    credit: GEN,
    make: () => shot(load(raw('ui_stamp'), 1, 'highpass=f=40'), 0.32, 0.12),
  },
  ui_tick: { out: 'sfx/ui_tick.m4a', lufs: -20, credit: 'first-party (synthesised)', make: tick },
  ui_buy: {
    out: 'sfx/ui_buy.m4a',
    lufs: -16,
    maxGR: 3,
    credit: GEN,
    make: () => shot(load(raw('ui_buy'), 1, 'adeclip'), 1.1, 0.3),
  },
  queue_found: {
    out: 'sfx/queue_found.m4a',
    lufs: -16,
    maxGR: 3,
    credit: GEN,
    make: () => shot(load(raw('queue_found'), 1, 'adeclip'), 1.6, 0.8),
  },
  levelup: {
    out: 'sfx/levelup.m4a',
    lufs: -16,
    credit: `${GEN}, pitched into A`,
    make: () => {
      const x = pitch(raw('s_levelup'), 1, 2, false)
      return shot(x, Math.min(2.8, secs(x)), 0.6)
    },
  },
  ghost: {
    out: 'sfx/ghost.m4a',
    lufs: -16,
    credit: GEN,
    // The take ends abruptly at the top of its swell: give it a short airy tail.
    make: () => {
      const x = load(raw('ghost'), 1, 'highpass=f=90')
      const tail = filt(x, 'aecho=0.8:0.6:120|210|330:0.35|0.25|0.15')
      return fade(slice(tail, 0, secs(x) + 0.6), 0.02, 0.7)
    },
  },
  ghost_vanish: {
    out: 'sfx/ghost_vanish.m4a',
    lufs: -16,
    credit: GEN,
    make: () => fade(slice(load(raw('ghost_vanish'), 1, 'highpass=f=90'), 0.05, 1.95), 0.05, 0.6),
  },
  respawn: {
    out: 'sfx/respawn.m4a',
    lufs: -16,
    credit: GEN,
    make: () => shot(load(raw('respawn'), 1), 1.7, 0.6, -40),
  },
  // ---------------------------------------------------------------- remastered CC0 / 2019 one-shots
  bodyfall: {
    out: 'sfx/bodyfall.m4a',
    lufs: -16,
    credit: 'remaster',
    make: () => load(OLD3D('bodyfall.m4a'), 1),
  },
  bottle: {
    out: 'sfx/bottle.m4a',
    lufs: -16,
    credit: 'remaster',
    make: () => load(OLD3D('bottle.m4a'), 1),
  },
  door: {
    out: 'sfx/door.m4a',
    lufs: -16,
    credit: 'remaster',
    make: () => load(OLD3D('door.m4a'), 1),
  },
  flyby: {
    out: 'sfx/flyby.m4a',
    lufs: -16,
    credit: 'remaster',
    make: () => load(OLD3D('flyby.m4a'), 1),
  },
  gasp: {
    out: 'sfx/gasp.m4a',
    lufs: -16,
    credit: 'remaster',
    make: () => load(OLD3D('gasp.m4a'), 1),
  },
  hawk: {
    out: 'sfx/hawk.m4a',
    lufs: -16,
    credit: 'remaster',
    make: () => load(OLD3D('hawk.m4a'), 1),
  },
  horse: {
    out: 'sfx/horse.m4a',
    lufs: -16,
    credit: 'remaster',
    make: () => load(OLD3D('horse.m4a'), 1),
  },
  piano: {
    out: 'sfx/piano.m4a',
    lufs: -16,
    credit: 'remaster',
    make: () => load(OLD3D('piano.m4a'), 1),
  },
  coin: {
    out: 'sfx/coin.m4a',
    lufs: -16,
    credit: 'remaster',
    make: () => load(OLD3D('coin.m4a'), 1),
  },
  shout: {
    out: 'sfx/shout.m4a',
    lufs: -16,
    credit: '2019 original (`assets/shout.m4a`), remastered',
    make: () => fade(load(OLD('shout.m4a'), 1), 0.002, 0.2),
  },
  // ---------------------------------------------------------------- music (streamed)
  m_title: {
    out: 'music/title.m4a',
    lufs: -18,
    kbps: 96,
    credit: '2019 original (`assets/intro.m4a`), remastered and looped',
    make: () => theme(OLD('intro.m4a'), 50, 157),
  },
  m_boss: {
    out: 'music/boss.m4a',
    lufs: -18,
    kbps: 96,
    credit: '2019 original (`assets/boss.m4a`), remastered and looped',
    make: () => theme(OLD('boss.m4a'), 60, 198),
  },
  m_tension: {
    out: 'music/tension.m4a',
    lufs: -18,
    kbps: 112,
    credit: `${GEN}, pitched into A`,
    // Tape-style down a major third into A: darker and slower, and further below the bell.
    make: () => {
      const m = mono(pitch(raw('s_tension'), 1, -4, false))
      const body = loopify(m, 0, secs(m), 1.5)
      const wide = widen(
        concat(slice(body, secs(body) - 2), body, slice(body, 0, 2)),
        '31|73',
        '47|97',
      )
      // Re-cut after widening (the echoes are periodic with the loop, so the wrap stays seamless).
      return {
        ch: wide.map((c) => c.slice(0, Math.round((secs(body) + 4) * 48_000))),
        loopStart: 2,
        loopEnd: 2 + secs(body),
      }
    },
  },
  m_frontier: {
    out: 'music/frontier.m4a',
    lufs: -18,
    kbps: 128,
    credit: `${GEN}, pitched into A`,
    make: () => bed(pitch(raw('s_frontier2'), 2, -2, true), 0.25),
  },
  m_victory: {
    out: 'music/victory.m4a',
    lufs: -18,
    kbps: 128,
    credit: GEN,
    make: () => fade(load(raw('s_victory'), 2), 0.005, 1),
  },
  m_defeat: {
    out: 'music/defeat.m4a',
    lufs: -18,
    kbps: 128,
    credit: GEN,
    make: () => fade(load(raw('s_defeat'), 2), 0.005, 1),
  },
}
