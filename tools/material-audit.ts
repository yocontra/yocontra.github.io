// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: the town streams in; settle waits are deliberate
// biome-ignore-all lint/style/noNestedTernary: short label picks in a CLI report
/**
 * Material audit for both out west scenes (the duel street with the whole cast in the lineup, and
 * Frontier) at each tier, in real Chrome against a running dev server.
 *
 *   bun --bun astro dev --port 4396 --ignore-lock       # in another shell
 *   bun tools/material-audit.ts [baseUrl] [--scene=duel|frontier] [--tier=high|low] [--json]
 *     [--all]   (also print rows with no issues and fewer than 200 triangles)
 *
 * Like `tools/float-audit.ts` it captures the scenes through the `__THREE_DEVTOOLS__` hook and
 * imports `scene/material-audit.ts` into the page. One table per scene and tier: every material
 * with its type (`+` = a shader patch through onBeforeCompile), maps and colour spaces (map,
 * normal × normalScale, roughness, metalness, AO), roughness / metalness, environment light
 * (`scene` = scene.environment, the town probe) × envMapIntensity, shadow cast / receive, side,
 * vertex normals, and the problems found. Then the lights and the environment. Exit code 1 when
 * any material has an issue.
 */
import type { MaterialReport, MatRow } from '../src/experiments/out-west/scene/material-audit.ts'

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4396'
const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null
/** The duel is audited in every arena (`duel` is the street; `duel:depot` and so on, scene/arenas). */
const DUEL_ARENAS = ['duel', 'duel:depot', 'duel:mission', 'duel:bank']
const scenes = (arg('scene') ? [arg('scene') as string] : ['duel', 'frontier']).flatMap((s) =>
  s === 'duel' ? DUEL_ARENAS : [s],
)
/** `#arena=` for a duel scene (the street when none). */
const arenaHash = (scene: string): string => `&arena=${scene.split(':')[1] ?? 'street'}`
const tiers = arg('tier') ? [arg('tier') as string] : ['high', 'low']
const json = process.argv.includes('--json')
const all = process.argv.includes('--all')
const MODULE = '/src/experiments/out-west/scene/material-audit.ts'

interface Page {
  goto: (url: string) => Promise<unknown>
  on: (event: 'pageerror', cb: (e: Error) => void) => void
  addInitScript: (fn: () => void) => Promise<void>
  waitForFunction: (fn: () => boolean, arg: undefined, o: { timeout: number }) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
  evaluate: <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>
  close: () => Promise<void>
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

const TONE = ['None', 'Linear', 'Reinhard', 'Cineon', 'ACES', 'Custom', 'AgX', 'Neutral']

function row(r: MatRow): string {
  const type = `${r.type}${r.patched ? '+' : ''}`
  const kind = r.skinned ? `${r.meshes} sk` : r.instanced ? `${r.meshes} in` : `${r.meshes}`
  const rm =
    r.roughness === null ? '-' : `${r.roughness.toFixed(2)}/${(r.metalness ?? 0).toFixed(2)}`
  const sh = `${r.cast.toFixed(1)}/${r.receive.toFixed(1)}`
  return `| ${r.name} | ${type} | ${kind} | ${r.tris} | ${r.map} | ${r.normal} | ${r.rough} | ${r.metal} | ${r.ao} | ${rm} | ${r.env} | ${sh} | ${r.side} | ${r.normals} | ${r.issues.join('; ') || 'ok'} |`
}

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] })
let failing = 0
const out: Record<string, MaterialReport> = {}
for (const scene of scenes) {
  for (const tier of tiers) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    page.on('pageerror', (e) => console.error(`[${scene}/${tier}] page error: ${e.message}`))
    await page.addInitScript(() => {
      const g = globalThis as unknown as Record<string, unknown>
      const hook = new EventTarget()
      const found: unknown[] = []
      const renderers: unknown[] = []
      g.owAuditScenes = found
      g.owAuditRenderers = renderers
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
    const url = scene.startsWith('duel')
      ? `${base}/experiments/out-west/#lineup&day=0.45&tier=${tier}${arenaHash(scene)}`
      : `${base}/experiments/out-west/frontier/?bots=8&seed=7#tier=${tier === 'low' ? 'floor' : 'high'}`
    await page.goto(url)
    await page.waitForFunction(
      () => {
        const list = (globalThis as unknown as { owAuditScenes?: { children: unknown[] }[] })
          .owAuditScenes
        return (list ?? []).some((s) => s.children.length > 4)
      },
      undefined,
      { timeout: 120_000 },
    )
    await page.waitForTimeout(scene.startsWith('duel') ? 9000 : 12_000)
    const report = await page.evaluate(async (mod) => {
      const m = (await import(
        /* @vite-ignore */ mod
      )) as typeof import('../src/experiments/out-west/scene/material-audit.ts')
      const g = globalThis as unknown as {
        owAuditScenes: import('three').Object3D[]
        owAuditRenderers: import('three').WebGLRenderer[]
      }
      return m.auditMaterials(g.owAuditScenes, g.owAuditRenderers.at(0))
    }, MODULE)
    out[`${scene}/${tier}`] = report
    const bad = report.rows.filter((r) => r.issues.length > 0)
    failing += bad.length
    if (!json) {
      console.log(
        `\n## ${scene} / ${tier}: ${report.rows.length} materials, ${bad.length} with issues; environment ${report.environment}; renderer tone ${TONE[report.toneMapping] ?? report.toneMapping} (post does AgX)\n`,
      )
      console.log(
        '| material | type | meshes | tris | map | normal | rough | metal | ao | r/m | env | cast/recv | side | normals | issues |',
      )
      console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
      for (const r of report.rows) {
        if (all || r.issues.length > 0 || r.tris >= 200) {
          console.log(row(r))
        }
      }
      console.log('\n| light | name | intensity | colour | shadow |\n|---|---|---|---|---|')
      const seen = new Map<string, number>()
      for (const l of report.lights) {
        const k = `${l.type}|${l.name}|${l.intensity.toFixed(2)}|${l.color}|${l.shadow}`
        seen.set(k, (seen.get(k) ?? 0) + 1)
      }
      for (const [k, n] of seen) {
        const [type, name, i, c, s] = k.split('|')
        console.log(`| ${type}${n > 1 ? ` ×${n}` : ''} | ${name} | ${i} | ${c} | ${s} |`)
      }
    }
    await page.close()
  }
}
await browser.close()
if (json) {
  console.log(JSON.stringify(out, null, 2))
}
process.exit(failing > 0 ? 1 : 0)
