/** Builds a local release-engine QA fixture, with preboot recording available to Safari too. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { frameRecorderSource } from './content/frame-recorder.ts'
import { localFixtureURL } from './content/production-fixture.ts'
import { simulatorHost } from './content/simulator-host.ts'
import { createSimulatorCoordinates } from './content/simulator-page-coordinates.ts'
import { installSimulatorRecorder, simulatorScriptHashes } from './content/simulator-recorder.ts'

const arg = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const port = Number(arg('port', '4398'))
const directory = resolve(arg('out', join(tmpdir(), 'out-west-production-recording')))
const publicBuild = process.argv.includes('--public')
const api = arg('api', 'http://127.0.0.1:8798')
localFixtureURL(api)
const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim()
const dirty = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'])
  .stdout.toString()
  .trim()
await mkdir(directory, { recursive: true })
const build = Bun.spawn(['bun', '--bun', 'astro', 'build', '--outDir', directory], {
  env: {
    ...process.env,
    PUBLIC_OW_PERF_HARNESS: publicBuild ? '' : '1',
    ...(publicBuild ? {} : { PUBLIC_TURNSTILE_SITEKEY: '1x00000000000000000000BB' }),
  },
  stdout: 'inherit',
  stderr: 'inherit',
})
if ((await build.exited) !== 0) {
  throw new Error('Production recording build failed')
}
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const scripts: { path: string; sha256: string }[] = []
const engineSources = new Set<string>()
let qaSurface = false
for await (const path of new Bun.Glob('**/*.{js,map}').scan({ cwd: directory })) {
  const contents = await readFile(join(directory, path), 'utf8')
  if (path.endsWith('.js')) {
    scripts.push({ path: `/${path}`, sha256: digest(contents) })
    qaSurface ||= contents.includes('__owPerformanceSnapshot')
    if (publicBuild && contents.includes('backBufferSamples')) {
      throw new Error('Public bundle retained QA render-target diagnostics')
    }
    if (
      [
        '__playcanvasFrontier',
        '__nativeFrontierSession',
        ...(publicBuild ? ['__owQaAccount'] : []),
      ].some((name) => contents.includes(name))
    ) {
      throw new Error('Production build retained mutable DEV globals')
    }
  } else {
    const map = JSON.parse(contents) as { sources?: string[] }
    for (const name of map.sources ?? []) {
      if (name.includes('/playcanvas/build/')) {
        engineSources.add(name)
      }
    }
  }
}
if (qaSurface === publicBuild) {
  throw new Error('QA read-only surface did not match the explicit build flag')
}
const releaseEngine =
  engineSources.size > 0 &&
  [...engineSources].every((path) => path.includes('/playcanvas/build/playcanvas/src/'))
if (!(publicBuild || releaseEngine)) {
  throw new Error('Hidden source maps did not prove release-engine resolution')
}
const endSource = Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim()
const endDirty = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'])
  .stdout.toString()
  .trim()
const receipt = {
  source,
  endSource,
  dirty: Boolean(dirty || endDirty),
  qaFlag: !publicBuild,
  localTestTurnstile: !publicBuild,
  builtAt: new Date().toISOString(),
  releaseEngine,
  engineSources: [...engineSources].sort((a, b) => a.localeCompare(b)),
  contentManifestSha256: digest(await readFile('src/experiments/out-west/content/manifest.ts')),
  scripts: scripts.sort((a, b) => a.path.localeCompare(b.path)),
}
await writeFile(join(directory, 'recording-build.json'), `${JSON.stringify(receipt, null, 2)}\n`)
if (process.argv.includes('--build-only')) {
  process.exit(0)
}
const recorder = frameRecorderSource()
const controller = `(${installSimulatorRecorder.toString()})((${createSimulatorCoordinates.toString()}),(${simulatorScriptHashes.toString()}))`
const simulator = simulatorHost(api, directory, receipt)
Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname)
    if (path.startsWith('/__qa/') && publicBuild) {
      return new Response('Not found', { status: 404 })
    }
    const handled = await simulator(request)
    if (handled) {
      return handled
    }
    if (path === '/__qa/controller.js') {
      return new Response(controller, { headers: { 'content-type': 'text/javascript' } })
    }
    if (path === '/__qa/recorder.js') {
      return new Response(recorder, { headers: { 'content-type': 'text/javascript' } })
    }
    if (path.includes('..')) {
      return new Response('Invalid path', { status: 400 })
    }
    for (const candidate of [path, `${path}/index.html`, `${path}index.html`]) {
      const file = Bun.file(join(directory, candidate))
      if (candidate.endsWith('/') || !(await file.exists())) {
        continue
      }
      if (!publicBuild && candidate.endsWith('.html')) {
        const html = (await file.text()).replace(
          '<head>',
          '<head><script src="/__qa/recorder.js"></script><script src="/__qa/controller.js"></script>',
        )
        return new Response(html, { headers: { 'content-type': 'text/html' } })
      }
      return new Response(file)
    }
    return new Response('Not found', { status: 404 })
  },
})
console.log(`Production ${publicBuild ? 'public' : 'QA'} fixture: http://127.0.0.1:${port}`)
