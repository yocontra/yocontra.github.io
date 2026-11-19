/** Foreground production trace. Population/scenario proof remains a separate qualification input. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { foregroundCoverage } from './content/foreground-coverage.ts'
import { frameRecorderSource, type QARecorderPrivacySample } from './content/frame-recorder.ts'
import { frameRecordingExitCode, frameTarget } from './content/frame-target.ts'
import { frameTiming } from './content/frame-timing.ts'
import {
  type BuildReceipt,
  localFixtureURL,
  type NativeSample,
  prepareProductionFixture,
  qualifyProductionFixture,
} from './content/production-fixture.ts'

const argument = (name: string, fallback = '') =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const url = argument('url')
const seconds = Number(argument('seconds', '60'))
const visible = process.argv.includes('--visible')
const headless = !visible
if (visible && process.argv.includes('--headless')) {
  throw new Error('Choose either --visible or --headless')
}
const manual = process.argv.includes('--manual')
const output = argument('out', join(tmpdir(), `out-west-frames-${Date.now()}`))
const population = argument('population', 'ordinary')
const api = argument('api')
const developmentPath = /^\/(?:@vite|src|node_modules)\//u
if (
  !(url && Number.isFinite(seconds)) ||
  seconds <= 0 ||
  !['ordinary', 'stress'].includes(population)
) {
  throw new Error(
    'Supply a local production URL, positive duration, and ordinary or stress population',
  )
}
localFixtureURL(url)
localFixtureURL(api)
await mkdir(output, { recursive: true })
const recorder = frameRecorderSource()
await writeFile(join(output, 'simulator-recorder.js'), recorder)
const revision = () => {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'])
  if (result.exitCode !== 0) {
    throw new Error('Git revision unavailable')
  }
  return result.stdout.toString().trim()
}
const source = revision()
const dirty = Bun.spawnSync([
  'git',
  'status',
  '--porcelain',
  '--untracked-files=all',
]).stdout.toString()
const hostTool =
  visible && platform() === 'darwin' ? join(output, 'foreground-recorder') : undefined
if (hostTool) {
  const build = Bun.spawnSync(['swiftc', 'tools/content/foreground.swift', '-o', hostTool])
  if (build.exitCode !== 0) {
    throw new Error(`Foreground sidecar failed: ${build.stderr.toString()}`)
  }
}
interface Sample {
  wall: number
  visible: string
  focused: boolean
  audio: { state: string }[]
  contexts: { lost: boolean; buffer: { width: number; height: number } }[]
  game?: NativeSample
  privacy?: QARecorderPrivacySample
}
interface Recording {
  timestamps: number[]
  samples: Sample[]
  inputs: { at: number; type: string; key?: string }[]
  resources: { path: string; version: string | null }[]
  completed: boolean
}
interface HostSample {
  wall: number
  bundle: string
  pid: number
  onScreenWindows: number
}
const browser = await chromium.launch({
  channel: 'chrome',
  headless,
  args: ['--window-size=1280,800'],
})
let sidecar: ReturnType<typeof Bun.spawn> | undefined
const errors: string[] = []
const scriptHashes: {
  path: string
  origin: string
  local: boolean
  sha256: string
  bytes: number
  receiptSource: 'response-body' | 'same-url-refetch'
}[] = []
const pendingScripts: Promise<void>[] = []
try {
  const browserProtocol = await browser.newBrowserCDPSession()
  const processes = await browserProtocol.send('SystemInfo.getProcessInfo')
  const browserPid = processes.processInfo.find((process) => process.type === 'browser')?.id
  const browserVersion = await browserProtocol.send('Browser.getVersion')
  const page = await browser.newPage({ viewport: headless ? { width: 1280, height: 713 } : null })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (!(path.endsWith('.js') && response.ok())) {
      return
    }
    pendingScripts.push(
      response
        .body()
        .then((body) => {
          scriptHashes.push({
            path,
            origin: new URL(response.url()).origin,
            local: new URL(response.url()).origin === new URL(url).origin,
            sha256: createHash('sha256').update(body).digest('hex'),
            bytes: body.length,
            receiptSource: 'response-body',
          })
        })
        .catch(async () => {
          // Worker responses can be absent from the page CDP body cache; preserve the source of this hash.
          let retry: Response | undefined
          try {
            retry = await fetch(response.url())
          } catch {
            retry = undefined
          }
          if (retry?.ok) {
            const body = new Uint8Array(await retry.arrayBuffer())
            scriptHashes.push({
              path,
              origin: new URL(response.url()).origin,
              local: new URL(response.url()).origin === new URL(url).origin,
              sha256: createHash('sha256').update(body).digest('hex'),
              bytes: body.length,
              receiptSource: 'same-url-refetch',
            })
          } else {
            errors.push(`Script receipt unavailable: ${path}`)
          }
        }),
    )
  })
  await page.addInitScript({ content: recorder })
  const fixture = api
    ? await prepareProductionFixture(page, url, api, population === 'stress')
    : undefined
  if (!fixture) {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
  }
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas')
      return Boolean(canvas && canvas.width > 0 && !document.querySelector('.pc-loading'))
    },
    null,
    { timeout: 120_000 },
  )
  if (visible) {
    await page.bringToFront()
  }
  const canvas = page.locator('canvas').first()
  await canvas.click()
  await page.waitForFunction(
    () => {
      const state = Reflect.get(globalThis, '__owFrameRecorder').inspect()
      return (
        state.contexts.length > 0 &&
        state.audio.some((audio: { state: string }) => audio.state === 'running')
      )
    },
    null,
    { timeout: 30_000 },
  )
  await Promise.all(pendingScripts)
  await page.screenshot({ path: join(output, 'before.png') })
  const buildResponse = await fetch(new URL('/recording-build.json', url)).catch(() => undefined)
  const build: BuildReceipt | undefined = buildResponse?.ok
    ? ((await buildResponse.json()) as BuildReceipt)
    : undefined
  if (hostTool) {
    sidecar = Bun.spawn([hostTool, String(seconds + 10)], {
      stdout: Bun.file(join(output, 'foreground.jsonl')),
      stderr: Bun.file(join(output, 'foreground-stderr.txt')),
    })
  }
  await fixture?.start()
  await page.evaluate(
    (duration) => Reflect.get(globalThis, '__owFrameRecorder').start(duration),
    seconds,
  )
  const started = Date.now()
  let iteration = 0
  while (Date.now() - started < (seconds + 30) * 1000) {
    const status = await page.evaluate(() => Reflect.get(globalThis, '__owFrameRecorder').status())
    if (!status.running) {
      break
    }
    if (manual) {
      await Bun.sleep(1000)
    } else {
      const side = iteration % 2 === 0 ? 'KeyA' : 'KeyD'
      await page.keyboard.down('KeyW')
      await page.keyboard.down(side)
      await page.keyboard.down('ShiftLeft')
      await page.mouse.move(iteration % 2 === 0 ? 560 : 720, 360, { steps: 3 })
      await page.mouse.click(640, 360)
      if (iteration % 6 === 0) {
        await page.keyboard.press('Space')
      }
      if (iteration % 8 === 0) {
        await page.keyboard.press('KeyR')
      }
      if (iteration % 4 === 0) {
        await page.mouse.down({ button: 'right' })
      }
      await Bun.sleep(700)
      await page.mouse.up({ button: 'right' })
      await page.keyboard.up(side)
      await page.keyboard.up('ShiftLeft')
    }
    iteration++
  }
  await page.keyboard.up('KeyW')
  const data: Recording = await page.evaluate(() => {
    const active = Reflect.get(globalThis, '__owFrameRecorder')
    return active.result() ?? active.partial()
  })
  const authority = await fixture?.finish()
  await Promise.all(pendingScripts)
  const history: NativeSample | undefined = await page.evaluate(() =>
    Reflect.get(globalThis, '__owPerformanceSnapshot')?.(true),
  )
  await page.screenshot({ path: join(output, 'after.png') })
  sidecar?.kill()
  await sidecar?.exited
  const host: HostSample[] = sidecar
    ? (await readFile(join(output, 'foreground.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
  const first = data.samples[0]?.wall ?? started
  const last = data.samples.at(-1)?.wall ?? Date.now()
  const foreground = host.filter(
    (sample) => sample.wall >= first - 1000 && sample.wall <= last + 1000,
  )
  const coverage = foregroundCoverage(foreground, {
    start: first,
    end: last,
    bundle: 'com.google.Chrome',
    pid: browserPid,
  })
  const problems: string[] = []
  if (
    data.samples.some(
      (sample) =>
        !(sample.privacy?.captureBlocked && sample.privacy.voiceChatForcedOff) ||
        sample.privacy.captureCalls !== 0,
    )
  ) {
    problems.push('QA capture guard missing or microphone capture attempted')
  }
  if (headless) {
    problems.push('Headless rendering is diagnostic only')
  }
  if (seconds < 60 || !data.completed) {
    problems.push('Less than 60 seconds of completed recording')
  }
  const endDirty = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'])
    .stdout.toString()
    .trim()
  if (revision() !== source || dirty.trim() || endDirty) {
    problems.push('Source was dirty or changed during recording')
  }
  if (data.resources.some((resource) => developmentPath.test(resource.path))) {
    problems.push('Development resources were served')
  }
  if (scriptHashes.length === 0) {
    problems.push('Production script hashes unavailable')
  }
  if (data.samples.some((sample) => sample.visible !== 'visible' || !sample.focused)) {
    problems.push('Page lost visibility or focus')
  }
  if (
    data.samples.some(
      (sample) =>
        sample.audio.length === 0 || sample.audio.some((context) => context.state !== 'running'),
    )
  ) {
    problems.push('Audio context was absent or interrupted')
  }
  if (
    data.samples.some(
      (sample) => sample.contexts.length === 0 || sample.contexts.some((context) => context.lost),
    )
  ) {
    problems.push('Native graphics context unavailable')
  }
  if (visible && !coverage.passed) {
    problems.push('Host foreground evidence incomplete or Chrome was not frontmost')
  }
  if (
    data.inputs.length < 10 ||
    !data.inputs.some((input) => input.key === 'KeyW') ||
    !data.inputs.some((input) => input.type === 'pointerdown')
  ) {
    problems.push('Active movement and firing input not established')
  }
  if (errors.length > 0) {
    problems.push('Browser errors recorded')
  }
  const timing = data.timestamps.length >= 2 ? frameTiming(data.timestamps) : null
  const fixtureProblems = qualifyProductionFixture({
    samples: data.samples,
    ...(history ? { history } : {}),
    ...(authority ? { server: authority } : {}),
    ...(build ? { build } : {}),
    source,
    contentHash: createHash('sha256')
      .update(await readFile('src/experiments/out-west/content/manifest.ts'))
      .digest('hex'),
    scripts: scriptHashes,
    stress: population === 'stress',
    start: first,
    end: last,
  })
  const qualified = problems.length === 0 && fixtureProblems.length === 0
  const target = timing ? frameTarget(timing, 'desktop') : null
  let performanceTarget = 'unqualified'
  if (qualified && target) {
    performanceTarget = target.passed ? 'pass' : 'fail'
  }
  const report = {
    source,
    dirty: dirty.trim().length > 0,
    endDirty: Boolean(endDirty),
    endSource: revision(),
    host: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model },
    browserPid,
    browserVersion,
    surface: headless ? 'headless-chrome' : 'visible-chrome',
    physicalDevice: false,
    populationScenario: population,
    requestedSeconds: seconds,
    recordingClass: problems.length === 0 ? 'foreground-production-recording' : 'diagnostic',
    qualification: qualified ? 'complete' : 'incomplete',
    performanceTarget,
    target,
    outstandingEvidence: fixtureProblems,
    build,
    authority,
    history,
    problems,
    errors,
    timing,
    scriptHashes,
    foreground,
    foregroundCoverage: coverage,
    recording: data,
    preparation: fixture?.preparation,
  }
  await writeFile(join(output, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    JSON.stringify(
      {
        output,
        recordingClass: report.recordingClass,
        fps: timing?.fps,
        frameMs: timing?.frameMs,
        performanceTarget: report.performanceTarget,
        problems,
      },
      null,
      2,
    ),
  )
  if (visible) {
    process.exitCode = frameRecordingExitCode(report.qualification, report.performanceTarget)
  }
} finally {
  sidecar?.kill()
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      await page
        .evaluate(() => Reflect.get(globalThis, '__owQaPrivacy')?.restoreSettings())
        .catch(() => undefined)
    }
  }
  await browser.close()
}
