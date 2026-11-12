/**
 * The Frontier world kit: bullet impacts per material, footsteps per surface, jump and landing
 * foley, near-miss cracks, hit markers and the depot / sign ambience. Gridded files hold `count`
 * variants `step` s apart (`FRONTIER_GRIDS`), which the client slices with native sound slots.
 */
import { resolve } from 'node:path'
import { credit, FREESOUND as FS, KENNEY as K } from './cc0.ts'
import {
  type Ch,
  events,
  fade,
  filt,
  gain,
  linToDb,
  load,
  loopify,
  mixInto,
  onset,
  type Packed,
  pack,
  peak,
  secs,
  silence,
  slice,
  thump,
} from './dsp.ts'
import type { Recipe } from './recipes.ts'

const PUB = resolve(import.meta.dir, '../../public/experiments/out-west/3d/sfx')
const shipped = (name: string) => `${PUB}/${name}.m4a`

const norm = (ch: Ch, db = 0) => gain(ch, db - linToDb(peak(ch)))
const rate = (ch: Ch, r: number) =>
  r === 1 ? ch : filt(ch, `asetrate=${Math.round(48_000 * r)},aresample=48000`)

/** From just before the attack, `len` s, faded out. */
function cut(ch: Ch, len: number, rel = -30, at = 0): Ch {
  const tail = slice(ch, at)
  const o = Math.max(0, onset(tail, rel) - 0.003)
  return fade(slice(tail, o, o + len), 0.002, Math.min(0.2, len * 0.45))
}

/** Grid layout shared with the client (`client/frontier-audio.ts`). */
export const FRONTIER_GRIDS = {
  hit_flesh: { count: 4, step: 0.5, len: 0.42 },
  hit_stone: { count: 6, step: 0.6, len: 0.55 },
  hit_metal: { count: 4, step: 0.9, len: 0.85 },
  hit_water: { count: 4, step: 0.7, len: 0.6 },
  hit_soft: { count: 4, step: 0.5, len: 0.4 },
  hit_timber: { count: 4, step: 0.6, len: 0.5 },
  hit_ground: { count: 4, step: 0.6, len: 0.5 },
  steps_stone: { count: 5, step: 0.5, len: 0.4 },
  steps_straw: { count: 5, step: 0.5, len: 0.4 },
  steps_metal: { count: 6, step: 0.7, len: 0.6 },
  steps_water: { count: 6, step: 0.7, len: 0.6 },
  foley_cloth: { count: 4, step: 0.6, len: 0.5 },
  crack: { count: 3, step: 0.5, len: 0.42 },
  sign_creak: { count: 5, step: 2, len: 1.9 },
} as const

type GridName = keyof typeof FRONTIER_GRIDS

/** Lay variants on their grid, each peak-normalised and faded inside its slot. */
function gridOf(name: GridName, list: readonly Ch[]): Ch {
  const g = FRONTIER_GRIDS[name]
  if (list.length !== g.count) {
    throw new Error(`${name}: ${list.length} variants for a grid of ${g.count}`)
  }
  let out = silence(g.step * g.count, 1)
  list.forEach((v, i) => {
    out = mixInto(out, norm(fade(slice(v, 0, g.len), 0.002, g.len * 0.35), -1), i * g.step)
  })
  return out
}

/** `n` separate events of a performance at least `gap` s apart, each `len` s from its attack. */
function sliced(ch: Ch, n: number, take: { len: number; gap: number; rel?: number }): Ch[] {
  return events(ch, n, take.gap, take.rel ?? -24).map((t) =>
    slice(ch, Math.max(0, t - 0.006), t + take.len),
  )
}

const lowpass = (hz: number) => `lowpass=f=${hz}`
const ogg = (s: { file: string }) => load(s.file, 1)
const mp3 = (s: { file: string }, filter?: string) => load(s.file, 1, filter)

/** A seamless mono loop with a short wrap either side, for a native looping slot. */
function nativeLoop(ch: Ch, from: number, to: number, x: number): Packed {
  const body = loopify(ch, from, to, x)
  return pack(body, slice(body, secs(body) - 0.25), 0.25)
}

