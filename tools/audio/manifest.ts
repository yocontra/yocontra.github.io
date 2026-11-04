/**
 * Every ElevenLabs generation behind the out west 3D soundtrack (design doc §10.5 step 7: "log
 * every generation in the asset manifest"). `generate.ts` runs these through the Apparish
 * generators. `build.ts` turns the raw takes into the shipped `.m4a` files.
 *
 * The score has one musical identity: A minor, the key of the 2019 title and boss themes that it
 * remasters, with a nylon-string guitar, a twangy baritone guitar, low drones, timpani and a
 * trumpet. Cues generated in other keys are pitched into A in `build.ts`. Every
 * cue stays out of the call bell's register (its partials sit at about 230–1800 Hz with a 1.2 kHz
 * centroid) where it matters: the standoff bed is low drones only, so the bell always cuts through.
 * Nothing in the catalog uses a bell or chime timbre (spec §7: no cosmetic or cue may sound like
 * the call).
 */

export interface Gen {
  /** Raw take id; the file is `raw/<id>.mp3`. */
  id: string
  /** `lyria`: Google Lyria 2 on Vertex AI (about 30 s of instrumental music; `seconds` is ignored). */
  kind: 'sfx' | 'music' | 'lyria'
  seconds: number
  prompt: string
  /** ElevenLabs seamless-loop mode (SFX only). */
  loop?: boolean
  /** Lyria: what to keep out. */
  negative?: string
  /** Lyria: fixed seed, so a take can be regenerated. */
  seed?: number
}

/** Lyria: never a bell, a chime or a voice (spec §7: nothing may sound like the call). */
const LYRIA_NO =
  'vocals, singing, choir, bells, chimes, church bell, glockenspiel, celesta, music box, synthesizer, electronic, modern drum kit'

const NO_BELL = 'no bells, no chimes'

