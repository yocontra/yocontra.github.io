/**
 * Runtime LODs for baked characters (design doc §10.3 LOD table), made with
 * meshoptimizer's simplifier (WASM, bundled) in a Web Worker and cached per
 * key in memory.
 *
 * Simplification only rewrites the index buffer. Every vertex attribute
 * (position, normal, colour, skin indices and weights, styMat) is shared with
 * the source geometry, so an LOD is a drop-in `geometry` swap on the same
 * SkinnedMesh and skeleton. Vertex-colour seams are protected by feeding the
 * colours to the simplifier as attributes.
 *
 * Usage (streams D and G):
 *   const lod1 = await lodGeometry(actor.meshes[0].geometry, `${seed}:lod1`, 3000)
 *   actor.meshes[0].geometry = lod1   // far
 *   actor.meshes[0].geometry = full   // near (keep a reference)
 */
import { MeshoptSimplifier } from 'meshoptimizer'
import { BufferAttribute, BufferGeometry } from 'three'

export interface SimplifyJob {
  index: Uint32Array
  positions: Float32Array
  /** Per-vertex attributes that mark seams (RGB tint, then UV), `stride` floats each, or empty. */
  colors: Float32Array
  /** Floats per vertex in `colors` (3 = RGB only, 5 = RGB + UV). */
  stride?: number
  targetTris: number
  /** Relative error bound (fraction of the mesh extent). */
  maxError: number
  /** Let collapses cross colour seams (crowd LOD2, where silhouette beats seams). */
  permissive?: boolean
}

export interface SimplifyResult {
  index: Uint32Array
  error: number
}

/**
 * The baked characters are flat-shaded, so nearly every triangle has its own
 * vertices and every edge looks like a border to the simplifier. Weld
 * vertices that share a position AND a colour (quantised) onto one
 * representative: flat-shading splits disappear, colour seams stay seams.
 * Every representative is an original vertex, so skin weights still apply.
 */
function weld(
  index: Uint32Array,
  positions: Float32Array,
  colors: Float32Array,
  stride: number,
): Uint32Array {
  const n = positions.length / 3
  const rep = new Uint32Array(n)
  const seen = new Map<string, number>()
  const q = (x: number, k: number) => Math.round(x * k)
  for (let i = 0; i < n; i++) {
    let key = `${q(positions[i * 3] ?? 0, 1e4)},${q(positions[i * 3 + 1] ?? 0, 1e4)},${q(positions[i * 3 + 2] ?? 0, 1e4)}`
    for (let c = 0; c < (colors.length > 0 ? stride : 0); c++) {
      // colours to 1/48, UVs to about a texel of the atlas
      key += `|${q(colors[i * stride + c] ?? 0, c < 3 ? 48 : 2048)}`
    }
    const have = seen.get(key)
    if (have === undefined) {
      seen.set(key, i)
      rep[i] = i
    } else {
      rep[i] = have
    }
  }
  const out = new Uint32Array(index.length)
  for (const [k, v] of index.entries()) {
    out[k] = rep[v] ?? v
  }
  return out
}

/** The simplifier itself; runs in the worker, or inline as the fallback. */
export async function simplifyIndex(job: SimplifyJob): Promise<SimplifyResult> {
  await MeshoptSimplifier.ready
  const target = Math.min(job.index.length, Math.max(3, Math.floor(job.targetTris) * 3))
  const stride = job.stride ?? 3
  const welded = weld(job.index, job.positions, job.colors, stride)
  if (job.colors.length > 0) {
    const [index, error] = MeshoptSimplifier.simplifyWithAttributes(
      welded,
      job.positions,
      3,
      job.colors,
      stride,
      stride === 5 ? [0.6, 0.6, 0.6, 1.5, 1.5] : [0.6, 0.6, 0.6],
      null,
      target,
      job.maxError,
      job.permissive ? ['Prune', 'Permissive'] : ['Prune'],
    )
    return { index, error }
  }
  const [index, error] = MeshoptSimplifier.simplify(
    welded,
    job.positions,
    3,
    target,
    job.maxError,
    ['Prune'],
  )
  return { index, error }
}

let worker: Worker | null = null
let seq = 0
const waiting = new Map<number, (r: SimplifyResult) => void>()

function getWorker(): Worker | null {
  if (worker) {
    return worker
  }
  try {
    worker = new Worker(new URL('./lod.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; result: SimplifyResult }>) => {
      waiting.get(e.data.id)?.(e.data.result)
      waiting.delete(e.data.id)
    }
  } catch {
    worker = null
  }
  return worker
}

/** Simplify off the main thread when workers are available. */
export function simplifyAsync(job: SimplifyJob): Promise<SimplifyResult> {
  const w = getWorker()
  if (!w) {
    return simplifyIndex(job)
  }
  const id = ++seq
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    // copies, so the caller's geometry keeps its buffers
    w.postMessage({ id, job })
  })
}

function jobFor(geo: BufferGeometry, targetTris: number, maxError: number): SimplifyJob {
  const pos = geo.getAttribute('position')
  const col = geo.getAttribute('color')
  const uv = geo.getAttribute('uv')
  const stride = uv ? 5 : 3
  const positions = new Float32Array(pos.count * 3)
  const colors = new Float32Array(col ? pos.count * stride : 0)
  for (let i = 0; i < pos.count; i++) {
    positions[i * 3] = pos.getX(i)
    positions[i * 3 + 1] = pos.getY(i)
    positions[i * 3 + 2] = pos.getZ(i)
    if (col) {
      colors[i * stride] = col.getX(i)
      colors[i * stride + 1] = col.getY(i)
      colors[i * stride + 2] = col.getZ(i)
      if (uv) {
        colors[i * stride + 3] = uv.getX(i)
        colors[i * stride + 4] = uv.getY(i)
      }
    }
  }
  const src = geo.index
  const index = new Uint32Array(src ? src.count : pos.count)
  for (let i = 0; i < index.length; i++) {
    index[i] = src ? src.getX(i) : i
  }
  return { index, positions, colors, stride, targetTris, maxError }
}

const cache = new Map<string, Promise<BufferGeometry>>()

/**
 * An LOD of `geo` with about `targetTris` triangles, sharing all of its
 * vertex attributes. Cached by `key` (e.g. the outlaw's look seed + level).
 */
export function lodGeometry(
  geo: BufferGeometry,
  key: string,
  targetTris = 3000,
  maxError = 0.12,
): Promise<BufferGeometry> {
  const have = cache.get(key)
  if (have) {
    return have
  }
  const p = simplifyAsync(jobFor(geo, targetTris, maxError)).then(({ index }) => {
    const out = new BufferGeometry()
    for (const [name, attr] of Object.entries(geo.attributes)) {
      out.setAttribute(name, attr)
    }
    out.setIndex(new BufferAttribute(index, 1))
    out.boundingBox = geo.boundingBox
    out.boundingSphere = geo.boundingSphere
    out.userData.lodOf = key
    return out
  })
  cache.set(key, p)
  return p
}

/** Drop cached LODs (e.g. when leaving the Frontier). */
export function clearLods(): void {
  cache.clear()
}
