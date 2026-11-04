// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: two grid sweeps and a blob fill, kept flat
// biome-ignore-all lint/style/noMagicNumbers: tolerances in metres, named where they matter
/**
 * Dev-only collider-vs-visual check for Perdition. `tools/collider-check.ts` imports this into the
 * running page from the dev server; the game never imports it, so it never ships.
 *
 * It splits the built town into pieces the way the float audit does (`collect` in
 * `scene/float-audit.ts`: instances, kit pieces, connected components of the merged batches),
 * keeps the ones a rider could run into (some part between ankle and head height, standing in the
 * playable square), and rasterises their footprints onto the server's 0.5 m collision grid. Then:
 *
 * - **invisible wall**: a move-blocking cell with no visual within one cell of it;
 * - **walk-through**: a visual's footprint more than one cell from any move-blocking cell.
 *
 * Mismatched cells are grouped into blobs and reported with what stands (or doesn't) there.
 * Wall-mounted kit (windows, frames, doors, balconies), hanging things, decals and anything wholly
 * overhead (porch roofs, laundry, signs) or flat on the ground (decks, rails, ties) are skipped.
 */
import type { Object3D } from 'three'
import { collect } from '../../scene/float-audit.ts'
import { BLOCK_MOVE, buildGrid, TOWN } from '../sim/layout.ts'

export interface ColliderBlob {
  kind: 'invisible' | 'walkthrough'
  /** Centre of the blob, layout metres. */
  at: [number, number]
  cells: number
  /** What's nearest: the cover kind or building id, and visual piece names. */
  near: string[]
}

export interface ColliderReport {
  pieces: number
  checked: number
  blocked: number
  visual: number
  blobs: ColliderBlob[]
}

/** Below this a piece is flat (decks, rails, ties); above `HEAD` it's overhead. */
const ANKLE = 0.25
const HEAD = 1.7
/** Kit hung on a wall face: its footprint is the wall's. */
const ON_WALL = /^k_(?:window|shutters|door|doorframe|balcony|support|lantern|roof|corner)/u
/** Live things the town didn't build (riders' guns too, held or in the view model). */
const LIVE = /^(?:pickup|bags|strongbox|dynamite|rifle|shotgun|revolver|coins|money|tracer|gun)/iu

