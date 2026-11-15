/** Reevaluate host coverage without modifying the original recording or its other gates. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type ForegroundSample, foregroundCoverage } from './content/foreground-coverage.ts'
import { frameTarget } from './content/frame-target.ts'
import type { frameTiming } from './content/frame-timing.ts'

const path = process.argv[2]
if (!path) {
  throw new Error('Supply an original Chrome recording receipt path')
}
const bytes = await readFile(path)
const original = JSON.parse(bytes.toString()) as {
  source: string
  browserPid?: number
  surface: string
  problems: string[]
  outstandingEvidence: string[]
  foreground: ForegroundSample[]
  recording: { samples: { wall: number }[] }
  timing: ReturnType<typeof frameTiming>
}
if (original.surface !== 'visible-chrome') {
  throw new Error('This review only corrects foreground coverage for visible Chrome recordings')
}
const coverage = foregroundCoverage(original.foreground, {
  start: original.recording.samples[0]?.wall ?? 0,
  end: original.recording.samples.at(-1)?.wall ?? 0,
  bundle: 'com.google.Chrome',
  pid: original.browserPid,
})
const oldProblem = 'Host foreground evidence incomplete or Chrome was not frontmost'
const problems = original.problems.filter((problem) => problem !== oldProblem)
if (!coverage.passed) {
  problems.push(oldProblem)
}
const qualified = problems.length === 0 && original.outstandingEvidence.length === 0
const target = frameTarget(original.timing, 'desktop')
let performanceTarget = 'unqualified'
if (qualified) {
  performanceTarget = target.passed ? 'pass' : 'fail'
}
const review = {
  reviewedAt: new Date().toISOString(),
  reviewSource: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
  originalReceipt: resolve(path),
  originalSha256: createHash('sha256').update(bytes).digest('hex'),
  originalRecordingSource: original.source,
  reason: 'Replace arbitrary host sample count with boundary coverage and maximum gap checks',
  foregroundCoverage: coverage,
  recordingClass: problems.length === 0 ? 'foreground-production-recording' : 'diagnostic',
  qualification: qualified ? 'complete' : 'incomplete',
  performanceTarget,
  target,
  problems,
  outstandingEvidence: original.outstandingEvidence,
}
const output = `${path}.foreground-review.json`
await writeFile(output, `${JSON.stringify(review, null, 2)}\n`)
console.log(JSON.stringify({ output, ...review }, null, 2))
