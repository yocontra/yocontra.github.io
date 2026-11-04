/**
 * The revolver's support hand: the left hand as the mirror image of the right one across the gun's
 * own vertical plane, so it wraps the grip from the left as the right wraps it from the right
 * (a two-handed hold), fingers and all.
 *
 * Mirroring a rotation across a plane with unit normal n: q = (v, w) becomes (2(v·n)n − v, w). The
 * rig's left bones aren't exactly the right ones mirrored, so each pair carries a correction,
 * measured once at rest across his own sagittal plane: `C = mirror(Qr)⁻¹ · Ql`.
 */
import { type Bone, Quaternion, Vector3 } from 'three'

const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky', 'Thumb'] as const
const tmpQ = new Quaternion()
const tmpQ2 = new Quaternion()
const tmpV = new Vector3()

export function mirrorQ(q: Quaternion, n: Vector3, out: Quaternion): Quaternion {
  const d = 2 * (q.x * n.x + q.y * n.y + q.z * n.z)
  return out.set(d * n.x - q.x, d * n.y - q.y, d * n.z - q.z, q.w)
}

interface Pair {
  r: Bone
  l: Bone
  /** mirror(Qr_rest)⁻¹ · Ql_rest, world space. */
  c: Quaternion
}

export class SupportHand {
  private readonly wrist: Pair | null
  private readonly fingers: Pair[] = []

  /** Measure the pairs at rest; `sagittal` is his left-right axis (world). */
  constructor(bones: Map<string, Bone>, sagittal: Vector3) {
    const pair = (rn: string, ln: string): Pair | null => {
      const r = bones.get(rn)
      const l = bones.get(ln)
      if (!(r && l)) {
        return null
      }
      const qr = r.getWorldQuaternion(new Quaternion())
      const ql = l.getWorldQuaternion(new Quaternion())
      const c = mirrorQ(qr, sagittal, new Quaternion()).invert().multiply(ql)
      return { r, l, c }
    }
    this.wrist = pair('WristR', 'WristL')
    for (const f of FINGERS) {
      for (let k = 1; k <= 4; k++) {
        const p = pair(`${f}${k}R`, `${f}${k}L`)
        if (p) {
          this.fingers.push(p)
        }
      }
    }
  }

  /**
   * Where the left wrist goes (world): the right wrist mirrored across the plane through `on`
   * with normal `n` (the gun's side), and its rotation. The right arm must be solved first.
   */
  target(on: Vector3, n: Vector3, outP: Vector3, outQ: Quaternion): boolean {
    const w = this.wrist
    if (!w) {
      return false
    }
    w.r.getWorldPosition(outP)
    const d = tmpV.copy(outP).sub(on).dot(n)
    outP.addScaledVector(n, -2 * d)
    mirrorQ(w.r.getWorldQuaternion(tmpQ), n, outQ).multiply(w.c)
    return true
  }

  /** Curl the left fingers as the right ones are curled, mirrored (after the left arm is solved). */
  fingersLike(n: Vector3): void {
    for (const f of this.fingers) {
      const want = mirrorQ(f.r.getWorldQuaternion(tmpQ), n, tmpQ).multiply(f.c)
      const pq = f.l.parent ? f.l.parent.getWorldQuaternion(tmpQ2) : tmpQ2.identity()
      f.l.quaternion.copy(pq.invert().multiply(want))
      f.l.updateMatrixWorld(true)
    }
  }
}
