import { COORDINATE_KEYS, recordingDocument } from './content/simulator-document.ts'
/** Two-second guest-only capability preflight. No simulator/UI work occurs when imported. */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { BuildReceipt } from './content/production-fixture.ts'
import {
  coordinateStatus,
  prepareCoordinates,
  startCoordinates,
} from './content/simulator-coordinates.ts'
import { recordingMode } from './content/simulator-hid.ts'
import {
  commandPlan,
  hidTapArguments,
  type PageState,
  parseIDBApps,
  preflightIssues,
  preflightURL,
  safariLaunchArguments,
  targetForPreflight,
} from './content/simulator-native.ts'
import {
  bounded,
  command,
  openSafariWhenReady,
  readSafariReadiness,
  requireFreePort,
  type SafariReadinessEvent,
  statusJSON,
  stopOwned,
  until,
  waitForRecording,
  waitForSettingsRestore,
} from './content/simulator-process.ts'

type PreflightRun = (
  args: string[],
  json?: boolean,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<unknown>
async function nativeState(
  run: PreflightRun,
  idb: (...args: string[]) => string[],
  options: { timeoutMs?: number; signal?: AbortSignal; keys?: string[] } = {},
) {
  const { timeoutMs = 30_000, signal, keys = [] } = options
  const deadline = Date.now() + timeoutMs
  const ax = await run(
    idb(
      'ui',
      'describe-all',
      '--api',
      'axbridge',
      '--format',
      'complete',
      ...keys.flatMap((key) => ['--key', key]),
    ),
    true,
    timeoutMs,
    signal,
  )
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    throw new Error('Native Safari state deadline exceeded')
  }
  const apps = parseIDBApps(
    (await run(idb('list-apps', '--fetch-process-state'), false, remaining, signal)) as string,
  )
  return { ax, apps }
}
function openPreflightPage(
  run: PreflightRun,
  idb: (...args: string[]) => string[],
  open: string[],
  observe: (event: SafariReadinessEvent) => void,
) {
  return openSafariWhenReady({
    launch: (remaining, signal) => run(safariLaunchArguments(idb), false, remaining, signal),
    read: (remaining, signal) =>
      readSafariReadiness(
        {
          ax: (budget, abort) =>
            run(
              idb('ui', 'describe-all', '--api', 'axbridge', '--format', 'complete'),
              true,
              budget,
              abort,
            ),
          apps: async (budget, abort) =>
            parseIDBApps(
              (await run(
                idb('list-apps', '--fetch-process-state'),
                false,
                budget,
                abort,
              )) as string,
            ),
        },
        remaining,
        signal,
      ),
    open: (remaining, signal) => run(open, false, remaining, signal),
    observe,
  })
}
function preflightCoordinates(
  run: PreflightRun,
  idb: (...args: string[]) => string[],
  stateURL: URL,
  evidence: Record<string, unknown>[],
) {
  return {
    read: () => nativeState(run, idb, { keys: COORDINATE_KEYS }),
    hit: (point: { x: number; y: number }) =>
      run(
        idb(
          'ui',
          'describe-point',
          String(point.x),
          String(point.y),
          '--api',
          'axbridge',
          '--format',
          'complete',
          ...COORDINATE_KEYS.flatMap((key) => ['--key', key]),
        ),
        true,
      ),
    tap: (point: { x: number; y: number }) => run(idb(...hidTapArguments(point.x, point.y))),
    status: (signal: AbortSignal) => coordinateStatus(stateURL, signal),
    observe: (value: Record<string, unknown>) => {
      evidence.push(value)
      return Promise.resolve()
    },
  }
}
export async function runPreflight(options: {
  udid: string
  origin: string
  output: string
  port: number
}) {
  const id = crypto.randomUUID()
  const url = preflightURL(options.origin, id)
  const build = await bounded(
    (signal) => statusJSON<BuildReceipt>(new URL('/recording-build.json', url), signal),
    5000,
  )
  if (!(build.qaFlag && build.releaseEngine) || build.dirty || build.source !== build.endSource) {
    throw new Error('Clean release-engine QA build required')
  }
  const target = targetForPreflight(
    JSON.parse(await command(['xcrun', 'simctl', 'list', 'devices', 'available', '--json'])),
    options.udid,
  )
  const plan = commandPlan(target.udid, url, options.port)
  await requireFreePort(options.port)
  await mkdir(options.output) // Never overwrite a previous failure.
  const calls: { args: string[]; at: number; timeoutMs: number; result: unknown }[] = []
  const run: PreflightRun = async (
    args,
    json = false,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ) => {
    try {
      const stdout = await command(args, timeoutMs, signal)
      const result: unknown = json ? JSON.parse(stdout) : stdout
      calls.push({ args, at: Date.now(), timeoutMs, result })
      return result
    } catch (error) {
      calls.push({ args, at: Date.now(), timeoutMs, result: { failure: String(error) } })
      throw error
    }
  }
  const idb = (...args: string[]) => [
    'idb',
    '--companion',
    `127.0.0.1:${options.port}`,
    ...args,
    '--udid',
    target.udid,
    '--json',
    '--reason',
    'Out West owned headless simulator preflight',
  ]
  let booted = false
  let companion: ReturnType<typeof Bun.spawn> | undefined
  const safariReadiness: SafariReadinessEvent[] = []
  let report: Record<string, unknown> = {
    classification: 'diagnostic-headless-simulator-preflight',
    qualification: 'incomplete',
    build,
    target,
    calls,
    safariReadiness,
  }
  try {
    await run(plan.boot)
    booted = true
    await run(plan.ready, false, plan.readyTimeoutMs)
    companion = Bun.spawn(plan.companion, {
      stdout: Bun.file(join(options.output, 'companion.log')),
      stderr: Bun.file(join(options.output, 'companion-stderr.log')),
    })
    // Startup failures are retained by run(); polling does not erase their evidence.
    const device = await until((_signal, remaining) =>
      run(idb('describe', '--diagnostics'), true, Math.min(30_000, remaining)).catch(
        () => undefined,
      ),
    )
    await openPreflightPage(run, idb, plan.open, (event) => {
      safariReadiness.push(event)
    })
    const stateURL = new URL(`/__qa/status/${id}`, url)
    const ready = await until(async (signal) => {
      const response = await fetch(stateURL, { signal })
      if (!response.ok) {
        return
      }
      const value = (await response.json()) as { stage: string; page: PageState }
      return value.stage === 'ready' ? value : undefined
    }, 120)
    const coordinateEvidence: Record<string, unknown>[] = []
    report.coordinateEvidence = coordinateEvidence
    const coordinates = preflightCoordinates(run, idb, stateURL, coordinateEvidence)
    const prepared = await prepareCoordinates(
      coordinates,
      recordingDocument(id, ready.page.url, 'Start 2s headless preflight'),
      'portrait',
    )
    const { ax: beforeAX, apps: beforeApps } = prepared
    await run(idb('screenshot', join(options.output, 'before.png')))
    await startCoordinates(coordinates, prepared)
    report.recordingAcknowledgement = await waitForRecording(stateURL)
    await coordinates.tap(prepared.buttons.FIRE.point)
    const saved = await until(async (signal) => {
      const value = (await statusJSON(stateURL, signal)) as { stage: string; receipt?: unknown }
      return value.stage === 'saved' && value.receipt ? value : undefined
    }, 15)
    const { ax: afterAX, apps: afterApps } = await nativeState(run, idb)
    await run(idb('screenshot', join(options.output, 'after.png')))
    const issues = preflightIssues({
      beforeAX,
      afterAX,
      beforeApps,
      afterApps,
      expectedURL: ready.page.url,
      receipt: saved.receipt,
    })
    report = {
      ...report,
      device,
      beforeApps,
      afterApps,
      beforeAX,
      afterAX,
      browserReceipt: saved.receipt,
      issues,
      capability:
        issues.length > 0
          ? 'unproved; explicit diagnostic only'
          : 'guest preflight gates passed; independent native-state review required',
      limits:
        'Two seconds only. No Mac foreground/window claim, no60s/30FPS/device acceptance; list-apps RUNNING is not foreground.',
    }
  } catch (error) {
    report = { ...report, failure: String(error) }
    throw error
  } finally {
    if (booted) {
      try {
        await run([
          'xcrun',
          'simctl',
          'openurl',
          target.udid,
          new URL(`/__qa/restore?id=${id}`, url).href,
        ])
        report.settingsRestored = await waitForSettingsRestore(
          new URL(`/__qa/status/${id}`, url),
          2,
        )
        if (!report.settingsRestored) {
          report.settingsRestoreFailure = 'Guest restore acknowledgement unavailable'
        }
      } catch (error) {
        report.settingsRestoreFailure = String(error)
      }
    }
    if (companion) {
      try {
        report.companionCleanup = await stopOwned(companion)
      } catch (error) {
        report.companionCleanupFailure = String(error)
      }
    }
    if (booted) {
      try {
        await run(plan.shutdown)
      } catch (error) {
        report.shutdownFailure = String(error)
      }
    }
    await writeFile(join(options.output, 'preflight.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  return report
}
if (import.meta.main) {
  const arg = (name: string, fallback: string) =>
    process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
  const mode = recordingMode(process.argv)
  if (mode === 'record') {
    const { runRecording } = await import('./content/simulator-recording.ts')
    const report = await runRecording({
      udid: arg('udid', ''),
      origin: arg('url', 'http://127.0.0.1:4398'),
      output: resolve(arg('out', '/tmp/out-west-simulator-recording')),
      port: Number(arg('companion-port', '10892')),
      population: arg('population', 'ordinary'),
      orientation: arg('orientation', 'portrait'),
      python: arg('python', '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3'),
    })
    console.log(report)
    process.exit(report.qualification === 'complete' && report.performanceTarget === 'pass' ? 0 : 1)
  }
  console.log(
    await runPreflight({
      udid: arg('udid', ''),
      origin: arg('url', 'http://127.0.0.1:4398'),
      output: resolve(arg('out', '/tmp/out-west-simulator-preflight')),
      port: Number(arg('companion-port', '10892')),
    }),
  )
}
