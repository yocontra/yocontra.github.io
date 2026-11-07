/** Prewarmed index LODs of the same dressed skin and gear; physics and vertex data stay intact. */
import { BufferAttribute, BufferGeometry, Mesh, SkinnedMesh } from 'three'
import { simplifyAsync } from '../../scene/lod.ts'
import { corpseLodJob } from './corpse-lod-job.ts'
import type { CorpseRig } from './crowd/corpse-rig.ts'

type Level = 0 | 1 | 2
interface Shape {
  index: Uint32Array
  groups: { start: number; count: number; materialIndex: number }[]
}
interface Entry {
  mesh: Mesh
  full: BufferGeometry
  levels: BufferGeometry[]
}
interface LodState {
  disposed: boolean
  failed: boolean
  pending: boolean
  ready: boolean
  level: Level
}
const cache = new WeakMap<BufferGeometry, Promise<Shape[]>>()
const prepared = new WeakMap<CorpseRig, Entry[]>()
const preparing = new WeakMap<CorpseRig, Promise<void>>()
const states = new Set<LodState>()
const detail = new WeakMap<CorpseRig, LodState>()

export function corpseLodStats() {
  const all = [...states]
  return {
    models: all.length,
    pending: all.filter((state) => state.pending).length,
    ready: all.filter((state) => state.ready).length,
    fallback: all.filter((state) => state.failed).length,
    full: all.filter((state) => state.level === 0).length,
    middle: all.filter((state) => state.level === 1).length,
    far: all.filter((state) => state.level === 2).length,
  }
}

function targets(skin: boolean): readonly [number, number] {
  // Full geometry stays close to the lens. At distance, keep the same face, wardrobe,
  // finish and silhouette with fewer triangles in each of those actual meshes.
  return skin ? [5000, 2500] : [1000, 450]
}

function shapes(source: BufferGeometry, mesh: Mesh): Promise<Shape[]> {
  const existing = cache.get(source)
  if (existing) {
    return existing
  }
  const job = corpseLodJob(source, mesh instanceof SkinnedMesh ? mesh : undefined)
  const groups =
    source.groups.length > 0
      ? source.groups.map((group) => ({ ...group, materialIndex: group.materialIndex ?? 0 }))
      : [{ start: 0, count: job.index.length, materialIndex: 0 }]
  const result = Promise.all(
    targets(mesh instanceof SkinnedMesh).map(async (target, level) => {
      const pieces = await Promise.all(
        groups.map(async (group) => {
          const index = job.index.slice(group.start, group.start + group.count)
          const count = Math.max(12, Math.floor((target * group.count) / job.index.length))
          if (index.length <= count * 3) {
            return index
          }
          return (
            await simplifyAsync({
              ...job,
              index,
              targetTris: count,
              maxError: level === 0 ? 0.012 : 0.025,
            })
          ).index
        }),
      )
      const index = new Uint32Array(pieces.reduce((total, piece) => total + piece.length, 0))
      const output: Shape['groups'] = []
      let start = 0
      for (const [part, piece] of pieces.entries()) {
        index.set(piece, start)
        if (source.groups.length > 0) {
          output.push({
            start,
            count: piece.length,
            materialIndex: groups[part]?.materialIndex ?? 0,
          })
        }
        start += piece.length
      }
      return { index, groups: output }
    }),
  )
  cache.set(source, result)
  void result.catch(() => cache.delete(source))
  return result
}

function wrapper(full: BufferGeometry, shape: Shape): BufferGeometry {
  const geometry = new BufferGeometry()
  for (const [name, attribute] of Object.entries(full.attributes)) {
    geometry.setAttribute(name, attribute)
  }
  // Each corpse owns its small GPU index allocation; cached CPU arrays retain no GPU objects.
  geometry.setIndex(new BufferAttribute(shape.index.slice(), 1))
  geometry.groups = shape.groups.map((group) => ({ ...group }))
  geometry.boundingBox = full.boundingBox
  geometry.boundingSphere = full.boundingSphere
  return geometry
}

function release(entries: readonly Entry[]): void {
  for (const { mesh, full, levels } of entries) {
    mesh.geometry = full
    for (const geometry of levels) {
      // Source attributes and the private cloth offset belong to the original rig wrapper.
      for (const name of Object.keys(geometry.attributes)) {
        geometry.deleteAttribute(name)
      }
      geometry.dispose()
    }
  }
}

/** Prepare while loading. Future captures reuse the immutable-source index jobs. */
export function prepareCorpseLod(rig: CorpseRig): Promise<void> {
  const pending = preparing.get(rig)
  if (pending) {
    return pending
  }
  const job = install(rig)
  preparing.set(rig, job)
  return job
}

async function install(rig: CorpseRig): Promise<void> {
  if (!rig.lodSources) {
    return
  }
  const entries: Entry[] = []
  prepared.set(rig, entries)
  const state: LodState = { disposed: false, failed: false, pending: true, ready: false, level: 0 }
  states.add(state)
  detail.set(rig, state)
  const dispose = rig.dispose
  rig.dispose = () => {
    if (state.disposed) {
      return
    }
    state.disposed = true
    states.delete(state)
    detail.delete(rig)
    release(entries)
    entries.length = 0
    prepared.delete(rig)
    dispose()
  }
  const sources = [...rig.lodSources]
  try {
    await Promise.all(
      sources.map(async ([mesh, source]) => {
        if (!(mesh instanceof Mesh && mesh.visible)) {
          return
        }
        const full = mesh.geometry
        const variants = await shapes(source, mesh)
        if (state.disposed || state.failed) {
          return
        }
        entries.push({ mesh, full, levels: variants.map((shape) => wrapper(full, shape)) })
      }),
    )
    state.ready = !state.disposed
  } catch (error: unknown) {
    state.failed = true
    release(entries)
    entries.length = 0
    prepared.delete(rig)
    console.warn('Optional corpse LOD unavailable; keeping the full dressed model', error)
  } finally {
    state.pending = false
  }
}

/** Floor/legacy only; the near body and all high-tier shadow casters keep their original mesh. */
export function setCorpseDetail(rig: CorpseRig, distance: number, reduced: boolean): void {
  let level: Level = 0
  if (reduced && distance >= 3) {
    level = distance < 7.5 ? 1 : 2
  }
  const state = detail.get(rig)
  if (state?.ready) {
    state.level = level
  }
  for (const { mesh, full, levels } of prepared.get(rig) ?? []) {
    const geometry = level === 0 ? full : (levels[level - 1] ?? full)
    // Bounds refresh on the original private cloth wrapper, not on cached source data.
    geometry.boundingBox = full.boundingBox
    geometry.boundingSphere = full.boundingSphere
    mesh.geometry = geometry
  }
}
