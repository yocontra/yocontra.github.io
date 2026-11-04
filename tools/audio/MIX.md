# Out West mix spec

These are the levels every out west sound is held to. Check them with the in-browser meters
(`#audiodebug`) after any change to a sound, a bus or a duck:

- `verify-duel.ts`: the call and the round.
- `verify-mix.ts`: each screen, the walk and standoff, voice over music, and phone translation.
- `verify-frontier.ts`: Frontier.
- `cast-audit.ts`: the voices.

## Priority

**bell > shots > voice > music > ambience.** Anything lower in the list steps aside for anything
higher.

- **Bell (`call` bus).** It ignores every slider, is never positional and never ducked. At the call,
  music ducks to ×0.18 (×0.06 for the duel cues, ×0.05 for tension), ambience to ×0.25 and voice to
  ×0.25. The duck holds 0.7 s.
- **Shots.** These are SFX at full level. Only the master limiter sits above them.
- **Voice.** The score ducks −6 dB under every outlaw line (`VOICE_DUCK`): 50 ms attack, 250 ms
  release.
- **Music.** Ducks by moment (below).
- **Ambience.** Follows the SFX slider and ducks under the call.

## Delivery loudness (files)

| Kind                      | Target                                                        | Peak                           | Format                 |
| ------------------------- | ------------------------------------------------------------- | ------------------------------ | ---------------------- |
| Music loops and themes    | −18 LUFS integrated                                           | ≤ −1 dBTP                      | AAC 96–128 kbps stereo |
| Stings                    | −18 LUFS                                                      | ≤ −1 dBTP                      | AAC 128 kbps           |
| Voice files (per speaker) | −16 LUFS                                                      | ≤ −1 dBTP                      | AAC 48 kbps mono       |
| Lines inside a voice file | open/taunt −16, death −17, draw −20, flinch −21, win −22 LUFS | each line limited to −1.5 dBFS |                        |
| SFX                       | per `recipes.ts`                                              | ≤ −1 dBTP                      |                        |

## Voice chain

Every fresh take gets the same processing, so the cast sounds like one mic in one street.

**Offline (`build-voices.ts`):**

1. High-pass at 85 Hz.
2. −2.5 dB at 250 Hz (mud).
3. +2.5 dB at 3.5 kHz (presence that survives a phone speaker).
4. De-ess.
5. Compressor: 3:1 at −24 dB, 5 ms attack, 120 ms release.
6. Trim to the sound, close internal pauses to 0.3 s, and time-fit (pitch kept, at most ×1.3):
   - the talker and the counter: ≤ 2.6 s (the next line can come 2.7 s later);
   - other lines: ≤ 3.6 s;
   - deaths: ≤ 3.4 s (longer ones fade out).
7. Level to the kind's target and limit at −1.5 dBFS.

**Live (`AudioEngine.buildVoiceRoom`):** each line sends to two returns on the voice bus, so the
voice slider owns them.

- A street slap: 95 ms, band 350 Hz–3.2 kHz, −15 dB.
- A short dark room: 0.6 s, lowpass 4.5 kHz, −17 dB.
- Send levels: outlaws 1.0, the player's own breath 0.35.
- Outlaws pan 0.12 off centre.

## Moments

Values are RMS on the meter taps in dBFS, sliders at 1, measured by `verify-mix.ts`. Hold each
screen's output within ±3 dB of the hub.

| Moment                              | Music                                                                        | Output                    | Notes                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Title                               | intro build −25, body ≈ −15                                                  | −28 rising to −18         | The 2019 theme opens with a 50 s build; left as is on the title.                                                      |
| Hub (saloon, saloon B)              | −15                                                                          | −19                       | The two tunes alternate by visit (`SONG_TURNS`).                                                                      |
| Outfitter, poster, Gazette, results | hub song at 0 dB                                                             | −19                       | UI cues sit over it; the poster restores 0 dB.                                                                        |
| Act theme at rest (stage)           | −13 to −15                                                                   | −17 to −19                | Day, dusk, night and the hot variants.                                                                                |
| Walk                                | duel cue −6 dB, 9 kHz lowpass → ≈ −20                                        | ≈ −23                     | `FEEL.walkDuckDb`/`walkLowpass`, `musicSection('duel')`.                                                              |
| Walk with an outlaw line            | music ≈ −25 under the line                                                   | ≈ −19                     | Voice stands ≥ 6 dB over music.                                                                                       |
| Standoff (turn, wait)               | duel cue −14 dB, 3 kHz lowpass → ≈ −27 to −32                                | ≈ −30                     | `FEEL.waitDuckDb`/`waitLowpass`; tension −18 dB.                                                                      |
| Call                                | ducked under the bell                                                        | bell ≈ −11 on the SFX tap | **The bell clears music by ≥ 24 dB** (measured 24–32 dB, median 27) and ambience by ≥ 45 dB. Bell peak about −4 dBFS. |
| Shot / kill cam                     | music −∞ on defeat; theme back at 0 dB 0.4 s after the kill                  | shot peak ≈ −1.5 dBFS     | The duel cue crossfades back to the act theme over 1.2 s.                                                             |
| Stings (victory, defeat)            | −17 to −14                                                                   | −18 to −21                | They play past the song's duck; the song dips 14 dB under them.                                                       |
| Boss duel                           | the theme enters at its loop start (`SONG_ENTRY`) and thins to the night cue | as the acts               | Its lead-in measured −34 LUFS; it also has bells and a choir, so the night cue sits under the clock.                  |
| Frontier                            | −17                                                                          | −20                       | Gunfire and footsteps are positional SFX; the bank and pickups are UI/SFX.                                            |

## Duel music

On the walk the act theme crossfades (1.2 s) to its **duel cue**: a sparse Lyria piece in the act's
key (A minor) and tempo, with no percussion (the heartbeat owns the pulse) and nothing bell-like.

- Day: fingerstyle guitar.
- Dusk: two acoustic guitars.
- Night: cello drone. The boss uses it too.

The cue ducks further for the standoff. Music back at ≥ −1 dB (after the kill, or on a new stage)
returns the full theme, resuming where it left off.

The cue holds a level; it never builds to a peak. A crescendo would time the call, and the call's
timing must never be audible.

## Phone speakers

`verify-mix.ts --offline` models a phone speaker: nothing below 300 Hz, rolled off above 8 kHz.

- **Voices** lose 1–4 dB.
- **Hub, title, stings and Frontier** lose 1–3 dB.
- **Act themes and the day and night cues** lose 6–9 dB: acoustic guitar and cello body sit at
  100–300 Hz. On a phone the duel music therefore sits about 5 dB further under the voice, the
  paces and the bell. That helps the duel, so it is accepted, not corrected.
- **Voice versus music:** voice gains about 4 dB over music on a phone, so lines stay intelligible
  with the low end gone.

## Sliders

The music, SFX and voice sliders scale their bus with a squared taper (0.5 ≈ −12 dB).

- Ambience follows SFX.
- The voice room returns sit on the voice bus, so they follow the voice slider.
- The bell answers to no slider.
