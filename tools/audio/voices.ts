// biome-ignore-all lint/security/noSecrets: ElevenLabs voice ids are public identifiers, not secrets
/**
 * The out west voice cast (premium review #13): every outlaw speaks his captioned lines in a voice
 * of his own, grunts or breathes his last when he falls, and the player breathes and grunts through
 * the draw. `speak.ts` generates the takes, `build-voices.ts` masters them into one small file per
 * speaker.
 *
 * The lines are the captions, word for word (they come straight from the roster, so a copy edit
 * there is picked up on the next generation); a death is never words, so it needs no caption.
 *
 * Generation: ElevenLabs `eleven_v3` with premade voices (the free plan has no voice design and no
 * library voices), steered with v3 audio tags; a voice shared by two outlaws is pitched apart at
 * build time (`semis`). Gemini TTS (prebuilt voice plus performance notes) is the fallback engine.
 */
import { OUTLAWS } from '../../src/experiments/out-west/data/outlaws.ts'

export type VoiceKind = 'open' | 'taunt' | 'death'
export type EffortKind = 'draw' | 'flinch' | 'win' | 'death'

/** ElevenLabs premade voices this account can use through the API. */
export const EL = {
  liam: 'TX3LPaxmHKxFdv7VOQHJ',
  will: 'bIHbv24MWmeRgasZH58o',
  chris: 'iP95p4xoKVk53GoZ742B',
  roger: 'CwhRBWXzGAHq8TQ4Fs17',
  eric: 'cjVigY5qzO86Huf0OWal',
  brian: 'nPczCjzI2devNBz1zQrb',
  bill: 'pqHfZKP75CvOlQylNhV4',
  adam: 'pNInz6obpgDQGcFmaJgB',
  harry: 'SOYHLrjzK2X1ezoPC6cr',
  river: 'SAz9YHcvj6GT2YYXdXww',
  callum: 'N2lVS1w4EtoT3dr4eOWO',
  matilda: 'XrExE9yKIg1WjnnlVkGX',
  laura: 'FGY2WhTYpPnrIDTdsKH5',
} as const

export interface Cast {
  /** File id: `voice/<id>.m4a`. */
  id: string
  /** The roster name (`data/roster-*.ts`), or '' for the player. */
  name: string
  /** Who he sounds like, for the credits and the report. */
  voice: string
  engine: 'el' | 'gemini'
  /** ElevenLabs voice id, or the Gemini prebuilt voice name. */
  base: string
  /** v3 audio tags put before every line (ElevenLabs), or performance notes (Gemini). */
  style: string
  /** Pitch shift at build, semitones (formants move with it: lower reads bigger and older). */
  semis?: number
  /** Extra captioned lines he says outside his roster lines (the boss's clock, his wound). */
  extra?: readonly string[]
  /** v3 prompts for his death barks: non-verbal only. */
  deaths: readonly string[]
}

export interface Line {
  /** Key within the speaker: `l0`, `stall2`, `death1`… */
  key: string
  kind: VoiceKind | EffortKind
  /** The caption it voices ('' for a death or an effort). */
  text: string
  /** What the generator is asked to say (the caption with tags, or a non-verbal prompt). */
  say: string
}

/**
 * Whether the stall lines are voiced: 64 more takes (four per outlaw) is past this round's
 * ElevenLabs budget, so for now they stay captions only (a stall is rare). `OW_VOICE_STALL=1` voices them.
 */
const STALL_VOICED = process.env.OW_VOICE_STALL === '1'

/** Any outlaw may say one of these when you stall on the walk (`duel/walk.ts` STALL_LINES). */
export const STALL_LINES = [
  'You plannin’ on walkin’ today?',
  'I ain’t got all day, friend.',
  'My grandma walks faster.',
  'Scared?',
] as const

const GROAN = '[pained grunt] Hnngh… [dying exhale]'
const GASP = '[sharp gasp of pain] Ahh… [last breath]'