// ------------------------------------------------------------------ impacts

function flesh(): Ch {
  const head = mp3(FS.headshot, 'highpass=f=60')
  const old = load(shipped('hit_body'), 1)
  const weight = norm(thump(120, 52, 0.045, 0.25), -1)
  const a = mixInto(cut(head, 0.42), weight, 0, -9)
  const b = mixInto(cut(old, 0.42), cut(head, 0.42), 0.004, -7)
  return gridOf('hit_flesh', [
    a,
    b,
    rate(mixInto(a, swish(0.12, 5), 0.01, -10), 0.86),
    rate(b, 1.14),
  ])
}

function stone(): Ch {
  const one = cut(mp3(FS.concrete, 'highpass=f=80'), 0.55)
  const many = mp3(FS.impacts, 'highpass=f=90')
  return gridOf('hit_stone', [one, ...sliced(many, 5, { len: 0.55, gap: 0.6, rel: -20 })])
}

/** The shipped ricochets (strike and whine) with a round ringing a steel gallery target on top. */
function metal(): Ch {
  const steel = mp3(FS.gallery, 'highpass=f=150')
  const ric = load(shipped('ricochet'), 1)
  const hits = [1.6, 2.82, 8.42, 15.1].map((t, i) =>
    mixInto(cut(ric, 0.85, -30, i), cut(steel, 0.85, -30, t), 0, -3),
  )
  return gridOf('hit_metal', hits)
}

/** The plink of the surface breaking, a quick spray thrown up off it and a low cavitation thwup. */
function water(): Ch {
  const plink = cut(mp3(FS.waterBullet, 'highpass=f=200'), 0.3)
  const spray = sliced(mp3(FS.wade, 'highpass=f=350'), 4, { len: 0.55, gap: 0.7, rel: -18 }).map(
    (s) => rate(s, 1.3),
  )
  const thwup = norm(thump(150, 55, 0.035, 0.2), -1)
  const take = (s: Ch, r: number) =>
    rate(mixInto(mixInto(norm(s, -1), plink, 0, -3), thwup, 0, -10), r)
  const [a, b, c, d] = spray as [Ch, Ch, Ch, Ch]
  return gridOf('hit_water', [take(a, 1), take(b, 0.94), take(c, 1.06), take(d, 0.9)])
}

function soft(): Ch {
  const hay = [...K.softMedium, K.softHeavy[0]].map((s) =>
    mixInto(cut(ogg(s as { file: string }), 0.4), norm(thump(95, 50, 0.04, 0.2), -1), 0, -12),
  )
  return gridOf('hit_soft', hay)
}

function timber(): Ch {
  const old = cut(load(shipped('hit_wood'), 1), 0.5)
  const heavy = K.woodHeavy.map((s) => mixInto(cut(ogg(s), 0.5), old, 0.003, -12))
  return gridOf('hit_timber', [old, ...heavy])
}

function ground(): Ch {
  const old = cut(load(shipped('hit_dirt'), 1), 0.5)
  const grit = cut(mp3(FS.impacts, lowpass(2500)), 0.5)
  return gridOf('hit_ground', [
    old,
    rate(old, 0.9),
    mixInto(rate(old, 1.1), grit, 0, -14),
    rate(old, 0.82),
  ])
}

// ---------------------------------------------------------------- footsteps

const stepsMetal = () =>
  gridOf(
    'steps_metal',
    sliced(mp3(FS.metalSteps, 'highpass=f=70'), 6, { len: 0.6, gap: 0.6, rel: -18 }),
  )
const stepsWater = () =>
  gridOf('steps_water', sliced(mp3(FS.wade, 'highpass=f=60'), 6, { len: 0.6, gap: 0.7, rel: -18 }))

/** A coat swish: band-limited noise swelling over ~40 ms and dying away, no hard transient. */
function swish(seconds: number, seed0: number): Ch {
  const n = Math.round(seconds * 48_000)
  const out = new Float32Array(n)
  let seed = seed0
  for (let i = 0; i < n; i++) {
    seed = (seed * 16_807) % 2_147_483_647
    const t = i / 48_000
    out[i] = (seed / 2_147_483_647 - 0.5) * Math.min(1, t / 0.04) * Math.exp(-t / (seconds * 0.3))
  }
  return filt([out], 'highpass=f=700,lowpass=f=3800,highpass=f=700,lowpass=f=3800')
}

