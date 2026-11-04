/**
 * The animation audit's state driver on the `#lineup` street (tools/anim-audit.ts): dev and
 * perf-harness builds only (the director installs it behind `PROBE`). Each state puts one man from
 * the lineup through a duel beat with the game's own calls (quickDraw, fireGun, spinHolster, the
 * death styles, the gestures), frame-stepped at a fixed dt so every capture is repeatable. The
 * lineup's men are frozen otherwise (nothing else updates them), and the rest are hidden while one
 * performs, framed by a three-quarter camera on him.
 */
import type { Gimmick } from '../data/outlaw-types.ts'
import { OUTLAWS, RIFLEMAN_LOOK } from '../data/outlaws.ts'
import type { Actor } from '../scene/actor.ts'
import { probeIndex } from '../scene/anim-probe.ts'
import { castActor } from '../scene/cast.ts'
import type { Beat } from '../scene/gesture.ts'
import { propObject } from '../scene/props.ts'
import { DEATH_STYLES } from './cues-life.ts'
import { fireGun, nearMiss, offHandOf, quickDraw, spinHolster, victoryTaunt } from './draws.ts'
import { type DuelState, V } from './state.ts'

const DT = 1 / 30
const PACE_S = 0.5

/** Who performs: an outlaw by gimmick, the player's kit (slot 18), or the rooftop rifleman. */
type Who = Gimmick | 'player' | 'rifleman' | 'any'

interface Spec {
  who: Who
  secs: number
  /** Face away from the camera at the start (a turn on the draw). */
  away?: boolean
  /** Things that happen at seconds into the state. */
  at: [number, (a: Actor, k: Ctx) => void][]
  /** Every frame, before he updates. */
  each?: (a: Actor, t: number) => void
}

interface Ctx {
  s: DuelState
}

const target = (a: Actor) => () =>
  a.root.position
    .clone()
    .add(V(Math.sin(a.root.rotation.y + 0.35) * 8, 1.25, 0))
    .setZ(a.root.position.z + Math.cos(a.root.rotation.y + 0.35) * 8)

const draw =
  (secs = 0.3, flourish = false) =>
  (a: Actor) => {
    quickDraw(a, { secs, turn: null, target: target(a), off: 'steady', flourish })
  }
const shoot = (a: Actor): void => {
  a.play('Gun_Shoot', 0.04, true, 1.8)
  fireGun(a)
}
const beat =
  (b: Beat, side = 1) =>
  (a: Actor) => {
    a.gestures.play(b, side)
  }
const walk = (a: Actor): void => {
  a.locomote(1, a.walkDuration / 2 / PACE_S)
}
const death = (grade: string) => (a: Actor) => {
  const st = DEATH_STYLES[grade]
  if (!st) {
    return
  }
  if (st.lead) {
    a.play(st.lead, 0.05, true, 1.3)
  } else {
    a.play('Death', 0.06, true, st.rate)
  }
}
const deathAfterLead = (grade: string) => (a: Actor) => {
  const st = DEATH_STYLES[grade]
  if (st?.lead) {
    a.play('Death', 0.12, true, st.rate)
  }
}
const deathSpec = (grade: string): Spec => {
  const lead = DEATH_STYLES[grade]?.leadS ?? 0
  return {
    who: 'any',
    secs: 2.6,
    at: [
      [0, draw()],
      [0.5, death(grade)],
      ...(lead > 0 ? [[0.5 + lead, deathAfterLead(grade)] as [number, (a: Actor) => void]] : []),
    ],
  }
}

