import type { Entity, Material } from 'playcanvas'
import type { GlassPlane } from '../ffa/sim/building-rules.ts'
import type { SimEvent } from '../ffa/sim/types.ts'
import type { GameApplication } from './application.ts'
import { GlassShards } from './glass-shards.ts'
import type { NativeRagdolls } from './ragdolls.ts'

const PANE_NAME = /^glass-\d+$/u

/** Authored pane nodes retain stable domain indices across joins and broken-window snapshots. */
export class BreakableWindows {
  private readonly panes: Entity[] = []
  private planes: readonly GlassPlane[] = []
  private seen: Uint8Array | undefined
  private shards: GlassShards | undefined
  constructor(town: Entity) {
    for (const node of town.find((child) => PANE_NAME.test(child.name))) {
      const index = Number(node.name.slice(6))
      this.panes[index] = node as Entity
      for (const render of (node as Entity).findComponents('render')) {
        render.castShadows = false
      }
    }
  }
  /** Panes follow authoritative glass only when it changes, so a shatter can lead its snapshot. */
  update(glass: Uint8Array | undefined, planes?: readonly GlassPlane[]): void {
    if (!glass) {
      return
    }
    this.planes = planes ?? this.planes
    const first = this.seen?.length !== glass.length
    const seen = first ? new Uint8Array(glass.length) : (this.seen ?? glass)
    for (const [index, pane] of this.panes.entries()) {
      if (first || seen[index] !== glass[index]) {
        pane.enabled = glass[index] !== 1
      }
    }
    seen.set(glass)
    this.seen = seen
  }
  /** Live shatters burst into native shards that share the ragdolls' town physics. */
  shatterInto(game: GameApplication, ragdolls: NativeRagdolls): void {
    this.shards?.destroy()
    this.shards = new GlassShards(game, ragdolls, this)
  }
  event(event: SimEvent): void {
    this.shards?.event(event)
  }
  plane(index: number): GlassPlane | undefined {
    return this.planes.find((plane) => plane.index === index)
  }
  material(index: number): Material | undefined {
    return this.panes[index]?.findComponents('render')[0]?.meshInstances[0]?.material ?? undefined
  }
  hide(index: number): void {
    const pane = this.panes[index]
    if (pane) {
      pane.enabled = false
    }
  }
  stats(): { total: number; intact: number; shards: number } {
    return {
      total: this.panes.length,
      intact: this.panes.filter((pane) => pane.enabled).length,
      shards: this.shards?.stats().shards ?? 0,
    }
  }
  destroy(): void {
    this.shards?.destroy()
    this.shards = undefined
  }
}