export const GENS: readonly Gen[] = [
  // ---------------------------------------------------------------- revolver
  {
    id: 'rev_close',
    kind: 'sfx',
    seconds: 1.5,
    prompt:
      'Single close-up gunshot from a .45 Colt single action revolver, sharp supersonic crack with a heavy low-end punch, dry, no echo, recorded close, cinematic and powerful',
  },
  {
    id: 'rev_town',
    kind: 'sfx',
    seconds: 4,
    prompt:
      'Single revolver gunshot in an empty western frontier town street, loud crack followed by a long slapback echo bouncing off wooden storefronts, rolling decaying rumble into silence',
  },
  {
    id: 'rev_cock',
    kind: 'sfx',
    seconds: 1.2,
    prompt:
      'Single action revolver hammer cocked back, cylinder ratchet turning and a crisp mechanical double click, close up, quiet room, dry',
  },
  {
    id: 'rev_hammer',
    kind: 'sfx',
    seconds: 0.6,
    prompt:
      'Revolver hammer falling on an empty chamber, single crisp metal dry-fire click, close up, dry',
  },
  {
    id: 'holster',
    kind: 'sfx',
    seconds: 0.8,
    prompt:
      'Fast revolver quick-draw from a stiff leather holster, short leather scrape and metal slide, close up, dry',
  },
  {
    id: 'whip',
    kind: 'sfx',
    seconds: 1,
    prompt:
      'Fast cinematic whoosh swish, a quick air whip-pan transition, short and clean, no impact',
  },
  // ---------------------------------------------------- frontier long guns
  {
    id: 'rifle_fire',
    kind: 'sfx',
    seconds: 3,
    prompt:
      'Winchester lever-action rifle gunshot outdoors in a western town, sharp powerful high-velocity crack with deep body, echo off wooden buildings',
  },
  {
    id: 'rifle_reload',
    kind: 'sfx',
    seconds: 1.2,
    prompt:
      'Winchester lever-action rifle lever worked once, metallic clack-clack cycling a cartridge, close up, dry',
  },
  {
    id: 'shotgun_fire',
    kind: 'sfx',
    seconds: 3,
    prompt:
      'Double-barrel coach shotgun blast outdoors in a western town, huge deep booming blast with pellet spray, echo off wooden buildings',
  },
  {
    id: 'shotgun_reload',
    kind: 'sfx',
    seconds: 1.8,
    prompt:
      'Double-barrel shotgun broken open, two spent shells ejected, two fresh shells slid in and the breech snapped shut, close up, dry',
  },
  // ---------------------------------------------------------------- dynamite
  {
    id: 'fuse',
    kind: 'sfx',
    seconds: 3,
    loop: true,
    prompt: 'Burning dynamite fuse, continuous sizzling hiss with small spark crackles, close up',
  },
  {
    id: 'explosion2',
    kind: 'sfx',
    seconds: 4,
    prompt:
      'Cinematic clean dynamite blast outdoors, deep sub boom with a sharp crack, wooden debris and gravel falling, long rolling echo across a desert valley, not distorted',
  },
  {
    id: 'explosion',
    kind: 'sfx',
    seconds: 4,
    prompt:
      'Dynamite explosion in a western town, deep booming blast, wooden debris and dirt raining down, rolling echo fading out',
  },
  // ---------------------------------------------------------------- impacts
  {
    id: 'hit_body',
    kind: 'sfx',
    seconds: 0.8,
    prompt: 'Bullet impact into a body through heavy cloth, short dull punchy thud, close, dry',
  },
  {
    id: 'hit_wood',
    kind: 'sfx',
    seconds: 0.8,
    prompt:
      'Bullet hitting a wooden wall, sharp splintering crack with flying wood chips, close, dry',
  },
  {
    id: 'hit_dirt',
    kind: 'sfx',
    seconds: 0.8,
    prompt:
      'Bullet striking dry dirt ground, short thud with a puff of sand and pebbles scattering, close',
  },
  {
    id: 'ricochet',
    kind: 'sfx',
    seconds: 2,
    prompt:
      'Two separate bullet ricochets off rock and metal, sharp impact then a high whining zing flying away, outdoors',
  },
  // -------------------------------------------------------------- footsteps
  {
    id: 'steps_dirt',
    kind: 'sfx',
    seconds: 7,
    prompt:
      'Heavy leather cowboy boots walking slowly on dry packed dirt and gravel, eight distinct separate footsteps evenly spaced, no spurs, close, outdoors, no music',
  },
  {
    id: 'steps_wood',
    kind: 'sfx',
    seconds: 7,
    prompt:
      'Heavy leather cowboy boots walking slowly on a hollow wooden boardwalk, eight distinct separate footsteps evenly spaced with creaks, close, no music',
  },
  {
    id: 'spurs',
    kind: 'sfx',
    seconds: 7,
    prompt:
      'Cowboy spurs jingling with each slow step, metal rowels ringing and rattling, eight distinct separate jingles evenly spaced, close, no music',
  },
  // --------------------------------------------------------------- ambience
  {
    id: 'wind_day',
    kind: 'sfx',
    seconds: 20,
    loop: true,
    prompt:
      'Gentle warm desert breeze over a quiet western town at midday, soft steady wind through dry grass and dust, airy, no birds, no voices, no music',
  },
  {
    id: 'wind_dusk',
    kind: 'sfx',
    seconds: 20,
    loop: true,
    prompt:
      'Gusty evening wind sweeping dust through an empty western street, slow rising and falling gusts, faint rattle of loose wooden shutters, no voices, no music',
  },
  {
    id: 'wind_night',
    kind: 'sfx',
    seconds: 20,
    loop: true,
    prompt:
      'Cold low night wind moaning softly across an empty desert, sparse and eerie, distant hollow whistle, no insects, no voices, no music',
  },
  {
    id: 'crickets',
    kind: 'sfx',
    seconds: 16,
    loop: true,
    prompt:
      'Desert night crickets chirping, steady calm chorus of field crickets in dry grass, medium distance, no wind, no birds, no music',
  },
  {
    id: 'saloon',
    kind: 'sfx',
    seconds: 20,
    loop: true,
    prompt:
      'Busy old west saloon interior heard from the street outside, indistinct murmur of men talking, glasses clinking, chairs scraping, occasional laughter, no music',
  },
  {
    id: 'crow',
    kind: 'sfx',
    seconds: 2.5,
    prompt: 'Two harsh crow caws from a rooftop, outdoors, slight distance, natural',
  },
  {
    id: 'dog',
    kind: 'sfx',
    seconds: 3,
    prompt: 'A dog barking a few times far away across a desert town at night, distant with echo',
  },
  {
    id: 'heart',
    kind: 'sfx',
    seconds: 1,
    prompt:
      'One single deep heartbeat, a low soft sub-bass thump, close, dry, cinematic, nothing else',
  },
  // ------------------------------------------------------------------- money
  {
    id: 'coins',
    kind: 'sfx',
    seconds: 1.2,
    prompt:
      'A handful of heavy gold coins dropped into a leather pouch, rich metallic clinking jingle, close',
  },
  {
    id: 'register',
    kind: 'sfx',
    seconds: 1.8,
    prompt: `Antique brass cash register: keys pressed, crank turned and the cash drawer sliding open with a mechanical clunk and a rattle of coins, ${NO_BELL}, no ding`,
  },
  {
    id: 'deposit',
    kind: 'sfx',
    seconds: 2.5,
    prompt:
      'Heavy sack of coins dumped onto a wooden bank counter, coins pouring and settling, then a heavy iron vault door shutting with a deep clunk',
  },
  // ---------------------------------------------------------------------- UI
  {
    id: 'ui_paper',
    kind: 'sfx',
    seconds: 0.7,
    prompt:
      'Sheet of thick old paper slid quickly across a wooden table, soft short swish, close, dry',
  },
  {
    id: 'ui_stamp',
    kind: 'sfx',
    seconds: 0.7,
    prompt:
      'Heavy wooden rubber stamp slammed onto paper on a wooden desk, one solid punchy thump, close, dry',
  },
  {
    id: 'ui_tick',
    kind: 'sfx',
    seconds: 0.5,
    prompt:
      'One tiny soft wooden click, like a small wooden button pressed, very short, dry, close',
  },
  {
    id: 'ui_buy',
    kind: 'sfx',
    seconds: 1.2,
    prompt: `Coins counted onto a wooden counter then a leather purse pulled shut, satisfying purchase, close, ${NO_BELL}`,
  },
  {
    id: 'queue_found',
    kind: 'sfx',
    seconds: 2,
    prompt: `Short dramatic western sting: one hard strummed nylon guitar minor chord with a deep tom drum hit and reverb, ${NO_BELL}`,
  },
  {
    id: 'ghost',
    kind: 'sfx',
    seconds: 2.5,
    prompt:
      'Eerie ghostly apparition: a reversed reverb swell rising into a hollow spectral breath, cold airy wind, supernatural, no voice',
  },
  {
    id: 'ghost_vanish',
    kind: 'sfx',
    seconds: 2,
    prompt:
      'A ghost dissolving into the wind, airy shimmering whoosh fading away into dust, supernatural, soft, no voice, no bells',
  },
  {
    id: 'respawn',
    kind: 'sfx',
    seconds: 1.8,
    prompt:
      'Western game respawn: a rising whoosh of desert wind and dust ending in one low tom drum hit and a spur jingle, no music',
  },
  // ------------------------------------------------------------------- music
  // The ElevenLabs Music API needs a paid plan (402 paid_plan_required on this account), so the
  // score is built from SFX-endpoint musical loops and stings (≤ 22 s, seamless with --loop) plus
  // the remastered 2019 title and boss themes.
  {
    id: 's_tension',
    kind: 'sfx',
    seconds: 22,
    loop: true,
    prompt:
      'Western standoff suspense music loop in D minor: a very low sustained cello and double bass drone with a slow quiet tremolo baritone guitar on low notes, ominous and minimal, lots of space, no drums, no melody, no high instruments, no bells',
  },
  {
    id: 's_frontier',
    kind: 'sfx',
    seconds: 22,
    loop: true,
    prompt:
      'Western gunfight action music loop in D minor at 120 bpm: galloping rhythm, driving strummed acoustic guitar, stomping low tom drums, twangy baritone electric guitar riff, gritty and energetic, no vocals, no bells',
  },
  {
    id: 's_frontier2',
    kind: 'sfx',
    seconds: 22,
    loop: true,
    prompt:
      'Spaghetti western action music loop in A minor: fast galloping strummed acoustic guitar, a twangy reverb electric guitar melody, harmonica, cowboy drum beat with low toms and shaker, cinematic, stereo, no vocals, no bells',
  },
  {
    id: 's_victory',
    kind: 'sfx',
    seconds: 6,
    prompt:
      'Short western victory music sting in D major: a triumphant trumpet phrase over strummed nylon guitar and a timpani roll, ending on one held major chord, no vocals, no bells',
  },
  {
    id: 's_defeat',
    kind: 'sfx',
    seconds: 6,
    prompt:
      'Short western defeat music sting in A minor: a slow mournful solo trumpet phrase over a low tremolo guitar, ending on a dark held A minor chord, no vocals, no bells',
  },
  {
    id: 's_levelup',
    kind: 'sfx',
    seconds: 3,
    prompt:
      'Very short western level-up music flourish in A major: a fast rising strummed nylon guitar run into a bright trumpet hit, no vocals, no bells',
  },
  {
    id: 's_piano',
    kind: 'sfx',
    seconds: 22,
    loop: true,
    prompt:
      'Honky-tonk upright saloon piano music loop in A minor, lively ragtime, slightly out of tune, old west saloon, solo piano only, no vocals',
  },
  // -------------------------------------------------------- music, round two (Lyria 2)
  // The ElevenLabs Music API stays paid-only, so the hub bed, the three act themes and the streak
  // stings come from Google's Lyria 2 (Vertex AI, on the cloud credit): 30 s instrumental takes,
  // looped in `recipes.ts`.
  {
    id: 'l_saloon',
    kind: 'lyria',
    seconds: 30,
    seed: 1881,
    prompt:
      'Honky-tonk upright saloon piano, lively ragtime stride, slightly out of tune, old west saloon, solo piano with a walking left hand, warm and cheerful, steady tempo, instrumental',
    negative: LYRIA_NO,
  },
  {
    id: 'l_day',
    kind: 'lyria',
    seconds: 30,
    seed: 1877,
    prompt:
      'Spaghetti western theme at high noon in A minor: brisk strummed nylon-string guitar, a lonely harmonica melody, a twangy baritone guitar answering, light shaker and low tom heartbeat, sun-bleached and tense but adventurous, cinematic, instrumental',
    negative: LYRIA_NO,
  },
  {
    id: 'l_dusk',
    kind: 'lyria',
    seconds: 30,
    seed: 1879,
    prompt:
      'Spaghetti western theme at sunset in A minor: slow twangy reverb electric guitar melody, a mournful muted trumpet, warm low strings swelling, gentle strummed acoustic guitar, golden, brooding and wide, cinematic, instrumental',
    negative: LYRIA_NO,
  },
  {
    id: 'l_night',
    kind: 'lyria',
    seconds: 30,
    seed: 1883,
    prompt:
      'Dark night western theme in A minor: low tremolo baritone guitar, a sparse plucked double bass, a distant lonely harmonica, eerie sustained low strings, slow and ominous, moonlit desert, cinematic, instrumental',
    negative: LYRIA_NO,
  },
  {
    id: 's_victory_big',
    kind: 'sfx',
    seconds: 5,
    prompt:
      'Short triumphant spaghetti western victory fanfare in A major: a heroic soaring trumpet call over fast strummed guitar and a booming timpani roll, ending on one big held major chord, no vocals, no bells',
  },
  {
    id: 's_victory_lucky',
    kind: 'sfx',
    seconds: 5,
    prompt:
      'Short wry western music sting: a plucky comic twangy guitar phrase and a slightly wobbly harmonica, relieved and cheeky, ending on a quick major chord stab, no vocals, no bells',
  },
  // Second-round prompts: Lyria writes a whole piece with an intro and a fade, so these ask for a
  // groove that never ends (the recipe still loops only the steady middle).
  {
    id: 'l_saloon_b',
    kind: 'lyria',
    seconds: 30,
    seed: 2101,
    prompt:
      'Honky-tonk upright saloon piano, lively ragtime stride in A minor, slightly out of tune, old west saloon, solo piano, 110 bpm, one continuous steady groove from start to finish, no intro, no ending',
    negative: `${LYRIA_NO}, drums, modern, fade out`,
  },
  {
    id: 'l_day_b',
    kind: 'lyria',
    seconds: 30,
    seed: 2103,
    prompt:
      'Spaghetti western high noon theme in A minor, 110 bpm: galloping strummed nylon-string guitar, a lonely harmonica melody, twangy baritone guitar riff, low tom pulse, sun-bleached, tense and adventurous, cinematic, one continuous steady groove from start to finish, no intro, no ending',
    negative: `${LYRIA_NO}, fade out`,
  },
  {
    id: 'l_dusk_b',
    kind: 'lyria',
    seconds: 30,
    seed: 2105,
    prompt:
      'Spaghetti western sunset theme in A minor, 80 bpm: slow twangy reverb electric guitar melody, mournful trumpet, warm low strings, gently strummed acoustic guitar, golden, brooding and wide, one continuous steady piece from start to finish, no intro, no ending',
    negative: `${LYRIA_NO}, piano, jazz, fade out`,
  },
  {
    id: 'l_night_b',
    kind: 'lyria',
    seconds: 30,
    seed: 2107,
    prompt:
      'Dark night western theme in A minor, 70 bpm: low tremolo baritone guitar, sparse plucked double bass, distant lonely harmonica, eerie sustained low strings, slow and ominous, moonlit desert, one continuous steady piece from start to finish, no intro, no ending',
    negative: `${LYRIA_NO}, piano, jazz, fade out`,
  },
  // The duel cues (audio director pass, Nov 2026): the act theme thins to one of these for the
  // walk and the standoff, in the act's key and tempo, so the score never stops but steps back to a
  // sparse Morricone texture: no percussion (the heartbeat owns the pulse) and nothing bell-like.
  {
    id: 'l_duel_day',
    kind: 'lyria',
    seconds: 30,
    seed: 3101,
    prompt:
      'Spaghetti western duel standoff underscore in A minor, 110 bpm, very sparse: a quiet low tremolo baritone guitar holding the A minor chord, a soft sustained low string drone, a lonely distant harmonica phrase now and then, lots of space, tense and suspended, slowly simmering at one steady level, one continuous piece from start to finish, no intro, no ending',
    negative: `${LYRIA_NO}, drums, percussion, toms, piano, fade out, crescendo, climax`,
  },
  {
    id: 'l_duel_dusk',
    kind: 'lyria',
    seconds: 30,
    seed: 3111,
    prompt:
      'Spaghetti western sunset duel underscore in A minor, 80 bpm, very sparse: a slow twangy reverb electric guitar note every bar, a soft sustained low string pad, a faint mournful distant trumpet line, lots of space, tense and brooding, holding at one steady level, one continuous piece from start to finish, no intro, no ending',
    negative: `${LYRIA_NO}, drums, percussion, toms, piano, fade out, crescendo, climax`,
  },
  {
    id: 'l_duel_night',
    kind: 'lyria',
    seconds: 30,
    seed: 3121,
    prompt:
      'Dark night western duel underscore in A minor, 70 bpm, very sparse: low tremolo baritone guitar, an eerie sustained low cello drone, a sparse plucked double bass note now and then, a faint distant lonely whistle, moonlit desert, ominous and still, holding at one steady level, one continuous piece from start to finish, no intro, no ending',
    negative: `${LYRIA_NO}, drums, percussion, toms, piano, fade out, crescendo, climax`,
  },
  // The hub is heard between every duel: two saloon tunes that take turns (a real band, not a
  // lone piano that reads as MIDI), and the two stings Gemini rated weakest, redone acoustic.
  {
    id: 'l_saloon_c',
    kind: 'lyria',
    seconds: 30,
    seed: 3201,
    prompt:
      'Old west saloon band playing a lively honky-tonk ragtime tune in A minor, 112 bpm: a slightly out-of-tune upright piano with a stride left hand, a fiddle playing the melody, a plunky banjo, an upright bass, brushed snare, warm wooden room, recorded live, one continuous steady groove from start to finish, no intro, no ending',
    negative: `${LYRIA_NO}, electric bass, synth, drum machine, fade out`,
  },
  {
    id: 'l_saloon_d',
    kind: 'lyria',
    seconds: 30,
    seed: 3211,
    prompt:
      'Dusty frontier saloon, a loping cowboy two-step in A minor, 104 bpm: honky-tonk upright piano, harmonica melody, strummed acoustic guitar, upright bass, washboard, relaxed and warm, recorded live in a wooden room, one continuous steady groove from start to finish, no intro, no ending',
    negative: `${LYRIA_NO}, electric bass, synth, drum machine, fade out`,
  },
  {
    id: 'l_victory',
    kind: 'lyria',
    seconds: 30,
    seed: 3221,
    prompt:
      'A short triumphant spaghetti western victory flourish in A major: a bold solo trumpet call over fast strummed acoustic guitar and a timpani roll, ending on a big sustained major chord, cinematic, instrumental',
    negative: `${LYRIA_NO}, drum kit, synth`,
  },
  {
    id: 'l_lucky_b',
    kind: 'lyria',
    seconds: 30,
    seed: 3231,
    prompt:
      'A short wry comic western sting: a twangy acoustic guitar lick, a cheeky bent harmonica answer and a jaw harp boing, then a final major chord, relieved and funny, played by real musicians, instrumental',
    negative: `${LYRIA_NO}, drum kit, synth`,
  },
  {
    id: 'l_lucky',
    kind: 'lyria',
    seconds: 30,
    seed: 2109,
    prompt:
      'A short wry comic western music sting: a plucky twangy guitar lick, a cheeky wobbly harmonica answer and a jaw harp twang, then a final major chord stab, relieved and funny, instrumental',
    negative: LYRIA_NO,
  },
]
