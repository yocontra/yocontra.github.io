/**
 * Edge threat arrows (lead ruling with the closer camera): every living enemy within 18 m who is
 * off screen gets a small arrow on the screen edge pointing at them. Tint by threat: dusty for
 * anyone, gold for the Most Wanted, red for a player aiming at you. A pool of DOM nodes, moved
 * with transforms; nothing is created per frame.
 */
import type { PerspectiveCamera } from 'three'
import { Vector3 } from 'three'
import { EF_ALIVE, EF_MOST_WANTED, EF_PROTECTED } from '../../contract/town.ts'
import type { RemoteView } from './interp.ts'

const RANGE = 18
const POOL = 12
/** Inset from the screen edge, px (clear of the home indicator and the HUD corners). */
const INSET = 26
/** Aiming within this angle of you counts as "aiming at you". */
const AIM_COS = Math.cos((10 * Math.PI) / 180)

const v = new Vector3()

export class ThreatArrows {
  private readonly nodes: HTMLElement[] = []

  constructor(parent: HTMLElement) {
    const layer = document.createElement('div')
    layer.className = 'fr-arrows'
    parent.append(layer)
    for (let i = 0; i < POOL; i++) {
      const a = document.createElement('div')
      a.className = 'fr-arrow'
      a.hidden = true
      layer.append(a)
      this.nodes.push(a)
    }
  }

  update(cam: PerspectiveCamera, x: number, z: number, remotes: readonly RemoteView[]): void {
    const w = window.innerWidth
    const h = window.innerHeight
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
      v.set(r.x, 1, r.z).project(cam)
      if (Math.abs(v.x) < 0.96 && Math.abs(v.y) < 0.96 && v.z < 1) {
        continue
      }
      // Toward them from the screen centre, clamped to the inset edge.
      const sx = v.x
      const sy = -v.y
      const k = Math.min(
        (w / 2 - INSET) / Math.max(1e-6, Math.abs((sx * w) / 2)),
        (h / 2 - INSET) / Math.max(1e-6, Math.abs((sy * h) / 2)),
      )
      const px = w / 2 + sx * (w / 2) * k
      const py = h / 2 + sy * (h / 2) * k
      const ang = Math.atan2(sy * h, sx * w)
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
      node.hidden = false
      node.dataset.tone = tone
      node.style.transform = `translate(${px}px, ${py}px) rotate(${ang}rad) scale(${1.25 - (d / RANGE) * 0.45})`
    }
    for (let i = n; i < this.nodes.length; i++) {
      const node = this.nodes[i]
      if (node && !node.hidden) {
        node.hidden = true
      }
    }
  }
}
