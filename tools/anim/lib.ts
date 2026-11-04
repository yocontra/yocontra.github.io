// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
/** The animation audit's shared pieces (tools/anim-audit.ts): options, measures, judging, sheets. */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { file as bunFile, serve, spawnSync } from 'bun'
// biome-ignore lint/correctness/noUnresolvedImports: playwright's CommonJS re-exports are invisible to Biome
import type { CDPSession, Page } from 'playwright'
import sharp from 'sharp'

export const opt = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
export const port = Number(opt('port', '4403'))
export const baseArg = opt('base', '')
export const only = opt('only', '')
export const skip = new Set(opt('skip', '').split(',').filter(Boolean))
export const OUT = opt('out', '.playwright-mcp/anim-audit')
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface Measure {
  i: number
  label: string
  shown: boolean
  clips: { name: string; w: number }[]
  layers: string[]
  poseWeight: number
  bind: number
  idle: number
  idleBone: string
  hipsDy: number
  scene: string
  yaw: number
  pos: [number, number, number]
  q: number[]
}

export interface Row {
  section: string
  state: string
  actor: string
  ok: boolean
  checks: Record<string, boolean>
  clips: string[]
  layers: string[]
  bind: number
  idle: number
  motion: number
  hipsDy: number
  yaw: number
  frames: string
}

export const rows: Row[] = []

/** The prod build with the harness hooks kept, served static (`/path/` → `/path/index.html`). */
export function serveProd(build: boolean): () => void {
  const root = new URL('../../', import.meta.url).pathname
  const out = join(tmpdir(), 'anim-audit-dist')
  if (build) {
    console.log('building the production site (harness hooks on)…')
    const b = spawnSync(['bun', '--bun', 'astro', 'build', '--outDir', out], {
      cwd: root,
      env: { ...process.env, PUBLIC_OW_PERF_HARNESS: '1' },
      stdout: 'ignore',
      stderr: 'inherit',
    })
    if (b.exitCode !== 0) {
      throw new Error(`build failed (${b.exitCode})`)
    }
  }
  const server = serve({
    port,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname)
      if (path.includes('..')) {
        return new Response('bad path', { status: 400 })
      }
      for (const p of [path, `${path}/index.html`, `${path}index.html`]) {
        const f = bunFile(`${out}${p}`)
        // biome-ignore lint/performance/noAwaitInLoops: the first path that exists wins
        if (!p.endsWith('/') && (await f.exists())) {
          return new Response(f)
        }
      }
      return new Response('not found', { status: 404 })
    },
  })
  console.log(`prod preview on http://localhost:${port}`)
  return () => server.stop(true)
}

const DEG = 180 / Math.PI
/** Largest key-bone angle between two samples (degrees). */
export function qDelta(a: number[], b: number[]): number {
  let m = 0
  for (let k = 0; k + 3 < a.length; k += 4) {
    const dot = Math.abs(
      (a[k] ?? 0) * (b[k] ?? 0) +
        (a[k + 1] ?? 0) * (b[k + 1] ?? 0) +
        (a[k + 2] ?? 0) * (b[k + 2] ?? 0) +
        (a[k + 3] ?? 1) * (b[k + 3] ?? 1),
    )
    m = Math.max(m, 2 * Math.acos(Math.min(1, dot)) * DEG)
  }
  return m
}
/** Largest bone motion across a sequence (any two samples). */
export function motionOf(ms: Measure[]): number {
  let m = 0
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      m = Math.max(m, qDelta(ms[i]?.q ?? [], ms[j]?.q ?? []))
    }
  }
  return m
}

export const tposes = (page: Page): Promise<number> =>
  page.evaluate(() => Number(Reflect.get(globalThis, '__owTPose') ?? 0))

export const frameDone = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((r) => {
        requestAnimationFrame(() => requestAnimationFrame(() => r()))
      }),
  )

/** Tile a state's frames into one sheet (4 across). */
export async function sheet(dir: string, frames: Buffer[]): Promise<void> {
  if (frames.length === 0) {
    return
  }
  const w = 360
  const h = 203
  const cols = Math.min(4, frames.length)
  const rowsN = Math.ceil(frames.length / cols)
  const tiles = await Promise.all(
    frames.map((f) => sharp(f).resize(w, h, { fit: 'cover' }).png().toBuffer()),
  )
  await sharp({
    create: { width: w * cols, height: h * rowsN, channels: 3, background: '#111' },
  })
    .composite(
      tiles.map((t, k) => ({ input: t, left: (k % cols) * w, top: Math.floor(k / cols) * h })),
    )
    .png()
    .toFile(join(dir, 'sheet.png'))
}

