/** Retained real rigs keep their compiled skinned/cloth/gear programs alive after boot warming. */
import type { Object3D } from 'three'
import { MAX_PLAYERS } from '../../sim/constants.ts'
import { prepareCorpseLod } from '../corpse-lod.ts'
import type { CorpseRig } from './corpse-rig.ts'

export class CorpseWarmup {
  private readonly capture: (id: number) => Promise<CorpseRig | null>
  private readonly rigs = new Map<number, CorpseRig>()
  private readonly lifetime = new AbortController()
  private generation = 0

  constructor(capture: (id: number) => Promise<CorpseRig | null>) {
    this.capture = capture
  }

  async prepare(
    ids: Iterable<number>,
    compile: (roots: readonly Object3D[]) => void,
    valid: () => boolean,
  ): Promise<void> {
    if (this.lifetime.signal.aborted || !valid()) {
      return
    }
    const generation = ++this.generation
    const wanted = [...new Set(ids)]
      .filter((id) => Number.isInteger(id) && id >= 0 && id < MAX_PLAYERS)
      .slice(0, MAX_PLAYERS)
    const results = await Promise.allSettled(
      wanted.map(async (id) => {
        const rig = await this.capture(id)
        if (rig?.lodSources) {
          await prepareCorpseLod(rig)
        }
        return rig
      }),
    )
    const loaded = results.flatMap((result, index) =>
      result.status === 'fulfilled' && result.value
        ? [{ id: wanted[index] ?? -1, rig: result.value }]
        : [],
    )
    const failure = results.find((result) => result.status === 'rejected')
    const current = !this.lifetime.signal.aborted && generation === this.generation && valid()
    if (!current || failure) {
      for (const { rig } of loaded) {
        rig.dispose()
      }
      if (current && failure?.status === 'rejected') {
        throw failure.reason
      }
      return
    }
    const culling: { node: Object3D; enabled: boolean }[] = []
    for (const { rig } of loaded) {
      rig.root.traverse((node) => {
        culling.push({ node, enabled: node.frustumCulled })
        node.frustumCulled = false
      })
    }
    try {
      compile(loaded.map(({ rig }) => rig.root))
    } catch (error: unknown) {
      for (const { rig } of loaded) {
        rig.dispose()
      }
      throw error
    } finally {
      // Real gameplay bounds must not stop offscreen roster variants being drawn once at boot.
      for (const { node, enabled } of culling) {
        node.frustumCulled = enabled
      }
    }
    if (this.lifetime.signal.aborted || generation !== this.generation || !valid()) {
      for (const { rig } of loaded) {
        rig.dispose()
      }
      return
    }
    // Release old programs only once replacements have been compiled and retain their refs.
    for (const rig of this.rigs.values()) {
      rig.dispose()
    }
    this.rigs.clear()
    for (const { id, rig } of loaded) {
      this.rigs.set(id, rig)
    }
  }

  invalidate(): void {
    this.generation++
  }

  get count(): number {
    return this.rigs.size
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) {
      return
    }
    this.lifetime.abort()
    this.invalidate()
    for (const rig of this.rigs.values()) {
      rig.dispose()
    }
    this.rigs.clear()
  }
}
