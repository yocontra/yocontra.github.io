// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one linear audit script
// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: the town streams in; settle waits are deliberate
/**
 * Floating-object audit for both out west scenes, in real Chrome against a running dev server.
 *
 *   bun run dev --port 4365            # in another shell
 *   bun tools/float-audit.ts [baseUrl] [--scene=duel|frontier] [--tier=high|low] [--shots=dir] [--json]
 *
 * It captures the three.js scene through the `__THREE_DEVTOOLS__` hook (no game code involved),
 * imports `scene/float-audit.ts` into the page from the dev server, and prints every piece whose
 * foot is more than 3 cm above its support and isn't touching anything, every kit facade piece
 * standing more than 2 cm off its wall, props sunk into a deck, and coplanar z-fighting faces.
 * Hanging pieces (lanterns, pickups, money bags) are listed with their mount distance. `--shots`
 * also saves low-angle views along every frontage. It also lists every lit mesh drawn untextured
 * (no colour map and no procedural surface; glass, water, sky and effects excepted). Exit code 1
 * when any float/loose issue or untextured mesh remains.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AuditIssue, AuditReport } from '../src/experiments/out-west/scene/float-audit.ts'

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4365'
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
const shots = arg('shots')
const json = process.argv.includes('--json')

const MODULE = '/src/experiments/out-west/scene/float-audit.ts'

/** The slice of Playwright used here (resolved from PLAYWRIGHT, else the repo's devDependency). */
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

type View = [string, [number, number, number], [number, number, number]]

/** Low-angle views at every class of contact the audit checks, duel street. */
function duelViews(): View[] {
  return [
    ['duel-frontage-right', [6, 0.7, -16], [11, 1.2, -6]],
    ['duel-frontage-left', [-6, 0.7, 12], [-11, 1.2, 2]],
    ['duel-doors', [7.5, 1.3, -8], [11.2, 1.0, -10.5]],
    ['duel-coffins', [-6.5, 1.0, -3], [-11, 0.6, -10]],
    ['duel-gap-barrels', [7, 0.8, -25], [10, 0.4, -27.5]],
    ['duel-gap-lantern', [6.5, 2.2, 5], [9.4, 2.7, 9]],
    ['duel-hay-livery', [5, 1.0, -38], [8.5, 0.5, -43]],
    ['duel-cart', [-3.5, 1.4, -26], [-7.6, 0.6, -30]],
    ['duel-fence', [17, 1.2, -40], [22, 0.4, -46]],
    ['duel-porch-posts', [7.2, 0.6, 3], [9.15, 1.6, 9.8]],
    ['duel-rocks', [20, 2, 6], [30, 1, 14]],
  ]
}

/** The same in Frontier (layout metres; the square is around (72, 66)). */
function frontierViews(): View[] {
  return [
    ['frontier-hay', [16, 1.5, 26], [13, 0.4, 31]],
    ['frontier-bridge', [64, 1.2, 14], [72, 0.3, 7.5]],
    ['frontier-creek-rocks', [40, 1.6, 18], [48, 0.2, 12.5]],
    ['frontier-porch', [12, 1.8, 80], [13, 1.2, 74]],
    ['frontier-roof-sign', [56, 12, 52], [56.5, 8, 44]],
    ['frontier-trim', [118, 6, 30], [117, 7.5, 34]],
    ['frontier-crates', [70.8, 1.6, 21], [70.8, 0.4, 24.8]],
    ['frontier-wagon', [50, 2.5, 60], [56, 0.5, 66]],
    ['frontier-scrub', [-6, 2, 40], [-14, 0.3, 30]],
    ['frontier-pickup', [123, 1.6, 34], [126, 0.8, 38]],
  ]
}

/** The low-angle views for a scene (the arenas have none of their own yet: their audit is the list). */
function viewsFor(scene: string): View[] {
  if (scene === 'frontier') {
    return frontierViews()
  }
  return scene === 'duel' ? duelViews() : []
}

async function open(page: Page, scene: string, tier: string): Promise<void> {
  const url = scene.startsWith('duel')
    ? `${base}/experiments/out-west/#lineup&day=0.3&tier=${tier}${arenaHash(scene)}`
    : `${base}/experiments/out-west/frontier/?bots=0#tier=${tier === 'low' ? 'floor' : 'high'}`
  await page.goto(url)
  // the town is built once the biggest captured scene stops growing
  await page.waitForFunction(
    () => {
      const list = (globalThis as unknown as { owAuditScenes?: { children: unknown[] }[] })
        .owAuditScenes
      return (list ?? []).some((s) => s.children.length > 4)
    },
    undefined,
    { timeout: 120_000 },
  )
  await page.waitForTimeout(scene.startsWith('duel') ? 6000 : 8000)
}

