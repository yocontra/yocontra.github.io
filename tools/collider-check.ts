// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: the town streams in; settle waits are deliberate
/**
 * Collider-vs-visual check for Perdition, in real Chrome against a running dev server.
 *
 *   bun --bun astro dev --port 4376 --ignore-lock     # in another shell
 *   bun tools/collider-check.ts [baseUrl] [--json]
 *
 * Builds the Frontier town in the page, imports `ffa/scene/collider-audit.ts` from the dev server
 * and compares what you can see with what blocks you on the server's collision grid: invisible
 * walls (blocked cells with nothing drawn there) and walk-through props (something drawn at body
 * height with no collider under it). Exit code 1 on any mismatch.
 */
import process from 'node:process'
import type { ColliderReport } from '../src/experiments/out-west/ffa/scene/collider-audit.ts'

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4376'
const json = process.argv.includes('--json')
const MODULE = '/src/experiments/out-west/ffa/scene/collider-audit.ts'

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
  g.owAuditScenes = found
  hook.addEventListener('observe', (e) => {
    const d = (e as CustomEvent<{ isScene?: boolean }>).detail
    if (d.isScene) {
      found.push(d)
    }
  })
  Reflect.set(g, '__THREE_DEVTOOLS__', hook)
})
await page.goto(`${base}/experiments/out-west/frontier/?bots=0#tier=high`)
await page.waitForFunction(
  () =>
    (
      (globalThis as unknown as { owAuditScenes?: { children: unknown[] }[] }).owAuditScenes ?? []
    ).some((s) => s.children.length > 4),
  undefined,
  { timeout: 120_000 },
)
await page.waitForTimeout(6000)
const report = await page.evaluate(async (mod) => {
  const m = (await import(
    /* @vite-ignore */ mod
  )) as typeof import('../src/experiments/out-west/ffa/scene/collider-audit.ts')
  const g = globalThis as unknown as { owAuditScenes: import('three').Object3D[] }
  const s = g.owAuditScenes.reduce((a, b) => (b.children.length > a.children.length ? b : a))
  return m.colliderAudit(s)
}, MODULE)
await browser.close()
const r = report as ColliderReport
if (json) {
  console.log(JSON.stringify(r, null, 2))
} else {
  const inv = r.blobs.filter((b) => b.kind === 'invisible')
  const walk = r.blobs.filter((b) => b.kind === 'walkthrough')
  console.log(
    `Perdition collider check: ${r.checked}/${r.pieces} pieces at body height, ${r.blocked} blocked cells, ${r.visual} visual cells`,
  )
  console.log(`  invisible walls ${inv.length}  walk-through visuals ${walk.length}`)
  for (const b of r.blobs) {
    console.log(
      `  ${b.kind.padEnd(11)} (${b.at[0]}, ${b.at[1]}) ${String(b.cells).padStart(4)} cells  ${b.near.join(', ')}`,
    )
  }
}
process.exit(r.blobs.length > 0 ? 1 : 0)
