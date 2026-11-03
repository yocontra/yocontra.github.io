import { DEFAULT_LOADOUT, type Loadout } from '../data/catalog.ts'
import type { Dyes } from '../data/dye.ts'
import { type Look, OUTLAWS, type Outlaw, RIFLEMAN_LOOK } from '../data/outlaws.ts'
import type { Actor } from '../scene/actor.ts'
import { castActor } from '../scene/cast.ts'
import { dressedActor } from '../scene/loadout.ts'
import type { PortraitStudio } from '../scene/portrait.ts'
import { propObject } from '../scene/props.ts'
import { drawPoster } from '../ui/poster.ts'
import { type DuelState, V } from './state.ts'

/** The player's starter kit and a dyed outfitter look, for `#lineup&kit`. */
const KITS: readonly { loadout: Loadout; dyes: Dyes }[] = [
  { loadout: { ...DEFAULT_LOADOUT }, dyes: {} },
  {
    loadout: {
      ...DEFAULT_LOADOUT,
      outfit: 'outfit.gamblers-frock',
      hat: 'hat.plainsman',
      extra: 'extra.handlebar',
    },
    dyes: { 'outfit.gamblers-frock': 'oxblood', 'hat.plainsman': 'indigo' },
  },
]

/** #lineup: every outlaw side by side in the street (for review screenshots). */
export async function lineup(s: DuelState, day: number): Promise<Actor[]> {
  const c = s.c
  const all = [...OUTLAWS.map((o) => o.look), RIFLEMAN_LOOK]
  await Promise.all(all.map((l) => c.assets.lookReady(l)))
  c.world.apply(day)
  s.player.root.visible = false
  const actors: Actor[] = []
  const hash = new URLSearchParams(location.hash.slice(1))
  const aim = hash.has('aim')
  const row = (o: Outlaw | null, look: Look, i: number): void => {
    const a = castActor(c.assets, {
      look,
      hat: o?.hat ?? 'cowboy',
      hatColor: o?.hatColor ?? 0x1a_14_10,
      // his own neckerchief (or none): only the rifleman's mask needs a cloth colour
      bandana: o ? o.bandana : 0x3a_2a_1a,
      gun: c.gun ? propObject(c.gun) : null,
      offGun: o?.gimmick === 'two-guns' || o?.gimmick === 'boss',
    })
    stand(a, i)
  }
  /** Stand him in the line at slot `i` (nine in front, the rest behind), posed. */
  const stand = (a: Actor, i: number): void => {
    const front = i < 9
    const k = front ? i : i - 9
    a.root.position.set(-6.4 + k * 1.6 + (front ? 0 : 0.8), 0, front ? 3 : 6)
    a.root.rotation.y = Math.PI
    // `aim`: everyone drawn and pointing (checks the grip on every build)
    if (aim) {
      a.draw()
      a.play('Idle_Gun_Pointing', 0)
    } else {
      a.play('Idle', 0)
    }
    a.mixer.update(aim ? 0.2 : Math.random())
    c.scene.add(a.root)
    actors.push(a)
  }
  for (const [i, o] of OUTLAWS.entries()) {
    row(o, o.look, i)
  }
  row(null, RIFLEMAN_LOOK, 17)
  // `kit`: the player as he starts, and in a dyed outfitter look (slots 18 and 19, review only)
  if (hash.has('kit')) {
    for (const [j, kit] of KITS.entries()) {
      stand(dressedActor(c.assets.player, c.gun, kit.loadout, { dyes: kit.dyes }), 18 + j)
    }
  }
  c.world.focusShadow(V(0, 0, 4))
  s.phase = 'end'
  const fa = actors[Number(hash.get('focus') ?? '-1')]
  if (fa) {
    // `at=hips`: the belt and holster instead of the face
    const h = fa.headPos(V())
    if (hash.get('at') === 'hips') {
      fa.hips?.getWorldPosition(h)
    }
    // `dist` widens the close-up (1 = head, ~2.5 = head to belt)
    const k = Number(hash.get('dist') ?? '1')
    // `yaw` swings the camera round him (radians): ~0.8 three-quarter, ~1.4 profile
    const yaw = Number(hash.get('yaw') ?? '0')
    const ox = -0.35 * k
    const oz = -1.1 * k
    c.rig.cut('lineup', () => ({
      pos: V(
        h.x + ox * Math.cos(yaw) - oz * Math.sin(yaw),
        h.y + 0.05,
        h.z + ox * Math.sin(yaw) + oz * Math.cos(yaw),
      ),
      look: V(h.x, h.y - 0.1 * k, h.z),
      fov: 35,
    }))
  } else {
    c.rig.cut('lineup', () => ({ pos: V(0, 1.55, -4.6), look: V(0, 1.05, 4.5), fov: 52 }))
  }
  return actors
}

/** #posters: all wanted posters in a grid. */
export async function posters(s: DuelState, studio: PortraitStudio): Promise<void> {
  const c = s.c
  await Promise.all(OUTLAWS.map((o) => c.assets.lookReady(o.look)))
  const grid = document.createElement('div')
  grid.className = 'ow-poster-grid'
  for (const [i, o] of OUTLAWS.entries()) {
    const cv = document.createElement('canvas')
    drawPoster(cv, o, { index: i, stamp: null, portrait: studio.render(i, o) })
    grid.appendChild(cv)
  }
  c.hud.root.appendChild(grid)
}

export interface DebugStats {
  fps: number
  ms: number
  calls: number
  tris: number
}

/** Debug overlay text. */
export function debugText(s: DuelState, st: DebugStats): string {
  const r = s.c.renderer
  const w = s.plan ? `${s.plan.e.toFixed(0)} ms` : '-'
  return [
    `fps ${st.fps.toFixed(0)}  frame ${st.ms.toFixed(1)} ms  dpr ${r.dpr.toFixed(2)} ${r.tier}`,
    `level ${s.level + 1} ${s.outlaw.name}  phase ${s.phase}${s.paused ? ' (paused)' : ''}`,
    `paces ${s.paces}/${s.target}  duel ${s.duelId}  E ${w}`,
    `last reaction ${s.lastReaction === null ? '-' : `${s.lastReaction.toFixed(1)} ms`}`,
    `draws ${st.calls}  tris ${st.tris}`,
  ].join('\n')
}
