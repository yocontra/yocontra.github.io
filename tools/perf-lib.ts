// biome-ignore-all lint/suspicious/noConsole: CLI harness helpers report to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: source maps load one after another
/**
 * Shared pieces of the perf harnesses (tools/frontier-perf.ts, tools/perf-suite.ts): the
 * production build served statically, the floor-device phone emulation, a per-frame CPU sampler
 * and a CPU profile summarised by source function (through the perf build's hidden source maps).
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { file as bunFile, serve, spawnSync } from 'bun'
// biome-ignore lint/correctness/noUnresolvedImports: playwright's CommonJS re-exports are invisible to Biome
import type { CDPSession } from 'playwright'

/** Base64 digit values for source-map VLQs. */
const B64 = new Map(
  (
    [
      [65, 26], // A–Z
      [97, 26], // a–z
      [48, 10], // 0–9
      [43, 1], // +
      [47, 1], // /
    ] as const
  )
    .flatMap(([from, n]) => Array.from({ length: n }, (_, k) => String.fromCharCode(from + k)))
    .map((c, i) => [c, i]),
)

/** Source-map content line break. */
const NL = String.fromCharCode(10)

/** Main-thread CPU profile for `ms`: the top self-time and inclusive-time functions, printed. */
export async function profileMain(cdp: CDPSession, ms: number, sourceMaps: boolean): Promise<void> {
  await startProfile(cdp)
  await new Promise((r) => setTimeout(r, ms))
  await stopProfile(cdp, sourceMaps)
}

/** Start the main thread's sampling profiler (`stopProfile` prints it). */
export async function startProfile(cdp: CDPSession): Promise<void> {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
}

/**
 * Stop the profiler and print where the main thread's time went: self and inclusive time by
 * function (production frames resolve through the perf build's hidden source maps).
 */
export async function stopProfile(
  cdp: CDPSession,
  sourceMaps: boolean,
  burstMs = 0,
): Promise<void> {
  const { profile } = (await cdp.send('Profiler.stop')) as {
    profile: {
      nodes: {
        id: number
        callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }
        children?: number[]
      }[]
      samples: number[]
      timeDeltas: number[]
    }
  }
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const maps = new Map<string, SourceMap | null>()
  for (const n of profile.nodes) {
    const u = n.callFrame.url
    if (sourceMaps && u.endsWith('.js') && !maps.has(u)) {
      maps.set(u, await loadMap(u))
    }
  }
  const parent = new Map<number, number>()
  for (const n of profile.nodes) {
    for (const c of n.children ?? []) {
      parent.set(c, n.id)
    }
  }
  const keys = new Map<number, string>()
  const keyOf = (id: number): string => {
    const have = keys.get(id)
    if (have !== undefined) {
      return have
    }
    const f = byId.get(id)?.callFrame
    const m = f ? maps.get(f.url) : undefined
    const at = f && m ? lookup(m, f.lineNumber, f.columnNumber) : null
    const file = (at?.file ?? f?.url ?? '').split('/').pop()?.split('?')[0] ?? ''
    const key = at
      ? `${file}:${at.line + 1}  ${at.text}`
      : `${f?.functionName || '(anon)'} ${file}:${(f?.lineNumber ?? 0) + 1}`
    keys.set(id, key)
    return key
  }
  const self = new Map<string, number>()
  const incl = new Map<string, number>()
  // `burstMs`: each uninterrupted run of main-thread work that long (a long frame), itemised
  const bursts: { us: number; incl: Map<string, number> }[] = []
  let burst = { us: 0, incl: new Map<string, number>() }
  const endBurst = (): void => {
    if (burstMs > 0 && burst.us >= burstMs * 1000) {
      bursts.push(burst)
    }
    burst = { us: 0, incl: new Map<string, number>() }
  }
  let total = 0
  let idle = 0
  for (const [i, id] of profile.samples.entries()) {
    const dt = profile.timeDeltas[i] ?? 0
    total += dt
    const fn = byId.get(id)?.callFrame.functionName
    if (fn === undefined) {
      continue
    }
    if (fn === '(idle)') {
      idle += dt
      endBurst()
      continue
    }
    burst.us += dt
    const key = keyOf(id)
    self.set(key, (self.get(key) ?? 0) + dt)
    const stack = new Set<string>()
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      stack.add(keyOf(at))
    }
    for (const k of stack) {
      incl.set(k, (incl.get(k) ?? 0) + dt)
      burst.incl.set(k, (burst.incl.get(k) ?? 0) + dt)
    }
  }
  endBurst()
  printBursts(bursts)
  const busy = total - idle
  // ms of main thread per displayed frame (60 Hz), at the throttled rate
  const perFrame = (us: number): string => ((us / total) * (1000 / 60)).toFixed(2)
  console.log(
    `  profile (${Math.round(total / 1000)} ms sampled, ${Math.round((busy / total) * 100)}% busy); self time, % of busy and ms per 60 Hz frame:`,
  )
  for (const [k, us] of [...self].sort((x, y) => y[1] - x[1]).slice(0, 30)) {
    console.log(
      `    ${((us / busy) * 100).toFixed(1).padStart(5)}%  ${perFrame(us).padStart(5)}  ${k}`,
    )
  }
  console.log('  inclusive time, ms per 60 Hz frame:')
  for (const [k, us] of [...incl].sort((x, y) => y[1] - x[1]).slice(0, 45)) {
    console.log(`    ${perFrame(us).padStart(5)}  ${k}`)
  }
}

