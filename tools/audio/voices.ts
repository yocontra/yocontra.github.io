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
 * Generation: Gemini TTS (a prebuilt voice steered by performance notes, on the cloud credit) for
 * most of the cast; two keep their ElevenLabs `eleven_v3` premade voices (steered with v3 audio
 * tags), which won their blind auditions. No two outlaws share a voice.
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
 * Whether the stall lines are voiced (four per outlaw). Most of the cast is Gemini on the cloud
 * credit now, so they are; `OW_VOICE_STALL=0` leaves them captions only.
 */
const STALL_VOICED = process.env.OW_VOICE_STALL !== '0'

/** Any outlaw may say one of these when you stall on the walk (`duel/walk.ts` STALL_LINES). */
export const STALL_LINES = [
  'You plannin’ on walkin’ today?',
  'I ain’t got all day, friend.',
  'My grandma walks faster.',
  'Scared?',
] as const

const GROAN = '[pained grunt] Hnngh… [dying exhale]'
const GASP = '[sharp gasp of pain] Ahh… [last breath]'

/**
 * Every Gemini voice speaks into the same street: the notes end with this, so the takes share a
 * mic, a distance and a register (the room itself is added in the engine, `AudioEngine.speak`).
 */
const STREET =
  'Recorded close on a good microphone, dry, no music. A gritty western: grounded and real, never cartoonish, never a narrator. Speak only the transcript; bracketed words are actions to perform as sounds (a breath, a grunt, a hiccup), never read aloud.'

/** A Gemini cast member: a prebuilt voice and his performance notes. */
const gem = (c: Omit<Cast, 'engine' | 'style'> & { notes: string }): Cast => ({
  ...c,
  engine: 'gemini',
  style: `${c.notes} ${STREET}`,
})

/**
 * The cast. Casting audit (Nov 2026): each voice was auditioned blind against the shipped take by
 * a Gemini listening pass (`cast-audit.ts`), every outlaw has a voice of his own (no shared
 * pitched voices), and the perceived sex matches the rig (the two `woman` rigs are the only women).
 */
