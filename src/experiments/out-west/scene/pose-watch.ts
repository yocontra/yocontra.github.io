/**
 * Dev-only T-pose watchdog. Every frame it checks each live actor: if he is drawn (in a scene,
 * every ancestor visible, his mesh visible) but no clip poses him, he stands in his bind pose (a
 * T-pose). It warns once per episode, and counts episodes on `globalThis.__owTPose` for
 * Playwright. A no-op outside dev and perf-harness builds (`PROBE`).
 */
import type { Object3D } from 'three'
import { PROBE } from './anim-probe.ts'

export interface Posed {
  readonly root: Object3D
  readonly meshes: readonly { visible: boolean }[]
  readonly label: string
  readonly disposed: boolean
  /** Total weight of the clips posing him (0 = bind pose). */
  poseWeight: () => number
}

const watched = new Set<WeakRef<Posed>>()
const warned = new WeakSet<Posed>()
let running = false

function shown(a: Posed): boolean {
  if (!a.meshes.some((m) => m.visible)) {
    return false
  }
  let o: Object3D | null = a.root
  while (o) {
    if (!o.visible) {
      return false
    }
    if ((o as Object3D & { isScene?: boolean }).isScene) {
      return true
    }
    o = o.parent
  }
  return false
}

function check(): void {
  for (const ref of watched) {
    const a = ref.deref()
    if (!a || a.disposed) {
      watched.delete(ref)
      continue
    }
    const bad = shown(a) && a.poseWeight() < 1e-3
    if (bad && !warned.has(a)) {
      warned.add(a)
      Reflect.set(globalThis, '__owTPose', Number(Reflect.get(globalThis, '__owTPose') ?? 0) + 1)
      console.warn(`[ow] T-pose: ${a.label} is drawn with no clip playing`)
    } else if (!bad) {
      warned.delete(a)
    }
  }
  requestAnimationFrame(check)
}

/** Watch an actor (dev and perf-harness builds only; a no-op in production). */
export function watchPose(a: Posed): void {
  if (!PROBE) {
    return
  }
  watched.add(new WeakRef(a))
  if (!running && typeof requestAnimationFrame === 'function') {
    running = true
    requestAnimationFrame(check)
  }
}