/** Every duel and hub state the matrix lists, by its matrix name. */
const STATES: Record<string, Spec> = {
  idle: { who: 'any', secs: 2, at: [] },
  'hub-variety': {
    who: 'player',
    secs: 6.5,
    at: [
      [0.1, beat('glance', 1)],
      [2.1, beat('shift', -1)],
      [4.8, beat('roll', 1)],
    ],
  },
  'outfitter-turntable': {
    who: 'player',
    secs: 4,
    at: [],
    each: (a, t) => {
      a.root.rotation.y = Math.PI + 0.4 + Math.sin(t * 0.35 * 3) * 0.9
    },
  },
  'outfitter-tryon': { who: 'player', secs: 2.6, at: [[0.1, beat('admire')]] },
  cock: { who: 'any', secs: 1.4, at: [[0.1, beat('thumb')]] },
  walk: { who: 'any', secs: 2, at: [[0, walk]] },
  'walk-drunk': {
    who: 'drunk',
    secs: 3,
    at: [
      [
        0,
        (a) => {
          a.sway = 1
          walk(a)
        },
      ],
    ],
  },
  'walk-talker': {
    who: 'talker',
    secs: 3,
    at: [
      [
        0,
        (a) => {
          a.gestures.talk = 1
          walk(a)
        },
      ],
    ],
  },
  'turn-plant': {
    who: 'any',
    secs: 1.6,
    at: [
      [0, walk],
      [0.8, (a) => a.stopWalk(0.2)],
    ],
  },
  'wait-tension': {
    who: 'any',
    secs: 4,
    at: [
      [
        0,
        (a) => {
          a.gestures.hover = 1
        },
      ],
      [1.2, beat('glance', -1)],
    ],
  },
  'wait-shaky': {
    who: 'shaky',
    secs: 2.5,
    at: [
      [
        0,
        (a) => {
          a.shake = 1
          a.gestures.hover = 1
        },
      ],
    ],
  },
  'fakeout-flinch': { who: 'any', secs: 1.4, at: [[0.15, (a) => a.drawing?.flinch()]] },
  draw: { who: 'any', secs: 1.2, at: [[0, draw()]] },
  'draw-turn': {
    who: 'any',
    secs: 1.4,
    away: true,
    at: [
      [
        0,
        (a) => {
          quickDraw(a, { secs: 0.3, turn: { from: 0, to: Math.PI }, target: target(a) })
        },
      ],
    ],
  },
  'aim-hold': { who: 'any', secs: 2.4, at: [[0, draw()]] },
  fire: {
    who: 'any',
    secs: 1.4,
    at: [
      [0, draw()],
      [0.45, shoot],
    ],
  },
  'second-shot': {
    who: 'any',
    secs: 1.6,
    at: [
      [0, draw()],
      [0.45, shoot],
      [0.85, shoot],
    ],
  },
  fanning: {
    who: 'impatient',
    secs: 1.6,
    at: [
      [
        0,
        (a) => {
          quickDraw(a, { secs: 0.3, turn: null, target: target(a), off: offHandOf('impatient') })
        },
      ],
      [0.45, shoot],
      [0.7, shoot],
      [0.95, shoot],
    ],
  },
  'two-gun-draw-fire': {
    who: 'two-guns',
    secs: 1.6,
    at: [
      [0, draw()],
      [0.45, shoot],
      [0.75, shoot],
    ],
  },
  'hip-shot': {
    who: 'any',
    secs: 1.2,
    at: [
      [0, draw()],
      [0.1, shoot],
    ],
  },
  'boss-spin': { who: 'boss', secs: 1.8, at: [[0, draw(0.5, true)]] },
  'coward-backshot': {
    who: 'any',
    secs: 1.4,
    away: true,
    at: [
      [
        0,
        (a) => {
          quickDraw(a, { secs: 0.26, turn: { from: 0, to: Math.PI }, target: target(a) })
        },
      ],
      [0.3, shoot],
    ],
  },
  'hit-nonlethal': {
    who: 'boss',
    secs: 1.6,
    at: [
      [0, draw()],
      [0.5, (a) => a.play('HitRecieve', 0.05, true)],
    ],
  },
  'hit-2': { who: 'any', secs: 1.6, at: [[0.1, (a) => a.play('HitRecieve_2', 0.05, true)]] },
  'second-chance-flinch': {
    who: 'player',
    secs: 1.4,
    at: [
      [0, draw()],
      [0.35, nearMiss],
    ],
  },
  'boss-wound': {
    who: 'boss',
    secs: 2.2,
    at: [
      [0, draw()],
      [
        0.5,
        (a, k) => {
          a.play('HitRecieve', 0.05, true)
          const g = a.dropOffGun(k.s.c.scene)
          if (g) {
            k.s.c.physics.add(g, V(0.6, 1.0, -0.5), V(4, 2, 6), { side: true, ground: 0.023 })
          }
        },
      ],
    ],
  },
  'death-LIGHTNING': deathSpec('LIGHTNING'),
  'death-DEADEYE': deathSpec('DEADEYE'),
  'death-QUICK': deathSpec('QUICK'),
  'death-STEADY': deathSpec('STEADY'),
  'death-LUCKY': deathSpec('LUCKY'),
  'hat-falls': {
    who: 'any',
    secs: 2,
    at: [
      [0, draw()],
      [
        0.4,
        (a, k) => {
          a.play('Death', 0.06, true, 1)
          const hat = a.popHat()
          if (hat) {
            k.s.c.physics.add(hat, V(0.2, 2.2, -1), V(3, 2, 6), { floor: 0.002 })
          }
        },
      ],
    ],
  },
  'loss-death': {
    who: 'player',
    secs: 2.4,
    at: [
      [0, draw()],
      [0.4, (a) => a.play('Death', 0.06, true)],
    ],
  },
  'victory-twirl-holster': {
    who: 'player',
    secs: 2.8,
    at: [
      [0, draw()],
      [1.0, spinHolster],
    ],
  },
  'victory-taunt': { who: 'player', secs: 2, at: [[0.1, victoryTaunt]] },
  'rifleman-aim': { who: 'rifleman', secs: 1.5, at: [] },
  'rifleman-fire': { who: 'rifleman', secs: 1.2, at: [[0.3, (a) => a.kickLong()]] },
  'rifleman-death': { who: 'rifleman', secs: 2, at: [[0.2, (a) => a.play('Death', 0.05, true)]] },
}

