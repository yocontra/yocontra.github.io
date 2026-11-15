/**
 * Frontier's most repeated sounds, each with enough takes that a firefight or a run of steps never
 * plays the same one twice in a row: the revolver report (8 takes), boots on boards (10) and dirt
 * (8), stone and straw (8 each), near-miss cracks (6), body falls (6), cloth (6) and the reload (6).
 * Takes are CC0 recordings (`cc0.ts`), the shipped first-party sounds, and careful re-pitches and
 * layerings of both.
 */
import { credit, FREESOUND as FS, KENNEY as K } from './cc0.ts'
import { type Ch, fade, filt, load, mixInto, onset, silence, slice, thump } from './dsp.ts'
import { cut, gridOf, norm, rate, shipped, swish, ungrid } from './frontier-grid.ts'
import type { Recipe } from './recipes.ts'

const ogg = (s: { file: string }, filter?: string) => load(s.file, 1, filter)
const mp3 = (s: { file: string }, filter?: string) => load(s.file, 1, filter)
const at = <T>(list: readonly T[], i: number): T => list[i % list.length] as T

// ------------------------------------------------------------------ the report

/** The shipped report's voicing (`recipes.ts` revClose), so every take sits in one gun. */
const peq = (hz: number, width: number, db: number) => `equalizer=f=${hz}:t=q:w=${width}:g=${db}`
const REPORT_EQ = ['highpass=f=28', peq(110, 0.9, 4), peq(2800, 1, 2.5), peq(8500, 1, 3)].join(',')
/** A rounder, heavier take of the shipped report. */
const ROUNDER = [peq(320, 1, 2), peq(4200, 1, -2)].join(',')
/** The chamber's low punch under a take, voiced differently per take (`i`) so no two thump alike. */
const punch = (db: number, i: number) =>
  norm(thump(96 + i * 9, 40 + (i % 3) * 6, 0.045 + (i % 4) * 0.01, 0.3), db)

function shotsRevolver(): Ch {
  const shipped0 = load(shipped('rev_close'), 1)
  const pistol = mp3(FS.pistol, REPORT_EQ)
  const pair = mp3(FS.revolver38, REPORT_EQ)
  const magnum = mp3(FS.magnum, REPORT_EQ)
  const tail = mp3(FS.magnumTail, REPORT_EQ)
  const take = (ch: Ch, from: number, sub: number, i: number) =>
    mixInto(cut(ch, 0.75, -30, from), punch(-1, i), 0.001, sub)
  return gridOf(
    'shots_revolver',
    [
      shipped0,
      rate(filt(shipped0, ROUNDER), 0.95),
      take(pistol, 0, -8, 0),
      take(pair, 0.4, -7, 1),
      take(pair, 2.3, -7, 2),
      rate(take(magnum, 0, -6, 3), 0.93),
      take(tail, 0, -8, 4),
      // the shipped crack's first 40 ms into a lower, slower magnum body
      mixInto(
        fade(slice(shipped0, 0, 0.04), 0.001, 0.02),
        rate(cut(magnum, 0.75), 0.86),
        0.012,
        -2,
      ),
    ],
    'rms',
  )
}

const dark = (hz: number) => `lowpass=f=${hz}`

/** The town's answer to a shot: slap and rumble with the report itself gone, six rooms of it. */
function tailsStreet(): Ch {
  const town = load(shipped('rev_tail'), 1)
  const room = 'highpass=f=140,lowpass=f=7000'
  // each source's decay from just after its report (the first 0.12–0.2 s are the gun, not the town)
  const decay = (ch: Ch, from: number) => fade(slice(ch, from, from + 2.3), 0.04, 1)
  const tail = mp3(FS.magnumTail, room)
  const pair = mp3(FS.revolver38, room)
  const rifle = load(shipped('rifle'), 1, room)
  return gridOf('tails_street', [
    town,
    rate(town, 0.93),
    filt(rate(town, 1.06), dark(4200)),
    mixInto(decay(tail, onset(tail) + 0.18), rate(town, 0.97), 0.05, -9),
    mixInto(decay(pair, 2.38 + 0.16), rate(town, 1.03), 0.05, -8),
    filt(rate(decay(rifle, onset(rifle) + 0.2), 1.04), dark(3800)),
  ])
}

