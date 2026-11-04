// biome-ignore-all lint/complexity/useMaxParams: the per-frame update takes the camera and positions positionally
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: one pass over riders and one over bags, each with its own skips
/**
 * Edge arrows: every living enemy within 18 m who is off screen gets a chevron on the screen edge
 * pointing at them, and so does every money bag within 30 m. Rider tint by threat: dusty for
 * anyone, gold for the Most Wanted, red for a player aiming at you; bags are gold coins. Works in
 * every view (`screen.ts` handles points behind the camera). A pool of DOM nodes, moved with
 * transforms; nothing is created per frame.
 */
import type { PerspectiveCamera } from 'three'
import { EF_ALIVE, EF_MOST_WANTED, EF_PROTECTED } from '../../contract/town.ts'
import type { RemoteView } from './interp.ts'
import { type ScreenPoint, toScreen } from './screen.ts'

const RANGE = 18
const BAG_RANGE = 30
const POOL = 12
const BAG_POOL = 4
/** Inset from the screen edge, px (clear of the home indicator and the HUD corners). */
const INSET = 26
/** Aiming within this angle of you counts as "aiming at you". */
const AIM_COS = Math.cos((10 * Math.PI) / 180)

const sp: ScreenPoint = { x: 0, y: 0, on: false, angle: 0 }

export interface BagDot {
  x: number
  z: number
}

export class ThreatArrows {
  private readonly nodes: HTMLElement[] = []
  private readonly bagNodes: HTMLElement[] = []

  constructor(parent: HTMLElement) {
    const layer = document.createElement('div')
    layer.className = 'fr-arrows'
    parent.append(layer)
    for (let i = 0; i < POOL + BAG_POOL; i++) {
      const a = document.createElement('div')
      a.className = i < POOL ? 'fr-arrow' : 'fr-arrow fr-arrow-bag'
      a.hidden = true
      layer.append(a)
      ;(i < POOL ? this.nodes : this.bagNodes).push(a)
    }
  }

  update(
    cam: PerspectiveCamera,
    x: number,
    z: number,
    remotes: readonly RemoteView[],
    bags: Iterable<BagDot> = [],
  ): void {
    let n = 0
    for (const r of remotes) {
      if (n >= POOL) {
        break
      }
      if (!(r.flags & EF_ALIVE) || r.flags & EF_PROTECTED) {
        continue
      }
      const dx = r.x - x
      const dz = r.z - z
      const d = Math.hypot(dx, dz)
      if (d > RANGE || d < 0.5) {
        continue
      }
      toScreen(cam, r.x, 1, r.z, INSET, sp)
      if (sp.on) {
        continue
      }
      const aimingAtMe = (-dx * Math.cos(r.aim) - dz * Math.sin(r.aim)) / d > AIM_COS
      let tone = 'any'
      if (aimingAtMe) {
        tone = 'aim'
      } else if (r.flags & EF_MOST_WANTED) {
        tone = 'mw'
      }
      const node = this.nodes[n++]
      if (!node) {
        break
      }
      if (node.dataset.tone !== tone) {
        node.dataset.tone = tone
      }
      place(node, sp, 1.25 - (d / RANGE) * 0.45)
    }
    hideFrom(this.nodes, n)
    let b = 0
    for (const bag of bags) {
      if (b >= BAG_POOL) {
        break
      }
      const d = Math.hypot(bag.x - x, bag.z - z)
      if (d > BAG_RANGE || d < 0.5) {
        continue
      }
      toScreen(cam, bag.x, 0.3, bag.z, INSET, sp)
      if (sp.on) {
        continue
      }
      const node = this.bagNodes[b++]
      if (!node) {
        break
      }
      place(node, sp, 1.1 - (d / BAG_RANGE) * 0.35)
    }
    hideFrom(this.bagNodes, b)
  }
}

/** Last transform written per node, quantised: the DOM (and style recalc) only sees real moves. */
const placed = new WeakMap<HTMLElement, { x: number; y: number; a: number; s: number }>()

function place(node: HTMLElement, p: ScreenPoint, scale: number): void {
  if (node.hidden) {
    node.hidden = false
  }
  const x = Math.round(p.x * 2) / 2
  const y = Math.round(p.y * 2) / 2
  const a = Math.round(p.angle * 100) / 100
  const s = Math.round(scale * 50) / 50
  let last = placed.get(node)
  if (!last) {
    last = { x: Number.NaN, y: 0, a: 0, s: 0 }
    placed.set(node, last)
  }
  if (last.x === x && last.y === y && last.a === a && last.s === s) {
    return
  }
  last.x = x
  last.y = y
  last.a = a
  last.s = s
  node.style.transform = `translate(${x}px, ${y}px) rotate(${a}rad) scale(${s})`
}

function hideFrom(nodes: readonly HTMLElement[], from: number): void {
  for (let i = from; i < nodes.length; i++) {
    const node = nodes[i]
    if (node && !node.hidden) {
      node.hidden = true
    }
  }
}
