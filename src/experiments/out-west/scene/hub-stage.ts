/**
 * The saloon hub on the street at dusk: your gunslinger on the boardwalk outside the saloon, the
 * camera framing him beside the hub's tiles, and a slow turntable for the Outfitter's preview.
 * Also re-dresses your character when the loadout changes (single player shows it too).
 */
import { MathUtils, Vector3 } from 'three'
import type { Dyes } from '../data/dye.ts'
import type { DuelState } from '../duel/state.ts'
import { clamp01, easeInOutCubic } from './camera.ts'
import { dressedActor } from './loadout.ts'

const SPOT = new Vector3(2.4, 0, 7.5)
const HUB_DAY = 0.46

export type HubShot = 'hub' | 'store'

/** How far the look point slides right of him (landscape), and drops (portrait). */
const SIDE: Record<HubShot, number> = { hub: 1.1, store: 1.1 }
const LIFT: Record<HubShot, number> = { hub: -0.38, store: -0.55 }
/** Portrait pulls back further for the hub: the name plate above and the tiles below leave a short band. */
const PORTRAIT_PULL: Record<HubShot, number> = { hub: 1.6, store: 1.35 }

/** Swap your character for one wearing `loadout`; the duel reads `player` fresh every frame. */
export function wearLoadout(s: DuelState, loadout: unknown, dyes: Dyes = {}): void {
  const c = s.c
  const old = s.player
  const next = dressedActor(c.assets.player, c.gun, loadout, { dyes })
  next.root.position.copy(old.root.position)
  next.root.rotation.copy(old.root.rotation)
  next.root.visible = old.root.visible
  old.dispose()
  c.scene.add(next.root)
  s.setPlayer(next)
}

/** Frame your gunslinger for the hub (beside the tiles) or the Outfitter (close, turning). */
export function hubShot(s: DuelState, shot: HubShot): void {
  const c = s.c
  const p = s.player
  c.world.apply(HUB_DAY)
  c.world.setFires(false)
  c.world.setClock(18, 0)
  p.root.visible = true
  p.root.position.copy(SPOT)
  p.root.rotation.set(0, shot === 'store' ? 0.4 : -0.35, 0)
  p.stopAll()
  p.holsterGun()
  p.play('Idle', 0)
  const store = shot === 'store'
  c.rig.cut(
    store ? 'store' : 'hub',
    (t) => {
      const portrait = s.portrait
      if (store) {
        // a slow turntable, so every piece of kit is seen from the front and the back
        // (read fresh: trying on a piece swaps the whole actor mid-turn)
        s.player.root.rotation.y = 0.4 + Math.sin(t * 0.35) * 0.9
      }
      const k = easeInOutCubic(clamp01(t / 2.4))
      const dist = MathUtils.lerp(store ? 5.6 : 7.5, store ? 4.4 : 5.8, k) * (portrait ? PORTRAIT_PULL[shot] : 1)
      // the panel sits right (landscape) or below (portrait): push him the other way in frame
      const side = SIDE[shot] * (portrait ? 0 : 1)
      const lift = portrait ? LIFT[shot] : 0
      // portrait centres him above the panel; landscape keeps him left of the tiles
      const cx = SPOT.x + (portrait ? 0 : 0.6)
      return {
        pos: new Vector3(cx, 1.35, SPOT.z + dist),
        look: new Vector3(cx + side, 1.05 + lift, SPOT.z),
        fov: 38,
        handheld: 0.12,
      }
    },
    1.6,
  )
}