export const CAST: readonly Cast[] = [
  {
    id: 'greenhorn',
    name: 'Bret P. Barsh',
    voice: 'young, high and frightened; a stammer and a shaking breath (Liam, +1 st)',
    engine: 'el',
    base: EL.liam,
    style: '[nervous] [voice trembling]',
    semis: 1,
    deaths: ['[whimpers] Nnh… [weak gasp]', '[frightened yelp] Ah—! [whimper]'],
  },
  {
    id: 'talker',
    name: 'Prescott J. House',
    voice: 'loud, cocky, sneering salesman patter (Chris)',
    engine: 'el',
    base: EL.chris,
    style: '[mocking] [loud, cocky]',
    deaths: ['[shocked grunt] Urk— [choking gasp]', GROAN],
  },
  {
    id: 'counter',
    name: 'Calhoun C. Trine',
    voice: 'slow, dim and unsure; counts like each number is a guess (Will)',
    engine: 'el',
    base: EL.will,
    style: '[slow] [confused, unsure]',
    deaths: ['[surprised grunt] Huh— [groan]', '[confused groan] Uhhh… [thud of breath]'],
  },
  {
    id: 'cardsharp',
    name: 'Ace Q. McConly',
    voice: 'smooth, sly and amused; never raises his voice (Eric)',
    engine: 'el',
    base: EL.eric,
    style: '[smooth, sly] [quietly amused]',
    deaths: [
      '[soft surprised exhale] Hah… [last breath]',
      '[sharp intake of breath] Hh— [groan] Mmh…',
    ],
  },
  {
    id: 'drunk',
    name: 'Burney N. Coover',
    voice: 'old, gravelly and slurring, with hiccups (Bill)',
    engine: 'el',
    base: EL.bill,
    style: '[drunk] [slurring]',
    deaths: ['[hiccups] [drunken groan] Ohhh… [collapses with a sigh]', '[slurred groan] Mmmnh…'],
  },
  {
    id: 'impatient',
    name: 'Salvador R. Gruell',
    voice: 'a Mexican vaquero, quick and irritated, warm baritone; a natural Mexican accent',
    engine: 'gemini',
    base: 'Orus',
    style:
      'A Mexican vaquero in his forties, born in Sonora, speaking English with a natural, light Mexican accent. Impatient and irritated, clipped and quick, warm baritone, calling across a dusty street. Respectful, not a caricature.',
    deaths: [
      'A short pained grunt, then a final exhale. No words.',
      'A sharp gasp of pain and a dying breath. No words.',
    ],
  },
  {
    id: 'longwalker',
    name: 'Felipe K. Wheeler',
    voice: 'low, husky and unhurried; a patient drawl (Callum)',
    engine: 'el',
    base: EL.callum,
    style: '[calm] [low, unhurried drawl]',
    deaths: [GROAN, '[long tired exhale] Hhhaah…'],
  },
  {
    id: 'thornyrose',
    name: 'Laura Bullion',
    voice: 'a woman, cold and quiet; her one line is a breath (Matilda)',
    engine: 'el',
    base: EL.matilda,
    style: '[cold] [quiet]',
    deaths: ['[sharp gasp] Ah— [soft exhale]', '[pained intake of breath] Hh… [faint exhale] Hhh…'],
  },
  {
    id: 'starer',
    name: 'Thomas B. Arnold',
    voice: 'a cold, close whisper (River, −1 st)',
    engine: 'el',
    base: EL.river,
    style: '[whispering] [cold, unsettling]',
    semis: -1,
    deaths: ['[quiet gasp] Hh… [exhales]', '[low grunt] Ngh… [rattling breath]'],
  },
  {
    id: 'twogun',
    name: 'Delmer F. Gusselman',
    voice: 'brash young braggart (Harry)',
    engine: 'el',
    base: EL.harry,
    style: '[brash, cocky] [confident]',
    deaths: ['[angry grunt] Argh— [groan]', GROAN],
  },
  {
    id: 'stagerobber',
    name: 'Pearl Hart',
    voice: 'a woman, sassy and sure of herself (Laura)',
    engine: 'el',
    base: EL.laura,
    style: '[sassy] [confident, teasing]',
    deaths: ['[shocked gasp] Oh— [pained exhale]', '[sharp cry of pain] Ah! [fading breath]'],
  },
  {
    id: 'gambler',
    name: 'Luke Short',
    voice: 'easy, laid-back gambler, all charm (Roger)',
    engine: 'el',
    base: EL.roger,
    style: '[relaxed] [smooth, easy charm]',
    deaths: ['[surprised exhale] Huh… [last breath]', GASP],
  },
  {
    id: 'marshal',
    name: 'Dallas Stoudenmire',
    voice: 'big, booming lawman with a Texas drawl (Adam)',
    engine: 'el',
    base: EL.adam,
    style: '[deep, authoritative] [slow Texas drawl]',
    deaths: ['[deep grunt] Unnh— [heavy groan]', GROAN],
  },
  {
    id: 'fakeking',
    name: 'Harvey “Kid Curry” Logan',
    voice: 'twitchy, low menacing hiss (Liam, −2.5 st)',
    engine: 'el',
    base: EL.liam,
    style: '[menacing whisper] [taunting]',
    semis: -2.5,
    deaths: ['[hissing gasp] Hss— [groan]', GASP],
  },
  {
    id: 'deadmanshand',
    name: 'James “Wild Bill” Hickok',
    voice: 'deep, calm and measured, the voice of a legend (Brian)',
    engine: 'el',
    base: EL.brian,
    style: '[calm, deep] [measured]',
    deaths: ['[quiet grunt] Mm— [slow last exhale]', GROAN],
  },
  {
    id: 'underboss',
    name: 'William “Curly Bill” Brocius',
    voice: 'gruff, rowdy and chuckling (Harry, −3 st)',
    engine: 'el',
    base: EL.harry,
    style: '[gruff] [amused, rough]',
    semis: -3,
    deaths: ['[gruff roar of pain] Raagh— [groan]', GROAN],
  },
  {
    id: 'boss',
    name: 'John Wesley Hardin',
    voice: 'cold, low and menacing; the clock is his (Callum, −2.5 st)',
    engine: 'el',
    base: EL.callum,
    style: '[menacing] [cold, low]',
    semis: -2.5,
    extra: ['…TWELVE!', 'That… that’s just a scratch.'],
    deaths: [
      '[deep pained growl] Ghh… [long dying exhale]',
      '[choked gasp] Khh— [rattling last breath] Hhhh…',
    ],
  },
]