// ------------------------------------------------------------------ boots

/** Boots on a plank boardwalk: heel and toe, the boards' hollow under them. */
const stepsBoards = () =>
  gridOf(
    'steps_boards',
    K.boots.map((s) => cut(ogg(s, 'highpass=f=55,equalizer=f=170:t=q:w=1:g=2'), 0.42)),
  )

/** The shipped dirt steps (with the weak ones given their weight back) and two re-pitched takes. */
function stepsDirt(): Ch {
  const takes = ungrid('dirtsteps', 6, 0.6, 0.5).map((s) =>
    mixInto(s, norm(thump(90, 48, 0.035, 0.15), -1), 0.004, -16),
  )
  const crunch = cut(ogg(at(K.grass, 2), 'highpass=f=900'), 0.4)
  return gridOf('steps_dirt', [
    ...takes,
    mixInto(rate(at(takes, 0), 0.92), crunch, 0.003, -14),
    rate(at(takes, 3), 1.07),
  ])
}

const stepsStone = () => {
  const c = K.concrete.map((s) => cut(ogg(s), 0.4))
  return gridOf('steps_stone', [
    ...c,
    rate(at(c, 0), 0.92),
    rate(at(c, 2), 1.08),
    mixInto(at(c, 4), at(c, 1), 0.025, -10),
  ])
}

const stepsStraw = () => {
  const weight = () => norm(thump(110, 55, 0.03, 0.15), -1)
  return gridOf('steps_straw', [
    ...K.grass.map((s) => mixInto(cut(ogg(s), 0.4), weight(), 0.004, -11)),
    ...K.snow
      .slice(0, 3)
      .map((s) => mixInto(cut(ogg(s, 'lowpass=f=6000'), 0.4), weight(), 0.004, -11)),
  ])
}

// ------------------------------------------------------------------ air and bodies

/**
 * A supersonic round's N-wave (the pressure doubling a few tenths of a millisecond wide that is
 * the crack), a hiss of air behind it and the recording's own snap and sizzle under it.
 */
function nWave(widthMs: number, seed0: number): Ch {
  const n = Math.round(0.42 * 48_000)
  const out = new Float32Array(n)
  const w = (widthMs / 1000) * 48_000
  let seed = seed0
  for (let i = 0; i < n; i++) {
    seed = (seed * 16_807) % 2_147_483_647
    const t = i / 48_000
    const wave = i < w ? 1 - (2 * i) / w : 0
    const hiss = (seed / 2_147_483_647 - 0.5) * Math.exp(-t / 0.018) * 0.5
    out[i] = wave + hiss
  }
  return filt([out], 'highpass=f=1200,lowpass=f=14000')
}

function crack(): Ch {
  const one = cut(mp3(FS.crack, 'highpass=f=200'), 0.42)
  const synth = [0.35, 0.5, 0.28].map((w, i) =>
    mixInto(nWave(w, 17 + i), rate(one, [0.88, 1.12, 0.8][i] ?? 1), 0.002, -9),
  )
  return gridOf('crack', [one, rate(one, 1.07), rate(one, 0.93), ...synth])
}

/** A shot rider going down: knees, the body's weight, the gear settling. */
function bodyfalls(): Ch {
  const dirt = load(shipped('bodyfall'), 1)
  const boards = mp3(FS.fallBoards)
  const thud = cut(mp3(FS.fallThud), 1.0)
  const leather = ogg(K.dropLeather)
  const gear = (i: number) => cut(ogg(at(K.leather, i)), 0.5)
  return gridOf('bodyfalls', [
    dirt,
    mixInto(swish(0.2, 41), boards, 0.06, 0),
    mixInto(mixInto(swish(0.24, 43), thud, 0.1, 0), cut(leather, 0.6), 0.32, -6),
    mixInto(rate(dirt, 0.92), cut(leather, 0.6), 0.5, -10),
    mixInto(rate(boards, 0.94), rate(dirt, 1.05), 0.1, -8),
    mixInto(rate(dirt, 1.06), gear(1), 0.55, -9),
  ])
}

