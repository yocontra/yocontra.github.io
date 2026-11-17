/** Bounded plain Simulator Safari run, sharing preflight native guards and owned lifecycle. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { frameTarget } from './frame-target.ts'
import { frameTiming } from './frame-timing.ts'
import {
  type BuildReceipt,
  type NativeSample,
  qualifyProductionFixture,
} from './production-fixture.ts'
import { cleanupGuest } from './simulator-cleanup.ts'
import { simulatorClient } from './simulator-client.ts'
import { coordinateStatus, prepareCoordinates, startCoordinates } from './simulator-coordinates.ts'
import { COORDINATE_KEYS, recordingDocument } from './simulator-document.ts'
import {
  type Clock,
  finalRecordingVerdict,
  type Gesture,
  gestureTape,
  joinGestures,
  type NativeForegroundSample,
  nativeForeground,
  recordingOptions,
  type TrustedInput,
  walkingEvidence,
} from './simulator-hid.ts'
import {
  commandPlan,
  type Frame,
  type PageState,
  preflightIssues,
  preflightURL,
  targetForPreflight,
} from './simulator-native.ts'
import { type InitialDisplay, openOrientedSafari } from './simulator-orientation.ts'
import {
  bounded,
  command,
  requireFreePort,
  type SafariReadinessEvent,
  statusJSON,
  until,
  waitForRecording,
} from './simulator-process.ts'

interface Recording {
  timestamps: number[]
  inputs: TrustedInput[]
  samples: Parameters<typeof qualifyProductionFixture>[0]['samples']
  completed: boolean
  resources: { path: string }[]
}
interface Receipt {
  recording: Recording
  history?: NativeSample
  authority?: Parameters<typeof qualifyProductionFixture>[0]['server']
  scriptHashes: Parameters<typeof qualifyProductionFixture>[0]['scripts']
  preflight: boolean
  failure?: string
}
interface State {
  stage: string
  page: PageState
  receipt?: Receipt
  settingsRestored?: boolean
  error?: string
}
interface Options {
  udid: string
  origin: string
  output: string
  port: number
  population: string
  orientation: string
  python: string
}
type Native = Awaited<ReturnType<typeof simulatorClient>>
type Run = (args: string[], timeout?: number, signal?: AbortSignal) => Promise<string>
interface Capture {
  beforeAX: unknown
  afterAX: unknown
  beforeApps: unknown
  afterApps: unknown
  ready: State
  receipt: Receipt
  tape: Gesture[]
  bridgeResult: unknown
  nativeFailure: string | null
  orientation: string
  web: Frame
}
const developmentPath = /^\/(?:@vite|src|node_modules)\//u
export async function captureNative(context: {
  native: Pick<Native, 'call'>
  run: Run
  open: string[]
  stateURL: URL
  selected: ReturnType<typeof recordingOptions>
  output: string
  checkpoint: (value: Record<string, unknown>) => Promise<void>
  orientation: {
    udid: string
    capture: (initial: InitialDisplay) => Promise<void>
    beforeOpen: () => Promise<void>
  }
}): Promise<Capture> {
  const { native, run, open, stateURL, selected, output, checkpoint } = context
  const expected = selected.orientation === 'portrait' ? 'PORTRAIT' : 'LANDSCAPE_LEFT'
  const orientationEvidence: Record<string, unknown>[] = []
  const safariReadiness: SafariReadinessEvent[] = []
  await openOrientedSafari({
    native,
    udid: context.orientation.udid,
    target: expected,
    open: (remaining, signal) => run(open, remaining, signal),
    screenshot: (remaining) =>
      native.call(
        'screenshot',
        { path: join(output, 'initial-display.png') },
        Math.min(remaining, 15_000),
      ),
    capture: context.orientation.capture,
    beforeOpen: context.orientation.beforeOpen,
    observe: async (value) => {
      orientationEvidence.push(value)
      await checkpoint({ orientationEvidence })
    },
    safariObserve: async (event) => {
      safariReadiness.push(event)
      await checkpoint({ safariReadiness })
    },
  })
  let ready = await until(async (signal) => {
    const response = await fetch(stateURL, { signal })
    // Safari can finish opening the URL before the fixture publishes its first status.
    if (response.status === 404 && (await response.text()) === 'Not ready') {
      return
    }
    if (response.status !== 200) {
      throw new Error(`Simulator readiness status HTTP ${response.status}`)
    }
    const value = (await response.json()) as State
    if (value.stage === 'failed') {
      throw new Error(value.error)
    }
    return value.stage === 'ready' ? value : undefined
  }, 120)
  const coordinateEvidence: Record<string, unknown>[] = []
  const coordinates = {
    read: async () => ({
      ax: await native.call('ax', { keys: COORDINATE_KEYS }),
      apps: await native.call('apps'),
    }),
    hit: (point: { x: number; y: number }) =>
      native.call('hit', { ...point, keys: COORDINATE_KEYS }),
    tap: (point: { x: number; y: number }) => native.call('tap', point),
    status: (signal: AbortSignal) => coordinateStatus(stateURL, signal),
    observe: (value: Record<string, unknown>) => {
      coordinateEvidence.push(value)
      return Promise.resolve()
    },
  }
  const id = stateURL.pathname.split('/').at(-1) ?? ''
  const startText = `Start 60s ${selected.population === 'ordinary' ? '5 rider' : '32 rider'} recording`
  const prepared = await prepareCoordinates(
    coordinates,
    recordingDocument(id, ready.page.url, startText),
    selected.orientation,
  )
  const { ax: beforeAX, apps: beforeApps, web, buttons } = prepared
  ready = { ...ready, page: prepared.page }
  await checkpoint({ coordinateEvidence })
  await native.call('screenshot', { path: join(output, 'before.png') })
  await startCoordinates(coordinates, prepared)
  const acknowledged = await waitForRecording(stateURL)
  const clock = acknowledged.recording as typeof acknowledged.recording & Clock
  if (!(Number.isFinite(clock.at) && Number.isFinite(clock.wall))) {
    throw new Error('Actual guest recording clock unavailable')
  }
  const tape = gestureTape({
    page: ready.page,
    web,
    buttons,
    clock,
    orientation: selected.orientation,
  })
  await checkpoint({
    recordingAcknowledgement: acknowledged,
    orientation: expected,
    geometry: { web, page: ready.page, buttons },
    tape,
  })
  let bridgeResult: unknown
  let nativeFailure: string | null = null
  try {
    bridgeResult = await native.call('record', { clock, tape }, 75_000)
  } catch (error) {
    nativeFailure = String(error)
    await checkpoint({ nativeFailure })
  }
  // A native input/sampler failure must not discard the browser's complete or partial raw tape.
  const saved = await until(async (signal) => {
    const value = (await statusJSON(stateURL, signal)) as State
    return value.receipt ? value : undefined
  }, 80)
  if (!saved.receipt) {
    throw new Error('Native page receipt missing')
  }
  const afterAX = await native.call('ax')
  const afterApps = await native.call('apps')
  await native.call('screenshot', { path: join(output, 'after.png') })
  return {
    beforeAX,
    afterAX,
    beforeApps,
    afterApps,
    ready,
    receipt: saved.receipt,
    tape,
    bridgeResult,
    nativeFailure,
    orientation: expected,
    web,
  }
}
function extraIssues(data: Capture, timing: ReturnType<typeof frameTiming> | null, source: string) {
  const issues: string[] = []
  const recording = data.receipt.recording
  const canvas = data.ready.page.canvas
  if (!timing || timing.durationMs < 60_000 || !recording.completed) {
    issues.push('Less than60s completed native timing')
  }
  if (recording.resources.some((r) => developmentPath.test(r.path))) {
    issues.push('Development resource served')
  }
  if (data.receipt.failure || data.nativeFailure) {
    issues.push('Native/browser partial failure retained')
  }
  if (
    Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim() !== source ||
    Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'])
      .stdout.toString()
      .trim()
  ) {
    issues.push('Source changed during recording')
  }
  const samples = recording.samples as {
    contexts?: { css?: { width: number; height: number } }[]
  }[]
  if (
    !canvas ||
    samples.some(
      (sample) =>
        !sample.contexts?.length ||
        sample.contexts.some(
          (c) =>
            !c.css ||
            Math.abs(c.css.width - canvas.width) > 1 ||
            Math.abs(c.css.height - canvas.height) > 1,
        ),
    )
  ) {
    issues.push('Canvas geometry changed after native gesture transform')
  }
  return issues
}
async function qualifyNative(context: {
  data: Capture
  native: Native
  build: BuildReceipt
  source: string
  selected: ReturnType<typeof recordingOptions>
  udid: string
}) {
  const { data, native, build, source, selected, udid } = context
  const receipt = data.receipt
  const recording = receipt.recording
  const timing = recording.timestamps.length >= 2 ? frameTiming(recording.timestamps) : null
  const start = recording.samples[0]?.wall ?? 0
  const end = recording.samples.at(-1)?.wall ?? 0
  const foreground = (native.events as { event: string; value?: NativeForegroundSample }[]).flatMap(
    (e) => (e.event === 'foreground' && e.value ? [e.value] : []),
  )
  const foregroundCoverage = nativeForeground(foreground, {
    start,
    end,
    orientation: data.orientation,
    udid,
  })
  const gestures = joinGestures(data.tape, recording.inputs, data.web, data.ready.page)
  const issues = preflightIssues({
    beforeAX: data.beforeAX,
    afterAX: data.afterAX,
    beforeApps: data.beforeApps,
    afterApps: data.afterApps,
    expectedURL: data.ready.page.url,
    receipt,
    seconds: 60,
  })
  issues.push(
    ...qualifyProductionFixture({
      samples: recording.samples,
      ...(receipt.history ? { history: receipt.history } : {}),
      ...(receipt.authority ? { server: receipt.authority } : {}),
      build,
      source,
      contentHash: createHash('sha256')
        .update(await readFile('src/experiments/out-west/content/manifest.ts'))
        .digest('hex'),
      scripts: receipt.scriptHashes ?? [],
      stress: selected.population === 'stress',
      start,
      end,
    }),
    ...extraIssues(data, timing, source),
  )
  const walking = walkingEvidence(
    (receipt.authority?.samples ?? []).filter(
      (sample) => sample.wall >= start && sample.wall <= end,
    ),
  )
  if (walking.distance <= 0.5) {
    issues.push(
      'Continuous living movement not confirmed after excluding death/respawn/teleport segments',
    )
  }
  if (!gestures.passed) {
    issues.push('Native gesture endpoint/shape qualification failed (unchanged ±35ms)')
  }
  if (!foregroundCoverage.passed) {
    issues.push('Native guest foreground/orientation timeline incomplete')
  }
  const target = timing ? frameTarget(timing, 'simulator') : null
  let performanceTarget = 'unqualified'
  if (issues.length === 0) {
    performanceTarget = target?.passed ? 'pass' : 'fail'
  }
  return {
    ...data,
    browserReceipt: receipt,
    foregroundCoverage,
    gestures,
    walking,
    timing,
    issues,
    target,
    qualification: issues.length > 0 ? 'incomplete' : 'complete',
    performanceTarget,
    limits:
      'Simulator only, not physical iPhone. Guest native AX foreground, not Mac frontmost. No WebContent/profiler attribution or causal speedup claim.',
  }
}
export async function runRecording(options: Options) {
  const selected = recordingOptions(options.population, options.orientation)
  const id = crypto.randomUUID()
  const url = new URL(preflightURL(options.origin, id))
  url.searchParams.delete('preflight')
  url.searchParams.set('population', selected.population)
  const build = await bounded(
    (signal) => statusJSON<BuildReceipt>(new URL('/recording-build.json', url), signal),
    5000,
  )
  const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim()
  const dirty = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'])
    .stdout.toString()
    .trim()
  if (
    !(build.qaFlag && build.releaseEngine) ||
    build.dirty ||
    build.source !== source ||
    build.endSource !== source ||
    dirty
  ) {
    throw new Error('Clean matching release-engine QA source/build required')
  }
  const target = targetForPreflight(
    JSON.parse(await command(['xcrun', 'simctl', 'list', 'devices', 'available', '--json'])),
    options.udid,
  )
  await requireFreePort(options.port)
  await mkdir(options.output)
  const plan = commandPlan(options.udid, url.href, options.port)
  const stateURL = new URL(`/__qa/status/${id}`, url)
  const calls: unknown[] = []
  const run: Run = async (args, timeout = 30_000, signal?: AbortSignal) => {
    try {
      const result = await command(args, timeout, signal)
      calls.push({ args, wall: Date.now(), result })
      return result
    } catch (error) {
      calls.push({ args, wall: Date.now(), error: String(error) })
      throw error
    }
  }
  let booted = false
  let native: Native | undefined
  let companion: ReturnType<typeof Bun.spawn> | undefined
  let initialOrientation: InitialDisplay | undefined
  let qaPageAttempted = false
  let report: Record<string, unknown> = {
    classification: 'plain-headless-simulator-native-recording',
    qualification: 'incomplete',
    performanceTarget: 'unqualified',
    source,
    build,
    device: target,
    options: selected,
    calls,
  }
  const persist = () =>
    writeFile(join(options.output, 'recording.json'), `${JSON.stringify(report, null, 2)}\n`)
  const checkpoint = async (value: Record<string, unknown>) => {
    report = { ...report, ...value }
    await persist()
  }
  try {
    await run(plan.boot)
    booted = true
    await run(plan.ready, plan.readyTimeoutMs)
    companion = Bun.spawn(plan.companion, {
      stdout: Bun.file(join(options.output, 'companion.log')),
      stderr: Bun.file(join(options.output, 'companion-stderr.log')),
    })
    await until(
      (signal, remaining) =>
        command(
          [
            'idb',
            '--companion',
            `127.0.0.1:${options.port}`,
            'describe',
            '--udid',
            options.udid,
            '--json',
          ],
          Math.min(30_000, remaining),
          signal,
        ).catch(() => undefined),
      60,
    )
    native = await simulatorClient(options.python, options.port, options.udid, options.output)
    const data = await captureNative({
      native,
      run,
      open: plan.open,
      stateURL,
      selected,
      output: options.output,
      checkpoint,
      orientation: {
        udid: options.udid,
        capture: async (initial) => {
          initialOrientation = initial
          await checkpoint({
            initialNativeDisplay: initial,
            initialDisplayScreenshot: join(options.output, 'initial-display.png'),
          })
        },
        beforeOpen: async () => {
          qaPageAttempted = true
          await checkpoint({ qaPageAttempted: true })
        },
      },
    })
    await checkpoint(
      await qualifyNative({ data, native, build, source, selected, udid: options.udid }),
    )
  } catch (error) {
    report.failure = String(error)
  } finally {
    const cleanup = await cleanupGuest({
      booted,
      native,
      companion,
      run,
      options,
      stateURL,
      url,
      initialDisplay: initialOrientation,
      qaPageAttempted,
    })
    report.cleanup = cleanup
    Object.assign(
      report,
      finalRecordingVerdict(
        (report.issues as string[] | undefined) ?? ['Recording failed before qualification'],
        report.target as { passed: boolean } | null,
        cleanup,
      ),
    )
    await persist()
  }
  return report
}
