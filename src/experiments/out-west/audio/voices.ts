// biome-ignore-all lint/style/useNamingConvention: keys are the roster's names, as the captions name the speaker
// biome-ignore-all lint/suspicious/noApproximativeNumericConstant: slice times, not constants
/**
 * Voice lines, written by `tools/audio/build-voices.ts`. Do not edit by hand.
 *
 * One mono file per speaker (906 KB in all), fetched only when his duel is
 * staged (`AudioEngine.loadVoice`). Each line is a slice of it: `at` and `len` in seconds.
 * `text` is the caption it voices ('' for a grunt or a breath).
 */
export type VoiceKind = 'open' | 'taunt' | 'death'
export type EffortKind = 'draw' | 'flinch' | 'win' | 'death'

export interface VoiceLine {
  readonly kind: VoiceKind | EffortKind
  readonly text: string
  readonly at: number
  readonly len: number
}

export interface VoiceFile {
  readonly url: string
  readonly lines: readonly VoiceLine[]
}

/** Outlaws by roster name. */
export const VOICE_CAST: Readonly<Record<string, VoiceFile>> = {
  'Bret P. Barsh': {
    url: '/experiments/out-west/3d/voice/greenhorn.m4a',
    lines: [
      { kind: 'open', text: 'M-ma always said I was quick…', at: 0, len: 2.202 },
      { kind: 'taunt', text: 'Is it… is it time yet?', at: 2.322, len: 1.819 },
      { kind: 'death', text: '', at: 4.261, len: 2.415 },
      { kind: 'death', text: '', at: 6.796, len: 1.239 },
    ],
  },
  'Prescott J. House': {
    url: '/experiments/out-west/3d/voice/talker.m4a',
    lines: [
      { kind: 'open', text: 'One! You walk like a mule.', at: 0, len: 1.898 },
      { kind: 'taunt', text: 'Two! My grandma draws faster.', at: 2.018, len: 2.3 },
      { kind: 'taunt', text: 'Three! Smell that? That’s fear.', at: 4.438, len: 3.051 },
      { kind: 'taunt', text: 'Four! Nice boots. I’ll take ’em.', at: 7.609, len: 2.235 },
      { kind: 'taunt', text: 'Five! Write your will yet?', at: 9.964, len: 1.788 },
      { kind: 'taunt', text: 'Six! Still walkin’, huh?', at: 11.873, len: 1.854 },
      { kind: 'taunt', text: 'Seven! I’m bored already.', at: 13.846, len: 2.055 },
      { kind: 'taunt', text: 'Eight! Turn around, coward.', at: 16.021, len: 1.883 },
      { kind: 'death', text: '', at: 18.024, len: 1.798 },
      { kind: 'death', text: '', at: 19.942, len: 3.2 },
    ],
  },
  'Calhoun C. Trine': {
    url: '/experiments/out-west/3d/voice/counter.m4a',
    lines: [
      { kind: 'open', text: 'One…', at: 0, len: 0.855 },
      { kind: 'taunt', text: 'Two…', at: 0.975, len: 1.145 },
      { kind: 'taunt', text: 'Four…', at: 2.239, len: 1.44 },
      { kind: 'taunt', text: 'Seven…', at: 3.799, len: 1.099 },
      { kind: 'taunt', text: 'Five?', at: 5.018, len: 1.667 },
      { kind: 'taunt', text: 'Nine…', at: 6.805, len: 1.009 },
      { kind: 'taunt', text: 'Uh… twelve…', at: 7.934, len: 2.154 },
      { kind: 'taunt', text: 'Six!', at: 10.209, len: 1.41 },
      { kind: 'taunt', text: 'Ten-ish…', at: 11.739, len: 1.414 },
      { kind: 'death', text: '', at: 13.273, len: 1.9 },
      { kind: 'death', text: '', at: 15.293, len: 2.692 },
    ],
  },
  'Ace Q. McConly': {
    url: '/experiments/out-west/3d/voice/cardsharp.m4a',
    lines: [
      { kind: 'open', text: 'Heads, you die. Tails, you die.', at: 0, len: 4.894 },
      { kind: 'death', text: '', at: 5.014, len: 1.423 },
      { kind: 'death', text: '', at: 6.557, len: 2.46 },
    ],
  },
  'Burney N. Coover': {
    url: '/experiments/out-west/3d/voice/drunk.m4a',
    lines: [
      { kind: 'open', text: '*hic*', at: 0, len: 1.23 },
      { kind: 'taunt', text: 'Which one of you’s real?', at: 1.35, len: 1.76 },
      { kind: 'taunt', text: 'Hold still, the both of ya.', at: 3.23, len: 2.073 },
      { kind: 'death', text: '', at: 5.423, len: 2.96 },
      { kind: 'death', text: '', at: 8.503, len: 1.52 },
    ],
  },
  'Salvador R. Gruell': {
    url: '/experiments/out-west/3d/voice/impatient.m4a',
    lines: [
      { kind: 'open', text: 'Vámonos, already.', at: 0, len: 1.266 },
      { kind: 'taunt', text: 'I got a lunch to get to.', at: 1.386, len: 1.587 },
      { kind: 'death', text: '', at: 3.093, len: 1.791 },
      { kind: 'death', text: '', at: 5.003, len: 6.141 },
    ],
  },
  'Felipe K. Wheeler': {
    url: '/experiments/out-west/3d/voice/longwalker.m4a',
    lines: [
      { kind: 'open', text: 'Keep walkin’, friend.', at: 0, len: 1.371 },
      { kind: 'death', text: '', at: 1.491, len: 3.858 },
      { kind: 'death', text: '', at: 5.469, len: 1.141 },
    ],
  },
  'Laura Bullion': {
    url: '/experiments/out-west/3d/voice/thornyrose.m4a',
    lines: [
      { kind: 'open', text: '…', at: 0, len: 1.227 },
      { kind: 'death', text: '', at: 1.347, len: 2.041 },
      { kind: 'death', text: '', at: 3.508, len: 2.335 },
    ],
  },
  'Thomas B. Arnold': {
    url: '/experiments/out-west/3d/voice/starer.m4a',
    lines: [
      { kind: 'open', text: 'I can see you sweatin’.', at: 0, len: 1.598 },
      { kind: 'death', text: '', at: 1.718, len: 1.794 },
      { kind: 'death', text: '', at: 3.632, len: 2.142 },
    ],
  },
  'Delmer F. Gusselman': {
    url: '/experiments/out-west/3d/voice/twogun.m4a',
    lines: [
      { kind: 'open', text: 'Two’s better than one.', at: 0, len: 2.32 },
      { kind: 'death', text: '', at: 2.44, len: 2.569 },
      { kind: 'death', text: '', at: 5.129, len: 3.04 },
    ],
  },
  'Pearl Hart': {
    url: '/experiments/out-west/3d/voice/stagerobber.m4a',
    lines: [
      { kind: 'open', text: 'The boys are watching.', at: 0, len: 1.68 },
      { kind: 'death', text: '', at: 1.8, len: 2.09 },
      { kind: 'death', text: '', at: 4.01, len: 1.835 },
    ],
  },
  'Luke Short': {
    url: '/experiments/out-west/3d/voice/gambler.m4a',
    lines: [
      { kind: 'open', text: 'Deal me in.', at: 0, len: 0.969 },
      { kind: 'death', text: '', at: 1.089, len: 2.24 },
      { kind: 'death', text: '', at: 3.449, len: 3.607 },
    ],
  },
  'Dallas Stoudenmire': {
    url: '/experiments/out-west/3d/voice/marshal.m4a',
    lines: [
      { kind: 'open', text: 'Lights out.', at: 0, len: 1.12 },
      { kind: 'death', text: '', at: 1.24, len: 2.24 },
      { kind: 'death', text: '', at: 3.6, len: 2.426 },
    ],
  },
  'Harvey “Kid Curry” Logan': {
    url: '/experiments/out-west/3d/voice/fakeking.m4a',
    lines: [
      { kind: 'open', text: 'Flinch.', at: 0, len: 1.345 },
      { kind: 'death', text: '', at: 1.465, len: 2.483 },
      { kind: 'death', text: '', at: 4.068, len: 3.24 },
    ],
  },
  'James “Wild Bill” Hickok': {
    url: '/experiments/out-west/3d/voice/deadmanshand.m4a',
    lines: [
      { kind: 'open', text: 'Aces and eights.', at: 0, len: 1.748 },
      { kind: 'death', text: '', at: 1.868, len: 2.071 },
      { kind: 'death', text: '', at: 4.06, len: 2.761 },
    ],
  },
  'William “Curly Bill” Brocius': {
    url: '/experiments/out-west/3d/voice/underboss.m4a',
    lines: [
      { kind: 'open', text: 'Look up, friend.', at: 0, len: 1.185 },
      { kind: 'death', text: '', at: 1.305, len: 1.724 },
      { kind: 'death', text: '', at: 3.149, len: 2.269 },
    ],
  },
  'John Wesley Hardin': {
    url: '/experiments/out-west/3d/voice/boss.m4a',
    lines: [
      { kind: 'taunt', text: '…TWELVE!', at: 0, len: 0.889 },
      { kind: 'taunt', text: 'That… that’s just a scratch.', at: 1.009, len: 3.252 },
      { kind: 'death', text: '', at: 4.381, len: 2.609 },
      { kind: 'death', text: '', at: 7.11, len: 3.476 },
    ],
  },
}

/** The player's breaths and grunts. */
export const PLAYER_VOICE: {
  readonly url: string
  readonly efforts: Readonly<Record<EffortKind, readonly VoiceLine[]>>
} = {
  url: '/experiments/out-west/3d/voice/player.m4a',
  efforts: {
    draw: [
      { kind: 'draw', text: '', at: 0, len: 1.115 },
      { kind: 'draw', text: '', at: 1.235, len: 0.697 },
      { kind: 'draw', text: '', at: 2.052, len: 0.982 },
    ],
    flinch: [
      { kind: 'flinch', text: '', at: 3.154, len: 0.559 },
      { kind: 'flinch', text: '', at: 3.834, len: 1.262 },
    ],
    win: [
      { kind: 'win', text: '', at: 5.216, len: 2.201 },
      { kind: 'win', text: '', at: 7.536, len: 1.678 },
    ],
    death: [
      { kind: 'death', text: '', at: 9.335, len: 2.255 },
      { kind: 'death', text: '', at: 11.71, len: 2.989 },
      { kind: 'death', text: '', at: 14.819, len: 3.185 },
    ],
  },
}
