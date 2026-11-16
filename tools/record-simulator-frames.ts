/** Two-second guest-only capability preflight. No simulator/UI work occurs when imported. */

import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import type { BuildReceipt } from './content/production-fixture.ts'
import { recordingAcknowledged } from './content/simulator-host.ts'

const deviceId = /^[0-9A-F-]{36}$/iu
const QA_DEVICE = '59616A95-4749-4F6F-8E1D-1FAEA0263EFC'
interface Frame {
  x: number
  y: number
  width: number
  height: number
}
interface PageState {
  url: string
  visible: string
  focused: boolean
  width: number
  height: number
  canvas: Frame | null
}
interface AXNode {
  frame?: Frame
  title?: string
  role?: string
  type?: string
  [key: string]: unknown
}
export function targetForPreflight(list: unknown, udid: string) {
  const devices = (
    list as {
      devices?: Record<
        string,
        {
          udid: string
          state: string
          name: string
          deviceTypeIdentifier?: string
          isAvailable?: boolean
        }[]
      >
    }
  ).devices
  const target = Object.values(devices ?? {})
    .flat()
    .find((device) => device.udid === udid)
  if (
    !target ||
    target.isAvailable === false ||
    target.state !== 'Shutdown' ||
    target.deviceTypeIdentifier !== 'com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini' ||
    !target.name.includes('Out West QA')
  ) {
    throw new Error(
      'Preflight requires an available shutdown Out West QA iPhone 13 mini; existing sessions are untouched',
    )
  }
  return target
}
/** Installed idb list-apps prints one JSON object per line, unlike describe-all. */
export function parseIDBApps(stdout: string): unknown[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown)
}
export function preflightURL(origin: string, id: string) {
  const url = new URL(origin)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('Preflight accepts only the local QA production host')
  }
  url.pathname = '/__qa/start'
  url.search = new URLSearchParams({ id, preflight: '1' }).toString()
  url.hash = ''
  return url.href
}
function nodes(value: unknown): AXNode[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  if (Array.isArray(value)) {
    return value.flatMap(nodes)
  }
  return [value as AXNode, ...Object.values(value).flatMap(nodes)]
}
export function frameForAX(value: unknown, label: string): Frame | undefined {
  const node = nodes(value).find((entry) => entry.AXLabel === label || entry.title === label)
  const frame = node?.frame ?? node?.AXFrame
  return validFrame(frame) ? frame : undefined
}
function validFrame(value: unknown): value is Frame {
  const frame = value as Frame | undefined
  return Boolean(
    frame &&
      [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) &&
      frame.width > 0 &&
      frame.height > 0,
  )
}
export function webFrame(value: unknown): Frame | undefined {
  const node = nodes(value).find((entry) =>
    ['WebArea', 'AXWebArea'].includes(String(entry.role ?? entry.AXRole ?? entry.type)),
  )
  const frame = node?.frame ?? node?.AXFrame
  return validFrame(frame) ? frame : undefined
}
export function nativeSafari(value: unknown): { bundle: string; pid: number } | undefined {
  // Only native application records from the frontmost-app AX read count; labels/RUNNING do not.
  for (const node of nodes(value)) {
    if (!['Application', 'AXApplication'].includes(String(node.role ?? node.AXRole ?? node.type))) {
      continue
    }
    const bundle = node.bundleIdentifier ?? node.bundle_id ?? node.bundleID
    const pid = node.pid ?? node.processIdentifier ?? node.process_id
    if (bundle === 'com.apple.mobilesafari' && typeof pid === 'number' && pid > 0) {
      return { bundle, pid }
    }
  }
  return undefined
}
export function preflightIssues(options: {
  beforeAX: unknown
  afterAX: unknown
  expectedURL: string
  receipt: unknown
}) {
  const issues: string[] = []
  const first = nativeSafari(options.beforeAX)
  const last = nativeSafari(options.afterAX)
  if (!(first && last) || first.pid !== last.pid) {
    issues.push('Native guest foreground Safari identity unavailable or changed')
  }
  const receipt = options.receipt as {
    preflight?: boolean
    recording?: {
      completed?: boolean
      inputs?: { type: string }[]
      timestamps?: number[]
      samples?: {
        privacy?: { captureBlocked: boolean; voiceChatForcedOff: boolean; captureCalls: number }
        url?: string
        visible: string
        focused: boolean
        audio: { state: string }[]
        contexts: { lost: boolean; buffer: { width: number; height: number } }[]
      }[]
    }
  }
  const recording = receipt.recording
  if (!(receipt.preflight && recording?.completed && (recording.timestamps?.length ?? 0) >= 30)) {
    issues.push('Two-second native frame capability not established')
  }
  if (!recording?.inputs?.some((input) => input.type === 'pointerdown')) {
    issues.push('Trusted guest HID pointer input missing')
  }
  if (
    !recording?.samples?.length ||
    recording.samples.some(
      (sample) =>
        !(sample.privacy?.captureBlocked && sample.privacy.voiceChatForcedOff) ||
        sample.privacy.captureCalls !== 0,
    )
  ) {
    issues.push('Capture prevention missing or microphone capture attempted')
  }
  if (
    !recording?.samples?.length ||
    recording.samples.some(
      (sample) =>
        sample.visible !== 'visible' || !sample.focused || sample.url !== options.expectedURL,
    )
  ) {
    issues.push('Guest page URL/visibility/focus not established')
  }
  if (
    !recording?.samples?.length ||
    recording.samples.some((sample) => !sample.audio.some((audio) => audio.state === 'running'))
  ) {
    issues.push('Guest game audio not running')
  }
  if (
    !recording?.samples?.length ||
    recording.samples.some(
      (sample) =>
        sample.contexts.length === 0 ||
        sample.contexts.some(
          (context) => context.lost || context.buffer.width <= 0 || context.buffer.height <= 0,
        ),
    )
  ) {
    issues.push('Guest native graphics capability missing')
  }
  return issues
}
/** idb treats decimal coordinate tokens as markers; HID targets must be integer points. */
export function hidTapArguments(x: number, y: number) {
  if (![x, y].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('Invalid guest HID point')
  }
  return [
    'ui',
    'tap',
    String(Math.round(x)),
    String(Math.round(y)),
    '--api',
    'hid',
    '--duration',
    '0.15',
  ]
}
export function commandPlan(udid: string, url: string, port: number) {
  if (!(deviceId.test(udid) && Number.isInteger(port)) || port < 1024 || port > 65_535) {
    throw new Error('Invalid simulator target/port')
  }
  return {
    boot: ['xcrun', 'simctl', 'boot', udid],
    ready: ['xcrun', 'simctl', 'bootstatus', udid],
    readyTimeoutMs: 180_000,
    companion: ['idb_companion', '--udid', udid, '--grpc-port', String(port), '--headless', '1'],
    open: ['xcrun', 'simctl', 'openurl', udid, url],
    shutdown: ['xcrun', 'simctl', 'shutdown', udid],
  }
}
async function command(args: string[], timeout = 30_000) {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), timeout)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) {
      throw new Error(`${args.slice(0, 3).join(' ')} failed: ${stderr || code}`)
    }
    return stdout
  } finally {
    clearTimeout(timer)
  }
}
async function requireFreePort(port: number): Promise<void> {
  const server = createServer()
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => (error ? reject(error) : done())),
    )
  })
}
async function until<T>(read: () => Promise<T | undefined>, seconds = 60): Promise<T> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) {
      return value
    }
    await Bun.sleep(250)
  }
  throw new Error('Headless preflight capability deadline exceeded')
}

