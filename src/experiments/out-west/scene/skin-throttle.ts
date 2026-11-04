/**
 * Skinned bystanders that animate at 15–30 Hz shouldn't cost 60 Hz of matrix work. For a subtree
 * (a townsman, a horse) this skips three's per-frame world-matrix walk of it, and makes each of
 * its skeletons skip its bone-matrix rebuild and upload, unless `touch()` says it moved. The
 * owner calls `touch()` on the frames it animates or moves him; on the others the GPU keeps what
 * it has. (Floor tier at 4x throttle: the town's rigs were most of its render cost.)
 */
import type { Object3D, Skeleton, SkinnedMesh } from 'three'

export class SkinThrottle {
  private readonly skeletons: Skeleton[] = []
  private readonly dirty = new Set<Skeleton>()
  private pending: boolean = true as boolean

  constructor(root: Object3D) {
    root.traverse((o) => {
      const m = o as Partial<SkinnedMesh>
      if (m.isSkinnedMesh === true && m.skeleton && !this.skeletons.includes(m.skeleton)) {
        this.skeletons.push(m.skeleton)
        this.patch(m.skeleton)
      }
    })
    const walk = root.updateMatrixWorld.bind(root)
    // the scene's walk reaches him every frame: only follow it through when he's moved
    root.updateMatrixWorld = () => {
      if (this.pending) {
        this.pending = false
        walk(true)
      }
    }
    this.touch()
  }

  private patch(sk: Skeleton): void {
    const update = sk.update.bind(sk)
    sk.update = () => {
      if (this.dirty.has(sk)) {
        this.dirty.delete(sk)
        update()
      }
    }
  }

  /** He moved this frame: his matrices and bones are rebuilt at the next draw. */
  touch(): void {
    this.pending = true
    for (const sk of this.skeletons) {
      this.dirty.add(sk)
    }
  }
}
