// biome-ignore-all lint/style/useNamingConvention: keys are the roster's names, as the captions name the speaker
// biome-ignore-all lint/suspicious/noApproximativeNumericConstant: slice times, not constants
/**
 * Voice lines, written by `tools/audio/build-voices.ts`. Do not edit by hand.
 *
 * One mono file per speaker (2171 KB in all), fetched only when his duel is
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
      { kind: 'open', text: 'M-ma always said I was quick…', at: 0, len: 3.213 },
      { kind: 'taunt', text: 'Is it… is it time yet?', at: 3.333, len: 2.508 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 5.961, len: 2.398 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 8.479, len: 2.892 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 11.491, len: 3.159 },
      { kind: 'taunt', text: 'Scared?', at: 14.77, len: 1.207 },
      { kind: 'death', text: '', at: 16.097, len: 3.44 },
      { kind: 'death', text: '', at: 19.657, len: 2.548 },
    ],
  },
  'Prescott J. House': {
    url: '/experiments/out-west/3d/voice/talker.m4a',
    lines: [
      { kind: 'open', text: 'One! You walk like a mule.', at: 0, len: 2.605 },
      { kind: 'taunt', text: 'Two! My grandma draws faster.', at: 2.725, len: 2.605 },
      { kind: 'taunt', text: 'Three! Smell that? That’s fear.', at: 5.45, len: 2.605 },
      { kind: 'taunt', text: 'Four! Nice boots. I’ll take ’em.', at: 8.176, len: 3.014 },
      { kind: 'taunt', text: 'Five! Write your will yet?', at: 11.31, len: 2.411 },
      { kind: 'taunt', text: 'Six! Still walkin’, huh?', at: 13.841, len: 2.606 },
      { kind: 'taunt', text: 'Seven! I’m bored already.', at: 16.567, len: 2.639 },
      { kind: 'taunt', text: 'Eight! Turn around, coward.', at: 19.326, len: 2.323 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 21.768, len: 2.034 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 23.923, len: 2.362 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 26.405, len: 2.609 },
      { kind: 'taunt', text: 'Scared?', at: 29.134, len: 0.931 },
      { kind: 'death', text: '', at: 30.185, len: 2.96 },
      { kind: 'death', text: '', at: 33.265, len: 2.353 },
    ],
  },
  'Calhoun C. Trine': {
    url: '/experiments/out-west/3d/voice/counter.m4a',
    lines: [
      { kind: 'open', text: 'One…', at: 0, len: 0.855 },
      { kind: 'taunt', text: 'Two…', at: 0.975, len: 1.145 },
      { kind: 'taunt', text: 'Four…', at: 2.24, len: 1.44 },
      { kind: 'taunt', text: 'Seven…', at: 3.8, len: 1.099 },
      { kind: 'taunt', text: 'Five?', at: 5.019, len: 1.667 },
      { kind: 'taunt', text: 'Nine…', at: 6.806, len: 1.009 },
      { kind: 'taunt', text: 'Uh… twelve…', at: 7.935, len: 2.154 },
      { kind: 'taunt', text: 'Six!', at: 10.209, len: 1.41 },
      { kind: 'taunt', text: 'Ten-ish…', at: 11.739, len: 1.414 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 13.273, len: 1.453 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 14.846, len: 1.703 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 16.669, len: 1.959 },
      { kind: 'taunt', text: 'Scared?', at: 18.747, len: 1.76 },
      { kind: 'death', text: '', at: 20.627, len: 1.9 },
      { kind: 'death', text: '', at: 22.647, len: 2.692 },
    ],
  },
  'Ace Q. McConly': {
    url: '/experiments/out-west/3d/voice/cardsharp.m4a',
    lines: [
      { kind: 'open', text: 'Heads, you die. Tails, you die.', at: 0, len: 3.611 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 3.731, len: 2.022 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 5.872, len: 2.335 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 8.327, len: 2.344 },
      { kind: 'taunt', text: 'Scared?', at: 10.791, len: 1.88 },
      { kind: 'death', text: '', at: 12.79, len: 0.666 },
      { kind: 'death', text: '', at: 13.577, len: 3.4 },
    ],
  },
  'Burney N. Coover': {
    url: '/experiments/out-west/3d/voice/drunk.m4a',
    lines: [
      { kind: 'open', text: '*hic*', at: 0, len: 1.555 },
      { kind: 'taunt', text: 'Which one of you’s real?', at: 1.675, len: 3.609 },
      { kind: 'taunt', text: 'Hold still, the both of ya.', at: 5.404, len: 3.608 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 9.131, len: 3.698 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 12.949, len: 3.577 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 16.646, len: 4.186 },
      { kind: 'taunt', text: 'Scared?', at: 20.953, len: 3.618 },
      { kind: 'death', text: '', at: 24.69, len: 3.4 },
      { kind: 'death', text: '', at: 28.21, len: 2.32 },
    ],
  },
  'Salvador R. Gruell': {
    url: '/experiments/out-west/3d/voice/impatient.m4a',
    lines: [
      { kind: 'open', text: 'Vámonos, already.', at: 0, len: 1.445 },
      { kind: 'taunt', text: 'I got a lunch to get to.', at: 1.565, len: 2.067 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 3.752, len: 1.917 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 5.789, len: 1.438 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 7.348, len: 1.831 },
      { kind: 'taunt', text: 'Scared?', at: 9.299, len: 0.632 },
      { kind: 'death', text: '', at: 10.051, len: 2.436 },
      { kind: 'death', text: '', at: 12.607, len: 3.09 },
    ],
  },
  'Felipe K. Wheeler': {
    url: '/experiments/out-west/3d/voice/longwalker.m4a',
    lines: [
      { kind: 'open', text: 'Keep walkin’, friend.', at: 0, len: 2.457 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 2.577, len: 3.044 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 5.741, len: 2.355 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 8.216, len: 2.485 },
      { kind: 'taunt', text: 'Scared?', at: 10.821, len: 3.619 },
      { kind: 'death', text: '', at: 14.56, len: 3.4 },
      { kind: 'death', text: '', at: 18.08, len: 2.851 },
    ],
  },
  'Laura Bullion': {
    url: '/experiments/out-west/3d/voice/thornyrose.m4a',
    lines: [
      { kind: 'open', text: '…', at: 0, len: 1.227 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 1.347, len: 1.324 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 2.791, len: 1.6 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 4.511, len: 1.68 },
      { kind: 'taunt', text: 'Scared?', at: 6.311, len: 1.182 },
      { kind: 'death', text: '', at: 7.612, len: 2.041 },
      { kind: 'death', text: '', at: 9.773, len: 2.335 },
    ],
  },
  'Thomas B. Arnold': {
    url: '/experiments/out-west/3d/voice/starer.m4a',
    lines: [
      { kind: 'open', text: 'I can see you sweatin’.', at: 0, len: 2.178 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 2.298, len: 2.608 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 5.026, len: 2.768 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 7.914, len: 3.062 },
      { kind: 'taunt', text: 'Scared?', at: 11.096, len: 1.115 },
      { kind: 'death', text: '', at: 12.331, len: 3.4 },
      { kind: 'death', text: '', at: 15.851, len: 3.4 },
    ],
  },
  'Delmer F. Gusselman': {
    url: '/experiments/out-west/3d/voice/twogun.m4a',
    lines: [
      { kind: 'open', text: 'Two’s better than one.', at: 0, len: 2.162 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 2.282, len: 1.946 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 4.347, len: 2.271 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 6.738, len: 2.864 },
      { kind: 'taunt', text: 'Scared?', at: 9.722, len: 0.903 },
      { kind: 'death', text: '', at: 10.745, len: 3.4 },
      { kind: 'death', text: '', at: 14.265, len: 3.209 },
    ],
  },
  'Pearl Hart': {
    url: '/experiments/out-west/3d/voice/stagerobber.m4a',
    lines: [
      { kind: 'open', text: 'The boys are watching.', at: 0, len: 2.05 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 2.17, len: 2.609 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 4.9, len: 2.201 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 7.221, len: 2.541 },
      { kind: 'taunt', text: 'Scared?', at: 9.882, len: 1.581 },
      { kind: 'death', text: '', at: 11.583, len: 1.952 },
      { kind: 'death', text: '', at: 13.655, len: 2.145 },
    ],
  },
  'Luke Short': {
    url: '/experiments/out-west/3d/voice/gambler.m4a',
    lines: [
      { kind: 'open', text: 'Deal me in.', at: 0, len: 1.378 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 1.498, len: 2.201 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 3.819, len: 2 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 5.939, len: 2.302 },
      { kind: 'taunt', text: 'Scared?', at: 8.361, len: 0.733 },
      { kind: 'death', text: '', at: 9.214, len: 1.22 },
      { kind: 'death', text: '', at: 10.554, len: 2.984 },
    ],
  },
  'Dallas Stoudenmire': {
    url: '/experiments/out-west/3d/voice/marshal.m4a',
    lines: [
      { kind: 'open', text: 'Lights out.', at: 0, len: 1.21 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 1.33, len: 2.491 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 3.941, len: 2.495 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 6.556, len: 3.364 },
      { kind: 'taunt', text: 'Scared?', at: 10.04, len: 1.413 },
      { kind: 'death', text: '', at: 11.573, len: 3.367 },
      { kind: 'death', text: '', at: 15.06, len: 2.128 },
    ],
  },
  'Harvey “Kid Curry” Logan': {
    url: '/experiments/out-west/3d/voice/fakeking.m4a',
    lines: [
      { kind: 'open', text: 'Flinch.', at: 0, len: 1.591 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 1.711, len: 2.59 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 4.421, len: 2.341 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 6.882, len: 2.94 },
      { kind: 'taunt', text: 'Scared?', at: 9.942, len: 1.314 },
      { kind: 'death', text: '', at: 11.376, len: 3.4 },
      { kind: 'death', text: '', at: 14.896, len: 3.14 },
    ],
  },
  'James “Wild Bill” Hickok': {
    url: '/experiments/out-west/3d/voice/deadmanshand.m4a',
    lines: [
      { kind: 'open', text: 'Aces and eights.', at: 0, len: 1.335 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 1.455, len: 1.813 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 3.388, len: 2.385 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 5.893, len: 2.299 },
      { kind: 'taunt', text: 'Scared?', at: 8.312, len: 0.787 },
      { kind: 'death', text: '', at: 9.219, len: 3.4 },
      { kind: 'death', text: '', at: 12.739, len: 2.76 },
    ],
  },
  'William “Curly Bill” Brocius': {
    url: '/experiments/out-west/3d/voice/underboss.m4a',
    lines: [
      { kind: 'open', text: 'Look up, friend.', at: 0, len: 1.913 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 2.033, len: 2.333 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 4.486, len: 2.557 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 7.163, len: 2.701 },
      { kind: 'taunt', text: 'Scared?', at: 9.984, len: 2.594 },
      { kind: 'death', text: '', at: 12.698, len: 3.217 },
      { kind: 'death', text: '', at: 16.035, len: 3.115 },
    ],
  },
  'John Wesley Hardin': {
    url: '/experiments/out-west/3d/voice/boss.m4a',
    lines: [
      { kind: 'taunt', text: '…TWELVE!', at: 0, len: 1.077 },
      { kind: 'taunt', text: 'That… that’s just a scratch.', at: 1.197, len: 2.645 },
      { kind: 'taunt', text: 'You plannin’ on walkin’ today?', at: 3.961, len: 2.288 },
      { kind: 'taunt', text: 'I ain’t got all day, friend.', at: 6.369, len: 2.797 },
      { kind: 'taunt', text: 'My grandma walks faster.', at: 9.287, len: 2.5 },
      { kind: 'taunt', text: 'Scared?', at: 11.907, len: 1.265 },
      { kind: 'death', text: '', at: 13.292, len: 3.4 },
      { kind: 'death', text: '', at: 16.812, len: 3.4 },
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
      { kind: 'flinch', text: '', at: 3.833, len: 1.262 },
    ],
    win: [
      { kind: 'win', text: '', at: 5.215, len: 2.201 },
      { kind: 'win', text: '', at: 7.536, len: 1.678 },
    ],
    death: [
      { kind: 'death', text: '', at: 9.334, len: 2.255 },
      { kind: 'death', text: '', at: 11.709, len: 2.989 },
      { kind: 'death', text: '', at: 14.818, len: 3.185 },
    ],
  },
}
