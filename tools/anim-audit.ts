/**
 * The animation audit (docs/animation-matrix.md): drives every character state it can reach, in
 * the PRODUCTION build with the harness hooks kept (`PUBLIC_OW_PERF_HARNESS=1`, never set for the
 * deploy), captures frame sequences from the state's camera and checks each one programmatically:
 *
 * - a clip or a procedural layer is active (scene/anim-probe.ts reads both off the actor);
 * - the bones move: the key bones' pose is off the bind pose (no T-pose), off his idle where the
 *   state should change it, and moving between frames where it should move;
 * - `__owTPose` (scene/pose-watch.ts) stays 0.
 *
 *   bun tools/anim-audit.ts [--no-build] [--port=4403] [--base=http://localhost:4402]
 *     [--only=substr] [--skip=duel,live,frontier] [--out=.playwright-mcp/anim-audit]
 *
 * `--base` audits a running site (a dev server) instead of building and serving prod on `--port`.
 * Sections: `duel` (the #lineup stage, duel/anim-stage.ts: every duel, hub and Outfitter beat on
 * one man, frame-stepped), `live` (a Quick Draw duel against the talker, played: the walk, the
 * wait, the call, the kill cam, the townsfolk), `frontier` (third person, first person: the local
 * rider, the remote riders, the view model, over the touch controls). Each state writes its
 * frames and a contact sheet (`sheet.png`) under `--out`, and `report.json` sums it up.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'
import { duelStage, liveDuel } from './anim/duel.ts'
import { frontier } from './anim/frontier.ts'
import { baseArg, OUT, port, rows, serveProd, skip } from './anim/lib.ts'

const stop = baseArg ? null : serveProd(!process.argv.includes('--no-build'))
const base = baseArg || `http://localhost:${port}`
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-angle=metal', '--ignore-gpu-blocklist'],
})
try {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, hasTouch: true })
  if (!skip.has('duel')) {
    await duelStage(ctx, base)
  }
  if (!skip.has('live')) {
    await liveDuel(ctx, base)
  }
  if (!skip.has('frontier')) {
    await frontier(ctx, base)
  }
  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, 'report.json'), JSON.stringify(rows, null, 2))
  const ok = rows.filter((r) => r.ok).length
  console.log(`\n${ok}/${rows.length} states pass; report: ${join(OUT, 'report.json')}`)
} finally {
  await browser.close()
  stop?.()
}
