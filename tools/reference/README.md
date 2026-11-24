# Out West reference captures

Start the baseline and candidate from their own local Astro dev servers. Give each server the same tier, viewport, and simulation settings. Keep evidence outside the public game directory. Each run writes to a new directory.

```sh
bun tools/reference/record-out-west.ts http://localhost:4321 /tmp/ow-baseline-noon low noon 812x375
bun tools/reference/record-out-west.ts http://localhost:4322 /tmp/ow-candidate-noon low noon 812x375
```

Set `OW_CAPTURE_TOUCH=1` for a phone capture with touch controls. Use `OW_BROWSER_WS` for a Playwright browser server. For a software GPU, `OW_CAPTURE_TICKS_PER_FRAME=16` renders a frame every 16 simulation ticks while input and physics continue to run. Check the video frame count with `ffprobe` before judging motion from these recordings. Use native rendering (the default) for motion acceptance.

| Sequence                            | Capture                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| Title to Saloon                     | `campaign` title crane and Saloon rider                                                 |
| Outfitter try-on                    | `campaign` selected item and quarter turn                                               |
| Frontier street                     | `noon` street approach                                                                  |
| Saloon interior                     | `noon` and `dusk` threshold, bar, and stairs                                            |
| Roof to desert                      | `roof` saloon roof walk, alley, and cactus flats                                        |
| Night                               | `night` saloon route at the midnight preset                                             |
| First-person actions                | `noon` and `dusk` indoor shot and reload, then third-person shot outside                |
| Frontier round end and return       | `round` practice clock, summary, and return to Saloon                                   |
| Quick Draw opening                  | `campaign` first outlaw introduction and standoff                                       |
| Quick Draw arena changes and finale | `campaign` street, depot, mission, bank, and final boss                                 |
| Daily Outlaw                        | `campaign` fixed fogged Daily, then return to Saloon                                    |
| Two-client Bounty Hunt              | `tools/test-playcanvas-duel-pvp.ts` with two browsers and the local matchmaking fixture |

Use `bar` for a single 812×375 still at the reference bar camera and light preset 0.3.

Frontier uses seed 7 and zero bots. Each saloon route records the game canvas and the final game mix. The JSON records the waypoints, rider pose, ammunition, reloads, shots, and loaded assets. Add `pilotOffset` to each waypoint's `seconds` to find it in the WebM. To make a 90-second review cut, run `python3 tools/reference/review-cut.py EVIDENCE_DIR` with FFmpeg installed. The cut keeps the original audio and action speeds and records the seven edit points. Use the original WebM for uninterrupted playback. The roof walk uses a fixed start pose on the elevated saloon deck. Round captures advance the practice clock to its final tick, then use the actual summary and Leave town button. The night run also captures this return before closing. Campaign uses fixed director phases and an offline Daily presentation fixture. Arena, boss, and Daily captures are stills.

Run Bounty Hunt with the repository's local test API, which supplies the two test accounts. The existing harness writes both players' result screens and verifies the shared match and result.

```sh
OW_ORIGIN=http://localhost:4321 OW_API=http://localhost:8792 OW_EVIDENCE=/tmp/ow-pvp-baseline bun tools/test-playcanvas-duel-pvp.ts
```
