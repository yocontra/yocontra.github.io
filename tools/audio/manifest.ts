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
  kind: 'sfx' | 'music'
  seconds: number
  prompt: string
  /** ElevenLabs seamless-loop mode (SFX only). */
  loop?: boolean
}

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
]