// ------------------------------------------------------------ feedback and air

/** CoD-style hit marker: a dry, bright tick with a short metallic edge. Under 60 ms, never tonal. */
function hitMarker(): Ch {
  const n = Math.round(0.07 * 48_000)
  const out = new Float32Array(n)
  let seed = 11
  const rnd = () => {
    seed = (seed * 16_807) % 2_147_483_647
    return seed / 2_147_483_647 - 0.5
  }
  for (let i = 0; i < n; i++) {
    const t = i / 48_000
    const tick = Math.sin(2 * Math.PI * 3400 * t) * Math.exp(-t / 0.003) * 0.6
    const edge = Math.sin(2 * Math.PI * 5900 * t) * Math.exp(-t / 0.0018) * 0.25
    const click = rnd() * Math.exp(-t / 0.0009) * 1.4
    out[i] = (tick + edge + click) * Math.min(1, t / 0.0003)
  }
  const body = Math.round(0.03 * 48_000)
  for (let i = 0; i < body; i++) {
    const t = i / 48_000
    out[i] = (out[i] ?? 0) + Math.sin(2 * Math.PI * 900 * t) * Math.exp(-t / 0.005) * 0.3
  }
  return fade(filt([out], 'highpass=f=500,lowpass=f=7000'), 0.0003, 0.03)
}

/** Kill confirm: a heavy low knock under two quick ticks; dead within 150 ms (no ring, no bell). */
function killConfirm(): Ch {
  const knock = norm(thump(180, 62, 0.05, 0.18), -1)
  const tick = hitMarker()
  return mixInto(mixInto(knock, tick, 0, -3), rate(tick, 0.84), 0.055, -5)
}

function crack(): Ch {
  const one = cut(mp3(FS.crack, 'highpass=f=200'), 0.42)
  return gridOf('crack', [one, rate(one, 1.07), rate(one, 0.93)])
}

/** The take's five creaks, each cut from just before it starts. */
function signCreak(): Ch {
  const take = mp3(FS.sign, 'highpass=f=120,lowpass=f=7000')
  const at = [0.3, 5.0, 8.7, 12.6, 16.7]
  return gridOf(
    'sign_creak',
    at.map((t) => fade(slice(take, t, t + 1.9), 0.04, 0.4)),
  )
}

function locoIdle(): Packed {
  // the pump knocks repeat every loop: hold them down so the bed reads as an idle, not a rhythm
  const take = mp3(
    FS.locoIdle,
    'highpass=f=35,acompressor=threshold=-26dB:ratio=5:attack=2:release=80',
  )
  return nativeLoop(take, 0.4, secs(take) - 0.1, 0.6)
}

/** Short mono beds for Frontier's native looping slots, cut from the shipped stereo beds. */
function bedFrom(name: string, from: number, len: number): Packed {
  const take = load(shipped(name), 1)
  return nativeLoop(take, from, from + len, 1.5)
}

