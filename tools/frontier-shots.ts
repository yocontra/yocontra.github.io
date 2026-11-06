// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: the town streams in; settle waits are deliberate
/**
 * Eye-level and overview screenshots of Perdition, in real Chrome against a running dev server.
 *
 *   bun --bun astro dev --port 4376 --ignore-lock     # in another shell
 *   bun tools/frontier-shots.ts [baseUrl] [--out=dir] [--only=name,name] [--tier=high|floor]
 *
 * Like `tools/float-audit.ts`, it captures the three.js scene through the `__THREE_DEVTOOLS__`
 * hook (no game code involved) and renders it from free cameras with the dev-only `snapshot`
 * helper in `scene/float-audit.ts`: a walk at eye height (1.6 m) down every street and alley,
 * and high overviews. Views come from `FRONTIER_VIEWS` in `ffa/town.views.ts`, so they follow
 * the layout.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FRONTIER_VIEWS } from '../src/experiments/out-west/ffa/town.views.ts'

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4376'
const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null
const out = arg('out') ?? '.playwright-mcp/frontier-shots'
const only = arg('only')?.split(',') ?? null
const tier = arg('tier') ?? 'high'
const MODULE = '/src/experiments/out-west/scene/float-audit.ts'

interface Page {
  goto: (url: string) => Promise<unknown>
  on: (event: 'pageerror', cb: (e: Error) => void) => void
  addInitScript: (fn: () => void) => Promise<void>
  waitForFunction: (fn: () => boolean, arg: undefined, o: { timeout: number }) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
  evaluate: <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>
}
interface Pw {
  chromium: {
    launch: (o: { channel: string; args: string[] }) => Promise<{
      newPage: (o: { viewport: { width: number; height: number } }) => Promise<Page>
      close: () => Promise<void>
    }>
  }
}
const { chromium } = (await import(process.env.PLAYWRIGHT ?? 'playwright')) as Pw

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (e) => console.error(`page error: ${e.message}`))
await page.addInitScript(() => {
  const g = globalThis as unknown as Record<string, unknown>
  const hook = new EventTarget()
  const found: unknown[] = []
  const renderers: unknown[] = []
  g.owShotScenes = found
  g.owShotRenderers = renderers
  hook.addEventListener('observe', (e) => {
    const d = (e as CustomEvent<{ isScene?: boolean; isWebGLRenderer?: boolean }>).detail
    if (d.isScene) {
      found.push(d)
    } else if (d.isWebGLRenderer) {
      renderers.push(d)
    }
  })
  Reflect.set(g, '__THREE_DEVTOOLS__', hook)
})
await page.goto(`${base}/experiments/out-west/frontier/?bots=0#tier=${tier}`)
await page.waitForFunction(
  () =>
    (
      (globalThis as unknown as { owShotScenes?: { children: unknown[] }[] }).owShotScenes ?? []
    ).some((s) => s.children.length > 4),
  undefined,
  { timeout: 120_000 },
)
await page.waitForTimeout(8000)
mkdirSync(out, { recursive: true })
for (const v of FRONTIER_VIEWS) {
  if (only && !only.includes(v.name)) {
    continue
  }
  const url = await page.evaluate(
    async ([mod, f, t, fov]) => {
      const m = (await import(
        /* @vite-ignore */ mod as string
      )) as typeof import('../src/experiments/out-west/scene/float-audit.ts')
      const g = globalThis as unknown as {
        owShotScenes: import('three').Object3D[]
        owShotRenderers: import('three').WebGLRenderer[]
      }
      const r = g.owShotRenderers.at(-1)
      const s = g.owShotScenes.reduce((a, b) => (b.children.length > a.children.length ? b : a))
      if (!r) {
        return ''
      }
      const from = f as [number, number, number]
      const to = t as [number, number, number]
      // the first render lets the town pick its detail for this camera; the second is the shot
      m.snapshot(r, s, from, to, fov as number)
      return m.snapshot(r, s, from, to, fov as number)
    },
    [MODULE, v.from, v.to, v.fov ?? 62] as const,
  )
  if (url) {
    writeFileSync(
      join(out, `${v.name}.png`),
      Buffer.from(url.replace(/^data:image\/png;base64,/u, ''), 'base64'),
    )
    console.log(`${v.name}.png`)
  }
}
await browser.close()
