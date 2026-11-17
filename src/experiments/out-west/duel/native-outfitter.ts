/** Outfitter subjects share the game's native application and its ordinary material lifetime. */
import { BoundingBox, type ContainerResource, type Entity, Vec3 } from 'playcanvas'
import { DYNAMIC_ASSETS } from '../content/manifest.ts'
import { bagStyleIndex } from '../contract/town.ts'
import type { ItemId, Loadout } from '../data/catalog.ts'
import type { Dyes } from '../data/dye.ts'
import { equippedActor } from '../scene/native-equipment.ts'
import { prepareNativeMaterials } from '../scene/native-materials.ts'
import type { DuelActor } from './native-actor.ts'
import type { NativeDirector } from './native-director.ts'

const appearances = new WeakMap<NativeDirector, { key: string; actor: DuelActor | null }>()
const previews = new WeakMap<NativeDirector, NativeOutfitter>()

/** Re-reading an unchanged profile must not replace the actor and restart its native idle. */
export function dressForHub(d: NativeDirector, loadout: Loadout, dyes: Dyes): void {
  const { outfit, hat, gun, spurs, holster, extra } = loadout
  const key = JSON.stringify([
    { outfit, hat, gun, spurs, holster, extra },
    Object.entries(dyes).sort(([a], [b]) => a.localeCompare(b)),
  ])
  const previous = appearances.get(d)
  if (previous?.key === key && previous.actor === d.player) {
    return
  }
  const request = { key, actor: d.player }
  appearances.set(d, request)
  const epoch = ++d.equipmentEpoch
  void equippedActor(d.game, loadout, dyes)
    .then((next) => {
      if (epoch !== d.equipmentEpoch) {
        next.destroy()
        return
      }
      const old = d.player
      if (old) {
        next.root.setPosition(old.root.getPosition())
        next.root.setRotation(old.root.getRotation())
        next.root.enabled = old.root.enabled
      }
      d.player = next
      request.actor = next
      old?.destroy()
    })
    .catch((error: unknown) => {
      if (epoch !== d.equipmentEpoch) {
        return
      }
      appearances.delete(d)
      d.c.hud.fake(error instanceof Error ? error.message : 'Could not load this outfit.', 4000)
    })
}

export function storeSubject(d: NativeDirector): BoundingBox | null {
  return previews.get(d)?.bounds() ?? null
}

export class NativeOutfitter {
  private epoch = 0
  private closed = false as boolean
  private kind: 'character' | 'bag' | 'poster' | 'sound' = 'character'
  private subject: Entity | null = null
  private release: (() => void) | null = null
  private yaw = 25
  private loading: Promise<void> = Promise.resolve()
  private shown: ItemId | null | undefined = null
  private readonly d: NativeDirector
  constructor(d: NativeDirector) {
    this.d = d
    previews.set(d, this)
  }
  enter(): void {
    this.yaw = 25
    this.show(null)
  }
  show(id: ItemId | null): void {
    if (this.closed || id === this.shown) {
      return
    }
    this.shown = id
    const epoch = ++this.epoch
    this.release?.()
    this.release = null
    this.subject = null
    this.kind = 'character'
    if (id?.startsWith('bag.')) {
      this.kind = 'bag'
    } else if (id?.startsWith('frame.')) {
      this.kind = 'poster'
    } else if (id?.startsWith('sound.')) {
      this.kind = 'sound'
    }
    this.visible()
    if (this.kind === 'character') {
      this.d.player?.face(this.yaw)
    }
    if (this.kind === 'bag' && id) {
      this.loading = this.loading
        .then(() => this.loadBag(id, epoch))
        .catch((error: unknown) => {
          if (epoch === this.epoch && !this.closed) {
            this.shown = undefined
            this.d.c.hud.fake(
              error instanceof Error ? error.message : 'Could not load this bag.',
              4000,
            )
          }
        })
    }
  }
  rotate(degrees: number): void {
    if (this.closed || !Number.isFinite(degrees)) {
      return
    }
    this.yaw = (this.yaw + degrees) % 360
    if (this.kind === 'bag') {
      this.subject?.setEulerAngles(0, this.yaw, 0)
    } else if (this.kind === 'character') {
      this.d.player?.face(this.yaw)
    }
  }
  private visible(): void {
    if (this.d.player) {
      this.d.player.root.enabled = this.kind === 'character'
    }
  }
  private async loadBag(id: ItemId, epoch: number): Promise<void> {
    if (epoch !== this.epoch || this.closed) {
      return
    }
    const key = `bag${bagStyleIndex(id)}` as 'bag0' | 'bag1' | 'bag2' | 'bag3'
    const url = DYNAMIC_ASSETS[key].url
    const asset = await this.d.game.loadContainer(url)
    let releaseMaterial: (() => void) | null = null
    let subject: Entity | null = null
    const release = () => {
      subject?.destroy()
      releaseMaterial?.()
      this.d.game.releaseContainer(url)
    }
    try {
      if (epoch !== this.epoch || this.closed) {
        return
      }
      releaseMaterial = await prepareNativeMaterials(
        this.d.game,
        asset.resource as ContainerResource,
      )
      if (epoch !== this.epoch || this.closed) {
        return
      }
      subject = (asset.resource as ContainerResource).instantiateRenderEntity()
      subject.name = `outfitter-${key}`
      subject.setPosition(2.4, 0.7, 7.5)
      subject.setEulerAngles(0, this.yaw, 0)
      this.d.game.stage.addChild(subject)
      this.subject = subject
      this.release = release
    } finally {
      if (this.release !== release) {
        release()
      }
    }
  }
  bounds(): BoundingBox | null {
    this.visible()
    if (!this.subject) {
      return null
    }
    const box = new BoundingBox()
    let found = false
    for (const render of this.subject.findComponents('render')) {
      for (const mesh of render.meshInstances) {
        if (found) {
          box.add(mesh.aabb)
        } else {
          box.copy(mesh.aabb)
          found = true
        }
      }
    }
    return found ? box : new BoundingBox(new Vec3(2.4, 0.9, 7.5), new Vec3(0.3, 0.3, 0.3))
  }
  destroy(): void {
    this.show(null)
    this.epoch++
    this.closed = true
    previews.delete(this.d)
  }
}