export const CAST: readonly Cast[] = [
  gem({
    id: 'greenhorn',
    name: 'Bret P. Barsh',
    voice: 'a frightened farm boy of nineteen, stammering (Gemini Sadachbia)',
    base: 'Sadachbia',
    notes:
      'Bret, a frightened farm boy of nineteen in his first gunfight. Young, thin voice that shakes; a nervous swallow before he speaks, a stammer, trailing off as he tries to convince himself. Rural American accent.',
    deaths: ['[frightened whimper] Nnh… [weak gasp]', '[startled yelp of pain] Ah—! [whimper]'],
  }),
  gem({
    id: 'talker',
    name: 'Prescott J. House',
    voice: 'a loud, sneering snake-oil heckler (Gemini Fenrir)',
    base: 'Fenrir',
    notes:
      'Prescott, a loud, cocky snake-oil salesman in his thirties heckling a man across a dusty street. Bark the pace number like a carnival barker, then sneer the insult with relish. Quick patter, gravel in the voice, Southern twang.',
    deaths: ['[shocked choking grunt] Urk— [choking gasp]', GROAN],
  }),
  {
    id: 'counter',
    name: 'Calhoun C. Trine',
    voice: 'slow, dim and unsure; counts like each number is a guess (ElevenLabs Will)',
    engine: 'el',
    base: EL.will,
    style: '[slow] [confused, unsure]',
    deaths: ['[surprised grunt] Huh— [groan]', '[confused groan] Uhhh… [thud of breath]'],
  },
  gem({
    id: 'cardsharp',
    name: 'Ace Q. McConly',
    voice: 'smooth, sly and amused; never raises his voice (Gemini Charon)',
    base: 'Charon',
    notes:
      'Ace, a smooth, sly card cheat in his thirties flipping a coin: cool and quietly amused, never raising his voice, a faint smirk, an easy pause between the two halves as if the coin is in the air. Soft Southern gentleman lilt, silky.',
    deaths: [
      '[soft surprised exhale] Hah… [last breath]',
      '[sharp intake of breath] Hh— [low groan] Mmh…',
    ],
  }),
  gem({
    id: 'drunk',
    name: 'Burney N. Coover',
    voice: 'an old, gravelly drunk, slurring (Gemini Alnilam)',
    base: 'Alnilam',
    notes:
      'Burney, an old drunk of sixty, gravelly and slurring, swaying and squinting at what looks like two men, genuinely confused; slow, syrupy, a wet breath between words. A real hiccup where the transcript has one.',
    deaths: ['[hiccup] [drunken groan] Ohhh… [collapsing sigh]', '[slurred groan] Mmmnh…'],
  }),
  gem({
    id: 'impatient',
    name: 'Salvador R. Gruell',
    voice:
      'a Mexican vaquero with a clear Mexican Spanish accent, quick and irritated, warm baritone (Gemini Orus)',
    base: 'Orus',
    notes:
      'Salvador, a Mexican vaquero in his forties, born in Sonora; English is his second language and his Mexican Spanish accent is clear in every word (rolled r, pure Spanish vowels, "already" as "al-ready"), natural and warm. Impatient and irritated, clipped and quick, warm baritone, calling across a dusty street. Respectful, not a caricature. "lunch" rhymes with "punch".',
    deaths: ['[short pained grunt] Ngh— [final exhale]', GASP],
  }),
  gem({
    id: 'longwalker',
    name: 'Felipe K. Wheeler',
    voice: 'low, husky and unhurried; a patient drawl (Gemini Enceladus)',
    base: 'Enceladus',
    notes:
      'Felipe, a low, husky, unhurried gunman in his forties, patient and dry, speaking under the wind; a slow frontier drawl, almost kind, with menace underneath.',
    deaths: [GROAN, '[long tired exhale] Hhhaah…'],
  }),
  {
    id: 'thornyrose',
    name: 'Laura Bullion',
    voice: 'a woman, cold and quiet; her one line is a breath (ElevenLabs Matilda)',
    engine: 'el',
    base: EL.matilda,
    style: '[cold] [quiet]',
    deaths: ['[sharp gasp] Ah— [soft exhale]', '[pained intake of breath] Hh… [faint exhale] Hhh…'],
  },
  gem({
    id: 'starer',
    name: 'Thomas B. Arnold',
    voice: 'a cold, close, unblinking man; a near-whisper from the chest (Gemini Rasalgethi)',
    base: 'Rasalgethi',
    notes:
      'Thomas, a cold, unhurried man in his late forties with an undertaker’s calm: low, dry and close, almost a whisper but fully voiced in the chest. American frontier accent, a slight Southern drawl. He leans on "see" and lets the last word trail off with a faint amused breath. No warmth at all.',
    deaths: ['[quiet gasp] Hh… [slow exhale]', '[low grunt] Ngh… [slow last breath] Hhh…'],
  }),
  gem({
    id: 'twogun',
    name: 'Delmer F. Gusselman',
    voice: 'a brash young braggart (Gemini Achird)',
    base: 'Achird',
    notes:
      'Delmer, a brash young braggart in his twenties showing off two pistols: a cocky grin in the voice, loud and pleased with himself, frontier twang, leaning on the key word.',
    deaths: ['[angry grunt] Argh— [groan]', GROAN],
  }),
  gem({
    id: 'stagerobber',
    name: 'Pearl Hart',
    voice: 'a young woman of twenty-seven, sassy and sure of herself (Gemini Despina)',
    base: 'Despina',
    notes:
      'Pearl Hart, a sassy young outlaw woman of twenty-seven, sure of herself, teasing and dangerous, a sly smile in her voice; a clear, young woman’s voice, smooth and confident, not raspy, frontier accent; she says it like a secret and a threat.',
    deaths: ['[shocked gasp] Oh— [pained exhale]', '[sharp cry of pain] Ah! [fading breath]'],
  }),
  gem({
    id: 'gambler',
    name: 'Luke Short',
    voice: 'an easy, laid-back gambler with steel under the charm (Gemini Umbriel)',
    base: 'Umbriel',
    notes:
      'Luke Short, a dapper professional gambler in his thirties: easy charm and confidence, relaxed and smiling, an unhurried Southern drawl, steel under it.',
    deaths: ['[surprised exhale] Huh… [last breath]', GASP],
  }),
  gem({
    id: 'marshal',
    name: 'Dallas Stoudenmire',
    voice: 'a huge, booming Texas lawman (Gemini Zubenelgenubi)',
    base: 'Zubenelgenubi',
    notes:
      'Dallas Stoudenmire, a six-foot-four Texas town marshal in his forties: deep, booming and authoritative, a slow Texas drawl, final and certain, like a door closing on the night.',
    deaths: ['[deep grunt] Unnh— [heavy groan]', GROAN],
  }),
  gem({
    id: 'fakeking',
    name: 'Harvey “Kid Curry” Logan',
    voice: 'a wiry, twitchy young killer; a low hiss (Gemini Puck)',
    base: 'Puck',
    notes:
      'Kid Curry, a wiry, twitchy young killer in his twenties: a low menacing hiss through the teeth, coiled and jittery, American frontier accent. Spat out quietly like a dare, with a tense breath before it.',
    deaths: ['[hissing gasp] Hss— [groan]', GASP],
  }),
  gem({
    id: 'deadmanshand',
    name: 'James “Wild Bill” Hickok',
    voice: 'deep, calm and measured, the voice of a legend (Gemini Iapetus)',
    base: 'Iapetus',
    notes:
      'Wild Bill Hickok, a legend in his late thirties: deep, calm and measured, quietly fatalistic, an unhurried Midwestern frontier voice, each word placed like a card on the table.',
    deaths: ['[quiet grunt] Mm— [slow last exhale]', GROAN],
  }),
  gem({
    id: 'underboss',
    name: 'William “Curly Bill” Brocius',
    voice: 'a big, rowdy, black-bearded rustler with a dark chuckle (Gemini Sadaltager)',
    base: 'Sadaltager',
    notes:
      'Curly Bill Brocius, a big, rowdy, black-bearded rustler in his thirties, gruff and booming with a rough cowboy twang, a dark chuckle in his throat: his rifleman on the roof already has you in his sights.',
    deaths: ['[gruff roar of pain] Raagh— [groan]', GROAN],
  }),
  gem({
    id: 'boss',
    name: 'John Wesley Hardin',
    voice: 'cold, low and menacing Texan; the clock is his (Gemini Schedar)',
    base: 'Schedar',
    notes:
      'John Wesley Hardin, the deadliest gunman in Texas, fifty: a cold Texas drawl, low and controlled, menace without effort. He shouts the last stroke of midnight as the call; shot, he refuses to show it, a sharp pained breath and the words through clenched teeth, contemptuous.',
    extra: ['…TWELVE!', 'That… that’s just a scratch.'],
    deaths: [
      '[deep pained growl] Ghh… [long dying exhale]',
      '[choked gasp] Khh— [rattling last breath] Hhhh…',
    ],
  }),
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
