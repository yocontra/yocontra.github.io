import {
  Entity,
  type GraphNode,
  type LightComponent,
  type Mesh,
  MeshInstance,
  SHADOWUPDATE_NONE,
  SHADOWUPDATE_REALTIME,
  Vec3,
} from 'playcanvas'
import type { GameApplication } from './application.ts'

const CROWDED = 16
const MAX_CACHED_MESHES = 128
const SHADOW_TURN_COSINE = Math.cos(Math.PI / 9)
type Simplify = typeof import('./crowd-shadow-mesh.ts').simplifyShadow

/** Low-tier sun updates alternate under load. Only dense crowds use reduced shadow geometry. */
export class FrontierShadows {
  private count = 0
  private localRider: string | undefined
  private readonly game: GameApplication
  private clock = 0
  private readonly lastCamera = new Vec3()
  private readonly lastDirection = new Vec3()
  private pending = false
  private closed = false as boolean
  private reuse = false as boolean
  private simplify: Simplify | undefined
  private sun: { light: LightComponent; previous: number } | undefined
  private readonly geometry = new Map<Mesh, Mesh | undefined>()
  private readonly proxies = new Map<MeshInstance, MeshInstance>()
  private readonly riderRoots = new WeakMap<GraphNode, string>()
  private readonly riders = new WeakMap<MeshInstance, string>()
  private readonly shadowOnly = new WeakSet<MeshInstance>()
  private readonly layer

  constructor(game: GameApplication) {
    this.game = game
    this.layer = game.app.scene.layers.getLayerByName('World')
    game.app.on('prerender', this.update)
  }

  crowd(count: number, ownId: string | undefined): void {
    this.count = count
    this.localRider = ownId
    if (count < CROWDED || this.pending || this.closed) {
      return
    }
    this.pending = true
    void import('./crowd-shadow-mesh.ts')
      .then(async ({ ready, simplifyShadow }) => {
        await ready
        if (!this.closed) {
          this.simplify = simplifyShadow
        }
      })
      .catch(() => {
        // Some devices lack the simplifier. Keep the original casters on those devices.
      })
  }

  registerRider(root: Entity, id: string): void {
    this.riderRoots.set(root, id)
  }

  private rider(source: MeshInstance): string | undefined {
    const known = this.riders.get(source)
    if (known !== undefined) {
      return known
    }
    for (let node: GraphNode | null = source.node; node; node = node.parent) {
      const id = this.riderRoots.get(node)
      if (id !== undefined) {
        this.riders.set(source, id)
        return id
      }
    }
    return undefined
  }

  private select(source: MeshInstance): boolean {
    if (
      !(source.castShadow && source.skinInstance) ||
      source.morphInstance ||
      this.shadowOnly.has(source) ||
      this.proxies.has(source)
    ) {
      return false
    }
    const rider = this.rider(source)
    return rider !== undefined && rider !== this.localRider
  }

  private remove(source: MeshInstance, proxy: MeshInstance): void {
    this.layer?.removeShadowCasters([proxy])
    // The physical rider owns this palette. Destroy only the proxy.
    proxy.skinInstance = null
    proxy.destroy()
    this.proxies.delete(source)
    if (source.node.root === this.game.app.root) {
      source.castShadow = true
      if (source.node.enabled) {
        this.layer?.addShadowCasters([source])
      }
    }
  }

  private readonly update = (): void => {
    const sun = this.game.app.root.findByName('sun')
    const light = sun instanceof Entity ? sun.light : undefined
    if (!light) {
      return
    }
    this.sun ??= { light, previous: light.shadowUpdateMode }
    const fps = this.game.quality.fps
    const crowded = this.count >= CROWDED
    const reuse = crowded || (fps > 0 && fps < (this.reuse ? 52 : 43))
    const camera = this.game.camera
    const position = camera.getPosition()
    const direction = camera.forward
    const jumped =
      position.distance(this.lastCamera) > 0.85 ||
      direction.dot(this.lastDirection) < SHADOW_TURN_COSINE
    const phase = this.clock++
    const reuseMap = reuse && this.reuse && !jumped && phase % 2 !== 0
    light.shadowUpdateMode = reuseMap ? SHADOWUPDATE_NONE : SHADOWUPDATE_REALTIME
    this.reuse = reuse
    if (!reuseMap) {
      this.lastCamera.copy(position)
      this.lastDirection.copy(direction)
    }
    this.updateCasters(crowded, phase)
  }

  private refreshOwnership(crowded: boolean): void {
    for (const [source, proxy] of this.proxies) {
      if (
        !crowded ||
        source.node.root !== this.game.app.root ||
        this.rider(source) === this.localRider
      ) {
        this.remove(source, proxy)
      } else {
        proxy.visible = source.visible && source.node.enabled
      }
    }
  }

  private updateCasters(crowded: boolean, phase: number): void {
    this.refreshOwnership(crowded)
    if (!(crowded && this.simplify && this.layer) || phase % 2 !== 0) {
      return
    }
    let built = false
    for (const source of [...this.layer.shadowCasters]) {
      const { mesh, material } = source
      if (!(mesh && material) || material.alphaTest || material.blend || !this.select(source)) {
        continue
      }
      if (!this.geometry.has(mesh)) {
        // Compile one unique mesh per pass, after the player can already enter the town.
        if (built || this.geometry.size >= MAX_CACHED_MESHES) {
          continue
        }
        built = true
        let result: Mesh | undefined
        try {
          result = this.simplify(mesh)
          result?.incRefCount()
        } catch {
          // A non-readable mesh keeps its authored caster.
        }
        this.geometry.set(mesh, result)
      }
      const reduced = this.geometry.get(mesh)
      if (reduced) {
        const proxy = new MeshInstance(reduced, material, source.node)
        this.shadowOnly.add(proxy)
        proxy.castShadow = true
        proxy.cull = source.cull
        proxy.visible = source.visible && source.node.enabled
        proxy.flipFacesFactor = source.flipFacesFactor
        proxy.skinInstance = source.skinInstance
        this.layer.removeShadowCasters([source])
        source.castShadow = false
        this.layer.addShadowCasters([proxy])
        this.proxies.set(source, proxy)
      }
    }
  }

  destroy(): void {
    this.closed = true
    this.game.app.off('prerender', this.update)
    if (this.sun) {
      this.sun.light.shadowUpdateMode = this.sun.previous
    }
    for (const [source, proxy] of this.proxies) {
      this.remove(source, proxy)
    }
    for (const mesh of this.geometry.values()) {
      if (mesh) {
        mesh.decRefCount()
        mesh.destroy()
      }
    }
    this.geometry.clear()
  }
}