/** Each long run of main-thread work, by inclusive ms per function. */
function printBursts(bursts: readonly { us: number; incl: Map<string, number> }[]): void {
  for (const b of bursts) {
    console.log(`  long burst ${(b.us / 1000).toFixed(1)} ms:`)
    for (const [k, us] of [...b.incl].sort((x, y) => y[1] - x[1]).slice(0, 28)) {
      console.log(`    ${(us / 1000).toFixed(2).padStart(6)}  ${k}`)
    }
  }
}

interface AllocNode {
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }
  selfSize: number
  children: AllocNode[]
}

/**
 * Garbage made per frame, by allocating function: the sampling heap profiler over `ms`, keeping
 * objects GC'd during the run (they are the churn), in KB per 60 Hz frame.
 */
export async function allocProfile(
  cdp: CDPSession,
  ms: number,
  sourceMaps: boolean,
): Promise<void> {
  await cdp.send('HeapProfiler.enable')
  await cdp.send('HeapProfiler.startSampling', {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  })
  await new Promise((r) => setTimeout(r, ms))
  const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as {
    profile: { head: AllocNode }
  }
  const maps = new Map<string, SourceMap | null>()
  const self = new Map<string, number>()
  let total = 0
  const walk = async (n: AllocNode): Promise<void> => {
    const f = n.callFrame
    if (n.selfSize > 0) {
      if (sourceMaps && f.url.endsWith('.js') && !maps.has(f.url)) {
        maps.set(f.url, await loadMap(f.url))
      }
      const m = maps.get(f.url)
      const at = m ? lookup(m, f.lineNumber, f.columnNumber) : null
      const file = (at?.file ?? f.url).split('/').pop()?.split('?')[0] ?? ''
      const key = at
        ? `${file}:${at.line + 1}  ${at.text}`
        : `${f.functionName || '(anon)'} ${file}:${f.lineNumber + 1}`
      self.set(key, (self.get(key) ?? 0) + n.selfSize)
      total += n.selfSize
    }
    for (const c of n.children) {
      await walk(c)
    }
  }
  await walk(profile.head)
  const frames = (ms / 1000) * 60
  console.log(
    `  allocations: ${(total / 1024 / frames).toFixed(1)} KB per 60 Hz frame (${(total / 1_048_576).toFixed(1)} MB in ${ms / 1000} s); by function, KB per frame:`,
  )
  for (const [k, b] of [...self].sort((x, y) => y[1] - x[1]).slice(0, 30)) {
    console.log(`    ${(b / 1024 / frames).toFixed(2).padStart(6)}  ${k}`)
  }
}

interface SourceMap {
  sources: string[]
  content: (string | null)[]
  /** per generated line: [generated column, source index, source line, source column] */
  lines: [number, number, number, number][][]
}

/** One mapping segment's VLQ fields. */
function vlq(seg: string): number[] {
  const vals: number[] = []
  let v = 0
  let shift = 0
  for (const ch of seg) {
    const d = B64.get(ch) ?? 0
    v += (d & 31) << shift
    if (d & 32) {
      shift += 5
    } else {
      vals.push(v & 1 ? -(v >>> 1) : v >>> 1)
      v = 0
      shift = 0
    }
  }
  return vals
}

/** A generated file's hidden source map (`<file>.js.map` beside it), decoded. */
async function loadMap(url: string): Promise<SourceMap | null> {
  const res = await fetch(`${url}.map`).catch(() => null)
  if (!res?.ok) {
    return null
  }
  const raw = (await res.json()) as {
    sources: string[]
    sourcesContent?: (string | null)[]
    mappings: string
  }
  const lines: SourceMap['lines'] = []
  const st: [number, number, number, number] = [0, 0, 0, 0]
  for (const l of raw.mappings.split(';')) {
    const segs: [number, number, number, number][] = []
    st[0] = 0
    for (const seg of l.split(',').filter(Boolean)) {
      const vals = vlq(seg)
      if (vals.length >= 4) {
        st[0] += vals[0] ?? 0
        st[1] += vals[1] ?? 0
        st[2] += vals[2] ?? 0
        st[3] += vals[3] ?? 0
        segs.push([...st])
      } else {
        st[0] += vals[0] ?? 0
      }
    }
    lines.push(segs)
  }
  return { sources: raw.sources, content: raw.sourcesContent ?? [], lines }
}

/** The original file, line and source text for a generated position. */
function lookup(
  m: SourceMap,
  line: number,
  col: number,
): { file: string; line: number; text: string } | null {
  const segs = m.lines[line]
  if (!segs) {
    return null
  }
  let hit: [number, number, number, number] | undefined
  for (const s of segs) {
    if (s[0] > col) {
      break
    }
    hit = s
  }
  if (!hit) {
    return null
  }
  const file = m.sources[hit[1]] ?? '?'
  const text = (m.content[hit[1]]?.split(NL)[hit[2]] ?? '').trim().slice(0, 60)
  return { file, line: hit[2], text }
}

/**
 * The production build with the perf-harness hooks kept (`PUBLIC_OW_PERF_HARNESS=1`), served as
 * static files the way the deploy serves them (`/path/` → `/path/index.html`).
 */
export function serveProd(port: number, build: boolean): () => void {
  const root = new URL('../', import.meta.url).pathname
  const out = join(tmpdir(), 'frontier-perf-dist')
  if (build) {
    console.log('building the production site (perf harness hooks on)…')
    const b = spawnSync(['bun', '--bun', 'astro', 'build', '--outDir', out], {
      cwd: root,
      env: { ...process.env, PUBLIC_OW_PERF_HARNESS: '1' },
      stdout: 'ignore',
      stderr: 'inherit',
    })
    if (b.exitCode !== 0) {
      throw new Error(`perf build failed (${b.exitCode})`)
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