/**
 * What a state must show beyond "posed": `moves` (bones move between frames by more than this many
 * degrees), `offIdle` (some key bone leaves his idle by more than this), `turns` (his root yaw
 * swings by more than this many radians), `clip` (this clip poses him at some point), `layer` (a
 * procedural layer whose name starts with this is on at some point), `drops` (hips go lower than
 * this, metres).
 */
export interface Expect {
  moves?: number
  offIdle?: number
  turns?: number
  clip?: string
  layer?: string
  drops?: number
}

/** Each lineup state's evidence bar (duel/anim-stage.ts names them). */
/** Judge one state's samples against the bar; `t0` is the T-pose count before it. */
export function judge(ms: Measure[], ex: Expect, tp: number): Record<string, boolean> {
  const c: Record<string, boolean> = {
    posed: ms.every((m) => m.poseWeight > 0.5 && m.bind > 3),
    tpose: tp === 0,
  }
  if (ex.moves !== undefined) {
    c.moves = motionOf(ms) > ex.moves
  }
  if (ex.offIdle !== undefined) {
    c.offIdle = Math.max(...ms.map((m) => m.idle)) > ex.offIdle
  }
  if (ex.turns !== undefined) {
    const ys = ms.map((m) => m.yaw)
    c.turns = Math.max(...ys) - Math.min(...ys) > ex.turns
  }
  const clip = ex.clip
  if (clip) {
    const names = clip.split('|')
    c.clip = ms.some((m) => m.clips.some((k) => names.includes(k.name) && k.w > 0.2))
  }
  const layer = ex.layer
  if (layer) {
    c.layer = ms.some((m) => m.layers.some((l) => l.startsWith(layer)))
  }
  if (ex.drops !== undefined) {
    const d = ex.drops
    c.drops = ms.some((m) => m.hipsDy < d)
  }
  return c
}

export function record(r: {
  section: string
  state: string
  ms: Measure[]
  checks: Record<string, boolean>
  dir: string
}): void {
  const { section, state, ms, checks, dir } = r
  const uniq = (xs: string[]) => [...new Set(xs)]
  const row: Row = {
    section,
    state,
    actor: ms[0]?.label ?? '?',
    ok: Object.values(checks).every(Boolean),
    checks,
    clips: uniq(ms.flatMap((m) => m.clips.filter((k) => k.w > 0.2).map((k) => k.name))),
    layers: uniq(ms.flatMap((m) => m.layers)),
    bind: Math.round(Math.min(...ms.map((m) => m.bind)) * 10) / 10,
    idle: Math.round(Math.max(...ms.map((m) => m.idle)) * 10) / 10,
    motion: Math.round(motionOf(ms) * 10) / 10,
    hipsDy: Math.round(Math.min(...ms.map((m) => m.hipsDy)) * 100) / 100,
    yaw:
      Math.round((Math.max(...ms.map((m) => m.yaw)) - Math.min(...ms.map((m) => m.yaw))) * 100) /
      100,
    frames: dir,
  }
  rows.push(row)
  const bad = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k)
  console.log(
    `${row.ok ? 'ok  ' : 'FAIL'} ${section}/${state.padEnd(24)} clips=${row.clips.join('+') || '-'} layers=${
      row.layers.join('+') || '-'
    } idleΔ=${row.idle}° motion=${row.motion}° bind=${row.bind}°${bad.length > 0 ? `  ✗ ${bad.join(',')}` : ''}`,
  )
}

export const all = (page: Page): Promise<Measure[]> =>
  page.evaluate(() => (Reflect.get(globalThis, '__owAnim') as { actors: () => Measure[] }).actors())

export const label = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const f = Reflect.get(globalThis, '__owPerfLabel') as (() => string) | undefined
    return f ? f() : ''
  })

export const touch = (cdp: CDPSession, type: 'touchStart' | 'touchEnd', x: number, y: number) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
  })

/** The phase's live expectations: (duellist samples) → checks. */