export function colliderAudit(scene: Object3D): ColliderReport {
  const grid = buildGrid(TOWN)
  const { n, cell } = grid
  const c = collect(scene)
  const visual = new Uint8Array(n * n)
  /** The piece name that marked each visual cell (for the report). */
  const who = new Map<number, string>()
  let checked = 0
  for (const p of c.pieces) {
    if (p.hangs || p.decal || ON_WALL.test(p.name) || LIVE.test(p.name)) {
      continue
    }
    if (p.max.y < ANKLE || p.min.y > HEAD) {
      continue
    }
    const sx = p.max.x - p.min.x
    const sz = p.max.z - p.min.z
    if (sx > 60 || sz > 60) {
      continue
    }
    checked++
    // every triangle reaching into body height marks the cells under it (a merged building's
    // walls are one piece, so its footprint is its faces, never its bounding box); a few
    // centimetres in, so faces flush with a collider edge land on its cell
    const t = c.tri
    for (let k = p.t0; k < p.t0 + p.tn; k++) {
      const o = k * 9
      const ys = [t[o + 1] ?? 0, t[o + 4] ?? 0, t[o + 7] ?? 0]
      if (Math.max(...ys) < ANKLE || Math.min(...ys) > HEAD) {
        continue
      }
      const xs = [t[o] ?? 0, t[o + 3] ?? 0, t[o + 6] ?? 0]
      const zs = [t[o + 2] ?? 0, t[o + 5] ?? 0, t[o + 8] ?? 0]
      const x0 = Math.min(...xs)
      const x1 = Math.max(...xs)
      const z0 = Math.min(...zs)
      const z1 = Math.max(...zs)
      const c0 = Math.max(0, Math.floor((x0 + Math.min(0.06, (x1 - x0) / 2)) / cell))
      const c1 = Math.min(n - 1, Math.floor((x1 - Math.min(0.06, (x1 - x0) / 2)) / cell))
      const r0 = Math.max(0, Math.floor((z0 + Math.min(0.06, (z1 - z0) / 2)) / cell))
      const r1 = Math.min(n - 1, Math.floor((z1 - Math.min(0.06, (z1 - z0) / 2)) / cell))
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          visual[row * n + col] = 1
          if (!who.has(row * n + col)) {
            who.set(row * n + col, p.name)
          }
        }
      }
    }
  }
  // only the playable square: not the border ring, not the cut bank north of the creek bed
  const rowMin = Math.ceil(TOWN.creek.z / cell) + 1
  const inPlay = (col: number, row: number) =>
    col >= 1 && row >= rowMin && col < n - 1 && row < n - 1
  const blocked = (i: number) => ((grid.cells[i] ?? 0) & BLOCK_MOVE) !== 0
  const near = (col: number, row: number, test: (i: number) => boolean) => {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const cc = col + dc
        const rr = row + dr
        if (cc >= 0 && rr >= 0 && cc < n && rr < n && test(rr * n + cc)) {
          return true
        }
      }
    }
    return false
  }
  /**
   * Inside a solid footprint: walking out of the blocked region every way meets a drawn face
   * before open ground (the middle of a shed, under the water tower's pump house).
   */
  const enclosed = (col: number, row: number) =>
    (
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const
    ).every(([dc, dr]) => {
      for (let k = 1; k < n; k++) {
        const cc = col + dc * k
        const rr = row + dr * k
        if (cc < 0 || rr < 0 || cc >= n || rr >= n) {
          return false
        }
        const j = rr * n + cc
        if (visual[j] === 1) {
          return true
        }
        if (!blocked(j)) {
          return false
        }
      }
      return false
    })
  const bad = new Int8Array(n * n)
  let nBlocked = 0
  let nVisual = 0
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!inPlay(col, row)) {
        continue
      }
      const i = row * n + col
      if (blocked(i)) {
        nBlocked++
        if (!(near(col, row, (j) => visual[j] === 1) || enclosed(col, row))) {
          bad[i] = 1
        }
      }
      if (visual[i]) {
        nVisual++
        if (!near(col, row, blocked)) {
          bad[i] = 2
        }
      }
    }
  }
  const coverAt = (x: number, z: number): string | null => {
    for (const cv of TOWN.cover) {
      if (x >= cv.x - 0.5 && x <= cv.x + cv.w + 0.5 && z >= cv.z - 0.5 && z <= cv.z + cv.d + 0.5) {
        return cv.kind
      }
    }
    for (const b of TOWN.buildings) {
      if (x >= b.x - 0.5 && x <= b.x + b.w + 0.5 && z >= b.z - 0.5 && z <= b.z + b.d + 0.5) {
        return b.id
      }
    }
    return null
  }
  const blobs: ColliderBlob[] = []
  const seen = new Uint8Array(n * n)
  for (let i = 0; i < n * n; i++) {
    const kind = bad[i]
    if (!kind || seen[i]) {
      continue
    }
    const q = [i]
    seen[i] = 1
    let sx = 0
    let sz = 0
    let count = 0
    const names = new Set<string>()
    while (q.length > 0) {
      const k = q.pop() ?? 0
      count++
      const col = k % n
      const row = Math.floor(k / n)
      sx += (col + 0.5) * cell
      sz += (row + 0.5) * cell
      const w = who.get(k)
      if (w) {
        names.add(w)
      }
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const j = (row + dr) * n + col + dc
          if (j >= 0 && j < n * n && !seen[j] && bad[j] === kind) {
            seen[j] = 1
            q.push(j)
          }
        }
      }
    }
    const at: [number, number] = [
      Math.round((sx / count) * 10) / 10,
      Math.round((sz / count) * 10) / 10,
    ]
    const what = coverAt(at[0], at[1])
    blobs.push({
      kind: kind === 1 ? 'invisible' : 'walkthrough',
      at,
      cells: count,
      near: [...(what ? [what] : []), ...names].slice(0, 4),
    })
  }
  return { pieces: c.pieces.length, checked, blocked: nBlocked, visual: nVisual, blobs }
}
