import type { Entity } from 'playcanvas'

const PANE_NAME = /^glass-\d+$/u

/** Authored pane nodes retain stable domain indices across joins and broken-window snapshots. */
export class BreakableWindows {
  private readonly panes: Entity[] = []
  constructor(town: Entity) {
    for (const node of town.find((child) => PANE_NAME.test(child.name))) {
      const index = Number(node.name.slice(6))
      this.panes[index] = node as Entity
      for (const render of (node as Entity).findComponents('render')) {
        render.castShadows = false
      }
    }
  }
  update(glass: Uint8Array | undefined): void {
    if (!glass) {
      return
    }
    for (const [index, pane] of this.panes.entries()) {
      pane.enabled = glass[index] !== 1
    }
  }
  stats(): { total: number; intact: number } {
    return { total: this.panes.length, intact: this.panes.filter((pane) => pane.enabled).length }
  }
}