export const FRONTIER_RECIPES: Record<string, Recipe> = {
  hit_flesh: {
    out: 'sfx/hit_flesh.m4a',
    lufs: -16,
    maxGR: 3,
    credit: `${credit(FS.headshot)}; with the shipped hit_body`,
    make: flesh,
  },
  hit_stone: {
    out: 'sfx/hit_stone.m4a',
    lufs: -16,
    maxGR: 3,
    credit: credit(FS.concrete, FS.impacts),
    make: stone,
  },
  hit_metal: {
    out: 'sfx/hit_metal.m4a',
    lufs: -17,
    maxGR: 5,
    credit: `${credit(FS.gallery)}; with the shipped ricochet`,
    make: metal,
  },
  hit_water: {
    out: 'sfx/hit_water.m4a',
    lufs: -17,
    credit: credit(FS.waterBullet, FS.wade),
    make: water,
  },
  hit_soft: {
    out: 'sfx/hit_soft.m4a',
    lufs: -18,
    credit: credit(...K.softMedium, ...K.softHeavy.slice(0, 1)),
    make: soft,
  },
  hit_timber: {
    out: 'sfx/hit_timber.m4a',
    lufs: -16,
    maxGR: 5,
    credit: `${credit(...K.woodHeavy)}; with the shipped hit_wood`,
    make: timber,
  },
  hit_ground: {
    out: 'sfx/hit_ground.m4a',
    lufs: -16,
    credit: `${credit(FS.impacts)}; with the shipped hit_dirt`,
    make: ground,
  },
  steps_stone: {
    out: 'sfx/steps_stone.m4a',
    lufs: -18,
    maxGR: 4,
    credit: credit(...K.concrete),
    make: () =>
      gridOf(
        'steps_stone',
        K.concrete.map((s) => cut(ogg(s), 0.4)),
      ),
  },
  steps_straw: {
    out: 'sfx/steps_straw.m4a',
    lufs: -19,
    credit: credit(...K.grass),
    make: () =>
      gridOf(
        'steps_straw',
        K.grass.map((s) =>
          mixInto(cut(ogg(s), 0.4), norm(thump(110, 55, 0.03, 0.15), -1), 0.004, -11),
        ),
      ),
  },
  steps_metal: {
    out: 'sfx/steps_metal.m4a',
    lufs: -19,
    credit: credit(FS.metalSteps),
    make: stepsMetal,
  },
  steps_water: { out: 'sfx/steps_water.m4a', lufs: -18, credit: credit(FS.wade), make: stepsWater },
  foley_cloth: {
    out: 'sfx/foley_cloth.m4a',
    lufs: -20,
    credit: credit(...K.cloth),
    make: () =>
      gridOf(
        'foley_cloth',
        K.cloth.map((s, i) => mixInto(swish(0.16 + i * 0.04, 31 + i), cut(ogg(s), 0.5), 0.03, -14)),
      ),
  },
  foley_reload: {
    out: 'sfx/foley_reload.m4a',
    lufs: -18,
    maxGR: 6,
    credit: credit(K.metalClick, K.metalLatch),
    // the gate opening, then the cylinder ratchet closing (0.0 and 0.4 s)
    make: () => mixInto(cut(ogg(K.metalLatch), 0.38), cut(ogg(K.metalClick), 0.35), 0.4),
  },
  ui_hit: {
    out: 'sfx/ui_hit.m4a',
    lufs: -18,
    maxGR: 4,
    credit: 'first-party (synthesised)',
    make: hitMarker,
  },
  ui_kill: {
    out: 'sfx/ui_kill.m4a',
    lufs: -16,
    credit: 'first-party (synthesised)',
    make: killConfirm,
  },
  crack: { out: 'sfx/crack.m4a', lufs: -15, maxGR: 4, credit: credit(FS.crack), make: crack },
  sign_creak: { out: 'sfx/sign_creak.m4a', lufs: -22, credit: credit(FS.sign), make: signCreak },
  whistle: {
    out: 'sfx/whistle.m4a',
    lufs: -18,
    credit: credit(FS.whistle),
    // heard from across the yard: no top end, a little air
    make: () => fade(mp3(FS.whistle, 'highpass=f=150,lowpass=f=3200'), 0.05, 1.5),
  },
  amb_loco: { out: 'sfx/amb_loco.m4a', lufs: -20, credit: credit(FS.locoIdle), make: locoIdle },
  amb_frontier_wind: {
    out: 'sfx/amb_frontier_wind.m4a',
    lufs: -20,
    credit: 'cut from the shipped amb_wind_day (generated, ElevenLabs)',
    make: () => bedFrom('amb_wind_day', 4, 20),
  },
  amb_murmur: {
    out: 'sfx/amb_murmur.m4a',
    lufs: -20,
    credit: 'cut from the shipped amb_saloon (generated, ElevenLabs)',
    make: () => bedFrom('amb_saloon', 3, 16),
  },
}