async function waitForRecording(stateURL: URL) {
  const recording = await until(async () => {
    const value: unknown = await (await fetch(stateURL)).json()
    return recordingAcknowledged(value) ? value : undefined
  }, 10)
  if (Date.now() - recording.wall > 1000) {
    throw new Error('Recording acknowledgement is stale; no late HID test')
  }
  return recording
}

export async function runPreflight(options: {
  udid: string
  origin: string
  output: string
  port: number
}) {
  const id = crypto.randomUUID()
  const url = preflightURL(options.origin, id)
  const plan = commandPlan(options.udid, url, options.port)
  const build = (await (await fetch(new URL('/recording-build.json', url))).json()) as BuildReceipt
  if (!(build.qaFlag && build.releaseEngine) || build.dirty || build.source !== build.endSource) {
    throw new Error('Clean release-engine QA build required')
  }
  const target = targetForPreflight(
    JSON.parse(await command(['xcrun', 'simctl', 'list', 'devices', 'available', '--json'])),
    options.udid,
  )
  await requireFreePort(options.port)
  await mkdir(options.output) // Never overwrite a previous failure.
  const calls: { args: string[]; at: number; timeoutMs: number; result: unknown }[] = []
  const run = async (args: string[], json = false, timeoutMs = 30_000) => {
    try {
      const stdout = await command(args, timeoutMs)
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
    options.udid,
    '--json',
    '--reason',
    'Out West owned headless simulator preflight',
  ]
  let booted = false
  let companion: ReturnType<typeof Bun.spawn> | undefined
  let report: Record<string, unknown> = {
    classification: 'diagnostic-headless-simulator-preflight',
    qualification: 'incomplete',
    build,
    target,
    calls,
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
    const device = await until(() =>
      run(idb('describe', '--diagnostics'), true).catch(() => undefined),
    )
    await run(plan.open)
    const stateURL = new URL(`/__qa/status/${id}`, url)
    const ready = await until(async () => {
      const response = await fetch(stateURL)
      if (!response.ok) {
        return
      }
      const value = (await response.json()) as { stage: string; page: PageState }
      return value.stage === 'ready' ? value : undefined
    }, 120)
    const beforeAX = await run(
      idb('ui', 'describe-all', '--api', 'axbridge', '--format', 'complete'),
      true,
    )
    const apps = parseIDBApps((await run(idb('list-apps', '--fetch-process-state'))) as string)
    const web = webFrame(beforeAX)
    const start = frameForAX(beforeAX, 'Start 2s headless preflight')
    if (!(web && start && ready.page.canvas)) {
      throw new Error('Native guest AX/canvas frames unavailable; no guessed coordinates')
    }
    const scale = web.width / ready.page.width
    if (!(scale > 0 && Math.abs(web.height - ready.page.height * scale) < 4)) {
      throw new Error('Guest CSS/AX viewport transform unproved')
    }
    const tap = (x: number, y: number) => run(idb(...hidTapArguments(x, y)))
    const canvas = ready.page.canvas
    await tap(
      web.x + (canvas.x + canvas.width * 0.7) * scale,
      web.y + (canvas.y + canvas.height * 0.5) * scale,
    )
    await run(idb('screenshot', join(options.output, 'before.png')))
    await tap(start.x + start.width / 2, start.y + start.height / 2)
    report.recordingAcknowledgement = await waitForRecording(stateURL)
    const fire = frameForAX(beforeAX, 'FIRE')
    if (fire) {
      await tap(fire.x + fire.width / 2, fire.y + fire.height / 2)
    } else {
      await tap(
        web.x + (canvas.x + canvas.width * 0.7) * scale,
        web.y + (canvas.y + canvas.height * 0.5) * scale,
      )
    }
    const saved = await until(async () => {
      const value = (await (await fetch(stateURL)).json()) as { stage: string; receipt?: unknown }
      return value.stage === 'saved' && value.receipt ? value : undefined
    }, 15)
    const afterAX = await run(
      idb('ui', 'describe-all', '--api', 'axbridge', '--format', 'complete'),
      true,
    )
    await run(idb('screenshot', join(options.output, 'after.png')))
    const issues = preflightIssues({
      beforeAX,
      afterAX,
      expectedURL: ready.page.url,
      receipt: saved.receipt,
    })
    report = {
      ...report,
      device,
      apps,
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
          options.udid,
          new URL(`/__qa/restore?id=${id}`, url).href,
        ])
        for (let attempt = 0; attempt < 20; attempt++) {
          const restored = (await (await fetch(new URL(`/__qa/status/${id}`, url))).json()) as {
            settingsRestored?: boolean
          }
          if (restored.settingsRestored) {
            report.settingsRestored = true
            break
          }
          await Bun.sleep(100)
        }
        if (!report.settingsRestored) {
          report.settingsRestoreFailure = 'Guest restore acknowledgement unavailable'
        }
      } catch (error) {
        report.settingsRestoreFailure = String(error)
      }
    }
    companion?.kill()
    await companion?.exited
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
  if (!process.argv.includes('--preflight')) {
    throw new Error('Only bounded --preflight is implemented; no automatic long simulator capture')
  }
  console.log(
    await runPreflight({
      udid: arg('udid', QA_DEVICE),
      origin: arg('url', 'http://127.0.0.1:4398'),
      output: resolve(arg('out', '/tmp/out-west-simulator-preflight')),
      port: Number(arg('companion-port', '10892')),
    }),
  )
}