// ------------------------------------------------------------------ foley

const foleyCloth = () =>
  gridOf('foley_cloth', [
    ...K.cloth.map((s, i) => mixInto(swish(0.16 + i * 0.04, 31 + i), cut(ogg(s), 0.5), 0.03, -14)),
    ...K.clothBelt.map((s, i) =>
      mixInto(swish(0.2 + i * 0.05, 37 + i), cut(ogg(s), 0.5), 0.02, -12),
    ),
  ])

/** The loading gate opening and the cylinder ratcheting round, six ways. */
function foleyReload(): Ch {
  const latch = cut(ogg(K.metalLatch), 0.38)
  const click = cut(ogg(K.metalClick), 0.35)
  const gate = (l: Ch, c: Ch, when: number, lead = 0) =>
    mixInto(mixInto(silence(0.75, 1), l, lead), c, when)
  return gridOf('foley_reload', [
    gate(latch, click, 0.4),
    gate(rate(latch, 0.95), rate(click, 1.04), 0.36),
    mixInto(gate(latch, click, 0.42), cut(ogg(at(K.leather, 2)), 0.4), 0.05, -12),
    mixInto(gate(rate(latch, 1.05), click, 0.38), rate(click, 1.1), 0.5, -8),
    gate(latch, rate(click, 0.97), 0.45, 0.05),
    gate(rate(latch, 0.92), rate(click, 0.96), 0.4),
  ])
}

export const FRONTIER_KIT: Record<string, Recipe> = {
  shots_revolver: {
    out: 'sfx/shots_revolver.m4a',
    lufs: -14,
    maxGR: 6,
    credit: `${credit(FS.pistol, FS.revolver38, FS.magnum, FS.magnumTail)}; with the shipped rev_close`,
    make: shotsRevolver,
  },
  steps_boards: {
    out: 'sfx/steps_boards.m4a',
    lufs: -18,
    maxGR: 4,
    credit: credit(...K.boots),
    make: stepsBoards,
  },
  steps_dirt: {
    out: 'sfx/steps_dirt.m4a',
    lufs: -18,
    maxGR: 4,
    credit: `${credit(at(K.grass, 2))}; with the shipped dirtsteps`,
    make: stepsDirt,
  },
  steps_stone: {
    out: 'sfx/steps_stone.m4a',
    lufs: -18,
    maxGR: 4,
    credit: credit(...K.concrete),
    make: stepsStone,
  },
  steps_straw: {
    out: 'sfx/steps_straw.m4a',
    lufs: -19,
    credit: credit(...K.grass, ...K.snow.slice(0, 3)),
    make: stepsStraw,
  },
  crack: {
    out: 'sfx/crack.m4a',
    lufs: -15,
    maxGR: 4,
    credit: `${credit(FS.crack)}; with a synthesised N-wave`,
    make: crack,
  },
  bodyfalls: {
    out: 'sfx/bodyfalls.m4a',
    lufs: -16,
    maxGR: 3,
    credit: `${credit(FS.fallBoards, FS.fallThud, K.dropLeather, at(K.leather, 1))}; with the shipped bodyfall`,
    make: bodyfalls,
  },
  tails_street: {
    out: 'sfx/tails_street.m4a',
    lufs: -18,
    maxGR: 3,
    credit: `${credit(FS.magnumTail, FS.revolver38)}; with the shipped rev_tail and rifle`,
    make: tailsStreet,
  },
  foley_cloth: {
    out: 'sfx/foley_cloth.m4a',
    lufs: -20,
    credit: credit(...K.cloth, ...K.clothBelt),
    make: foleyCloth,
  },
  foley_reload: {
    out: 'sfx/foley_reload.m4a',
    lufs: -18,
    maxGR: 6,
    credit: credit(K.metalClick, K.metalLatch, at(K.leather, 2)),
    make: foleyReload,
  },
}