/** The player: breath and grunts only (the hero never talks over the street). */
export const PLAYER: Cast = {
  id: 'player',
  name: '',
  voice: 'efforts only, a grown man under pressure (Gemini Algenib)',
  engine: 'gemini',
  base: 'Algenib',
  style:
    'A weathered gunslinger in his thirties in a deadly duel, gravelly and low. These are non-verbal efforts: perform each bracketed action as a sound only (a breath, a grunt, a gasp) and never say the bracketed words; the letters after it are only the shape of the sound. Keep it short.',
  deaths: [],
}

export const EFFORTS: readonly { kind: EffortKind; say: string }[] = [
  { kind: 'draw', say: '[sharp exhale through the teeth] Hhh!' },
  { kind: 'draw', say: '[short grunt of effort] Hm!' },
  { kind: 'draw', say: '[quick forceful exhale] Ffh!' },
  { kind: 'flinch', say: '[startled sharp intake of breath] Hh!' },
  { kind: 'flinch', say: '[flinching gasp] Hah—' },
  { kind: 'win', say: '[long relieved exhale] Hhhhaaah…' },
  { kind: 'win', say: '[shaky relieved breath out] Phew…' },
  { kind: 'death', say: '[gut-punched grunt] Ugh— [pained groan]' },
  { kind: 'death', say: '[sharp cry of pain] Agh! [dying breath]' },
  { kind: 'death', say: '[choked gasp] Hkk… [last exhale]' },
]

/** v3 reads these captions badly as words: say the sound instead. */
const NON_VERBAL: Readonly<Record<string, string>> = {
  '*hic*': '[hiccups loudly] Hic!',
  '…': '[slow, cold exhale through the nose] Hmm.',
}

/** Every line a speaker says, with the caption it voices. */
export function linesOf(c: Cast): Line[] {
  const roster = OUTLAWS.find((o) => o.name === c.name)?.lines ?? []
  const said = (text: string) =>
    c.engine === 'el' ? `${c.style} ${NON_VERBAL[text] ?? text}` : (NON_VERBAL[text] ?? text)
  const out: Line[] = roster.map((text, i) => ({
    key: `l${i}`,
    kind: i === 0 ? 'open' : 'taunt',
    text,
    say: said(text),
  }))
  for (const [i, text] of (c.extra ?? []).entries()) {
    out.push({ key: `x${i}`, kind: 'taunt', text, say: said(text) })
  }
  for (const [i, text] of STALL_VOICED ? STALL_LINES.entries() : []) {
    out.push({ key: `stall${i}`, kind: 'taunt', text, say: said(text) })
  }
  for (const [i, say] of c.deaths.entries()) {
    out.push({ key: `death${i}`, kind: 'death', text: '', say })
  }
  return out
}

export function effortLines(): Line[] {
  return EFFORTS.map((e, i) => ({ key: `e${i}`, kind: e.kind, text: '', say: e.say }))
}

export const castById = (id: string): Cast | undefined =>
  id === PLAYER.id ? PLAYER : CAST.find((c) => c.id === id)