function line(i: AuditIssue): string {
  const at = i.at.map((n) => n.toFixed(2)).join(', ')
  const sz = i.size.map((n) => n.toFixed(2)).join('x')
  const extra =
    i.kind === 'zfight'
      ? `with ${i.other}`
      : `gap ${i.gap === Number.POSITIVE_INFINITY ? 'void' : i.gap.toFixed(3)} contact ${Number.isFinite(i.contact) ? i.contact.toFixed(3) : 'none'}${i.other ? ` (${i.other})` : ''}`
  return `  ${i.kind.padEnd(6)} ${i.name.padEnd(16)} ${i.mesh.padEnd(10)} at (${at}) ${sz}  ${extra}`
}

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] })
let failing = 0
const all: Record<string, AuditReport> = {}
for (const scene of scenes) {
  for (const tier of tiers) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
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
      // three.js announces every Scene and renderer to this hook when it exists
      Reflect.set(g, '__THREE_DEVTOOLS__', hook)
    })
    await open(page, scene, tier)
    const report = await page.evaluate(async (mod) => {
      const m = (await import(
        /* @vite-ignore */ mod
      )) as typeof import('../src/experiments/out-west/scene/float-audit.ts')
      const g = globalThis as unknown as { owAuditScenes: import('three').Object3D[] }
      let best = g.owAuditScenes[0]
      let most = -1
      for (const s of g.owAuditScenes) {
        let n = 0
        s.traverse(() => {
          n++
        })
        if (n > most) {
          most = n
          best = s
        }
      }
      if (!best) {
        throw new Error('no scene captured')
      }
      const r = m.auditScene(best)
      // JSON can't carry Infinity
      return JSON.parse(
        JSON.stringify(r, (_k, v: unknown) => (v === Number.POSITIVE_INFINITY ? 1e9 : v)),
      ) as AuditReport
    }, MODULE)
    for (const i of report.issues) {
      i.gap = i.gap >= 1e9 ? Number.POSITIVE_INFINITY : i.gap
      i.contact = i.contact >= 1e9 ? Number.POSITIVE_INFINITY : i.contact
    }
    const flat = await page.evaluate(async (mod) => {
      const m = (await import(
        /* @vite-ignore */ mod
      )) as typeof import('../src/experiments/out-west/scene/float-audit.ts')
      const g = globalThis as unknown as { owAuditScenes: import('three').Object3D[] }
      return g.owAuditScenes.flatMap((sc) => m.textureAudit(sc))
    }, MODULE)
    failing += flat.length
    if (!json) {
      console.log(`   untextured ${flat.length}`)
      for (const u of flat) {
        console.log(
          `  flat   ${u.mesh.padEnd(28)} ${u.material.padEnd(14)} #${u.color} ${u.triangles} tris`,
        )
      }
    }
    all[`${scene}/${tier}`] = report
    const by = (k: AuditIssue['kind']) => report.issues.filter((i) => i.kind === k)
    const bad = by('float').length + by('loose').length
    failing += bad
    if (!json) {
      console.log(
        `\n== ${scene} / ${tier}: ${report.pieces} pieces, ${report.triangles} tris, ${report.ms} ms`,
      )
      console.log(
        `   float ${by('float').length}  loose ${by('loose').length}  sunk ${by('sunk').length}  zfight ${by('zfight').length}  hanging ${report.allowed.length}`,
      )
      for (const i of report.issues) {
        console.log(line(i))
      }
      for (const a of report.allowed) {
        if (a.mount > 0.03) {
          console.log(
            `  hangs  ${a.name.padEnd(16)} at (${a.at.join(', ')}) mount ${a.mount === 1e9 ? 'none' : a.mount}`,
          )
        }
      }
    }
    if (shots) {
      mkdirSync(shots, { recursive: true })
      const views = viewsFor(scene)
      for (const [name, from, to] of views) {
        const url = await page.evaluate(
          async ([mod, f, t]) => {
            const m = (await import(
              /* @vite-ignore */ mod as string
            )) as typeof import('../src/experiments/out-west/scene/float-audit.ts')
            const g = globalThis as unknown as {
              owAuditScenes: import('three').Object3D[]
              owAuditRenderers: import('three').WebGLRenderer[]
            }
            const r = g.owAuditRenderers.at(-1)
            const s = g.owAuditScenes.reduce((a, b) =>
              b.children.length > a.children.length ? b : a,
            )
            return r
              ? m.snapshot(r, s, f as [number, number, number], t as [number, number, number])
              : ''
          },
          [MODULE, from, to] as const,
        )
        if (url) {
          writeFileSync(
            join(shots, `${name}-${tier}.png`),
            Buffer.from(url.replace(/^data:image\/png;base64,/u, ''), 'base64'),
          )
        }
      }
    }
    await page.close()
  }
}
await browser.close()
if (json) {
  console.log(JSON.stringify(all, null, 2))
}
process.exit(failing > 0 ? 1 : 0)
