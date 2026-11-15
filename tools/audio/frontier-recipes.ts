/**
 * The Frontier world kit: bullet impacts per material, footsteps per surface, jump and landing
 * foley, near-miss cracks, hit markers and the depot / sign ambience. Gridded files hold `count`
 * variants `step` s apart (`FRONTIER_GRIDS`), which the client slices with native sound slots.
 */
import { type Cc0Source, credit, FREESOUND as FS, KENNEY as K } from './cc0.ts'
import {
  type Ch,
  fade,
  filt,
  load,
  loopify,
  mixInto,
  type Packed,
  pack,
  secs,
  slice,
  thump,
} from './dsp.ts'
import { cut, gridOf, norm, rate, shipped, sliced, swish } from './frontier-grid.ts'
import { FRONTIER_KIT } from './frontier-kit.ts'
import type { Recipe } from './recipes.ts'

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
  // a heavy punch into a coat, with the bullet's snap on top and the chest's weight under it
  const punches = K.punch
    .slice(0, 4)
    .map((s, i) =>
      rate(
        mixInto(mixInto(cut(ogg(s), 0.42), cut(head, 0.3), 0.002, -8), weight, 0, -11),
        [0.94, 1.04, 0.9, 1.08][i] ?? 1,
      ),
    )
  return gridOf('hit_flesh', [
    a,
    b,
    rate(mixInto(a, swish(0.12, 5), 0.01, -10), 0.86),
    rate(b, 1.14),
    ...punches,
  ])
}

function stone(): Ch {
  const one = cut(mp3(FS.concrete, 'highpass=f=80'), 0.55)
  const many = mp3(FS.impacts, 'highpass=f=90')
  // chips of rock off a pick: brick and adobe spalling
  const chips = MINING.map((s) => mixInto(cut(ogg(s), 0.55), one, 0.002, -12))
  return gridOf('hit_stone', [one, ...sliced(many, 5, { len: 0.55, gap: 0.6, rel: -20 }), ...chips])
}

const MINING = [K.mining[0], K.mining[2]] as Cc0Source[]
const METAL_PLATES = [
  K.metalHeavy[3],
  K.metalHeavy[4],
  K.metalMedium[3],
  K.metalLight[1],
] as Cc0Source[]

/** The shipped ricochets (strike and whine) with a round ringing a steel gallery target on top. */
function metal(): Ch {
  const steel = mp3(FS.gallery, 'highpass=f=150')
  const ric = load(shipped('ricochet'), 1)
  const hits = [1.6, 2.82, 8.42, 15.1].map((t, i) =>
    mixInto(cut(ric, 0.85, -30, i), cut(steel, 0.85, -30, t), 0, -3),
  )
  // struck plate and boxcar steel, each with one of the ricochets' whines trailing off it
  const plates = [K.metalHeavy[3], K.metalHeavy[4], K.metalMedium[3], K.metalLight[1]].map((s, i) =>
    mixInto(
      cut(ogg(s as { file: string }), 0.85),
      rate(cut(ric, 0.85, -30, (i + 2) % 4), 1.06),
      0.01,
      -5,
    ),
  )
  return gridOf('hit_metal', [...hits, ...plates])
}

/** The plink of the surface breaking, a quick spray thrown up off it and a low cavitation thwup. */
function water(): Ch {
  const plink = cut(mp3(FS.waterBullet, 'highpass=f=200'), 0.3)
  const spray = sliced(mp3(FS.wade, 'highpass=f=350'), 8, { len: 0.55, gap: 0.6, rel: -20 }).map(
    (s) => rate(s, 1.3),
  )
  const thwup = norm(thump(150, 55, 0.035, 0.2), -1)
  const take = (s: Ch, r: number) =>
    rate(mixInto(mixInto(norm(s, -1), plink, 0, -3), thwup, 0, -10), r)
  const rates = [1, 0.94, 1.06, 0.9, 1.1, 0.97, 1.03, 0.92]
  return gridOf(
    'hit_water',
    spray.map((s, i) => take(s, rates[i] ?? 1)),
  )
}

function soft(): Ch {
  const hay = [...K.softMedium, ...K.softHeavy.slice(0, 3)].map((s) =>
    mixInto(cut(ogg(s), 0.4), norm(thump(95, 50, 0.04, 0.2), -1), 0, -12),
  )
  return gridOf('hit_soft', hay)
}

function timber(): Ch {
  const old = cut(load(shipped('hit_wood'), 1), 0.5)
  const heavy = K.woodHeavy.map((s) => mixInto(cut(ogg(s), 0.5), old, 0.003, -12))
  const medium = K.woodMedium
    .slice(0, 4)
    .map((s, i) => mixInto(cut(ogg(s), 0.5), rate(old, 0.9 + i * 0.06), 0.002, -10))
  return gridOf('hit_timber', [old, ...heavy, ...medium])
}

function ground(): Ch {
  const old = cut(load(shipped('hit_dirt'), 1), 0.5)
  const impacts = mp3(FS.impacts, lowpass(2500))
  const grit = sliced(impacts, 5, { len: 0.5, gap: 0.6, rel: -20 })
  const g = (i: number) => grit[i % grit.length] as Ch
  return gridOf('hit_ground', [
    old,
    rate(old, 0.9),
    mixInto(rate(old, 1.1), g(0), 0, -14),
    rate(old, 0.82),
    mixInto(rate(old, 0.95), g(1), 0.004, -10),
    mixInto(rate(old, 1.05), g(2), 0, -12),
    mixInto(rate(old, 0.87), g(3), 0.006, -9),
    mixInto(rate(old, 1.14), g(4), 0, -11),
  ])
}

// ---------------------------------------------------------------- footsteps

const stepsMetal = () =>
  gridOf(
    'steps_metal',
    sliced(mp3(FS.metalSteps, 'highpass=f=70'), 6, { len: 0.6, gap: 0.6, rel: -18 }),
  )
const stepsWater = () =>
  gridOf('steps_water', sliced(mp3(FS.wade, 'highpass=f=60'), 8, { len: 0.6, gap: 0.55, rel: -20 }))

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
    credit: `${credit(FS.headshot, ...K.punch.slice(0, 4))}; with the shipped hit_body`,
    make: flesh,
  },
  hit_stone: {
    out: 'sfx/hit_stone.m4a',
    lufs: -16,
    maxGR: 3,
    credit: credit(FS.concrete, FS.impacts, ...MINING),
    make: stone,
  },
  hit_metal: {
    out: 'sfx/hit_metal.m4a',
    lufs: -17,
    maxGR: 5,
    credit: `${credit(FS.gallery, ...METAL_PLATES)}; with the shipped ricochet`,
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
    credit: credit(...K.softMedium, ...K.softHeavy.slice(0, 3)),
    make: soft,
  },
  hit_timber: {
    out: 'sfx/hit_timber.m4a',
    lufs: -16,
    maxGR: 5,
    credit: `${credit(...K.woodHeavy, ...K.woodMedium.slice(0, 4))}; with the shipped hit_wood`,
    make: timber,
  },
  hit_ground: {
    out: 'sfx/hit_ground.m4a',
    lufs: -16,
    credit: `${credit(FS.impacts)}; with the shipped hit_dirt`,
    make: ground,
  },
  steps_metal: {
    out: 'sfx/steps_metal.m4a',
    lufs: -19,
    credit: credit(FS.metalSteps),
    make: stepsMetal,
  },
  steps_water: { out: 'sfx/steps_water.m4a', lufs: -18, credit: credit(FS.wade), make: stepsWater },
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
  ...FRONTIER_KIT,
}