export interface AnimStage {
  states: () => string[]
  /** Set a state up on its man (reset to idle first); returns his probe index and frame count. */
  run: (name: string) => { subject: number; frames: number; dt: number } | null
  /** One fixed step of the running state. */
  tick: () => number
}

/** Install the driver on `__owAnim.stage` for the lineup `men` (slot 18 is the player's kit). */
export function installStage(s: DuelState, men: Actor[]): void {
  const probe = Reflect.get(globalThis, '__owAnim') as { stage: unknown } | undefined
  if (!probe) {
    return
  }
  let rifleman: Actor | null = null
  let cur: { a: Actor; spec: Spec; t: number; fired: Set<number> } | null = null
  const pick = (who: Who): Actor | null => {
    if (who === 'rifleman') {
      if (!rifleman && s.c.rifle) {
        rifleman = castActor(s.c.assets, {
          look: RIFLEMAN_LOOK,
          hat: 'cowboy',
          hatColor: 0x1a_14_10,
          bandana: 0x3a_2a_1a,
          rifle: propObject(s.c.rifle),
        })
        s.c.scene.add(rifleman.root)
      }
      return rifleman
    }
    if (who === 'player') {
      return men[18] ?? men[0] ?? null
    }
    if (who === 'any') {
      return men[1] ?? null
    }
    const i = OUTLAWS.findIndex((o) => o.gimmick === who)
    return men[i] ?? null
  }
  const reset = (a: Actor, away: boolean): void => {
    a.drawing?.reset()
    a.holsterGun()
    a.stopAll()
    a.gestures.clear()
    a.sway = 0
    a.shake = 0
    a.twitch = 0
    a.play(a.rifle ? 'Idle_Gun_Pointing' : 'Idle', 0)
    a.root.position.set(0, 0, 3)
    a.root.rotation.set(0, away ? 0 : Math.PI, 0)
    a.update(0)
  }
  const frame = (a: Actor): void => {
    const p = a.root.position
    s.c.rig.cut('lineup', () => ({
      pos: V(p.x + 1.3, 1.4, p.z - 2.5),
      look: V(p.x, 1.0, p.z),
      fov: 44,
    }))
  }
  const stage: AnimStage = {
    states: () => Object.keys(STATES),
    run: (name) => {
      const spec = STATES[name]
      const a = spec ? pick(spec.who) : null
      if (!(spec && a)) {
        return null
      }
      for (const m of [...men, rifleman]) {
        if (m) {
          m.root.visible = m === a
        }
      }
      reset(a, spec.away ?? false)
      frame(a)
      cur = { a, spec, t: 0, fired: new Set() }
      return {
        subject: probeIndex(a),
        frames: Math.round(spec.secs / DT),
        dt: DT,
      }
    },
    tick: () => {
      if (!cur) {
        return 0
      }
      const { a, spec } = cur
      for (const [k, [at, fn]] of spec.at.entries()) {
        if (!cur.fired.has(k) && cur.t >= at - 1e-6) {
          cur.fired.add(k)
          fn(a, { s })
        }
      }
      spec.each?.(a, cur.t)
      a.update(DT)
      cur.t += DT
      return cur.t
    },
  }
  probe.stage = stage
}
