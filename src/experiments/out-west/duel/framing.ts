import { MathUtils, type Object3D, type Vector3 } from 'three'
import { FEEL } from '../data/feel.ts'
import {
  clamp01,
  easeInOutCubic,
  easeOutCubic,
  type Framing,
  orbitPose,
  type Pose,
  twoShot,
} from '../scene/camera.ts'
import { STREET } from '../scene/street.ts'
import { type DuelState, V } from './state.ts'

/**
 * Every camera shot in the duel. Calm by rule: cuts or long eased blends,
 * slow pushes, no whip pans, no sudden lens changes.
 */

const sideOff = (s: DuelState): number => (s.portrait ? 0.9 : 1.25)
const lookOff = (s: DuelState): number => (s.portrait ? 0 : 0.1)
const restFov = (s: DuelState): number => (s.portrait ? 50 : FEEL.fovRest)
const walkFov = (s: DuelState): number => (s.portrait ? 52 : FEEL.fovWalk)
const waitFov = (s: DuelState): number => (s.portrait ? 46 : FEEL.fovWait)

export function titleShot(s: DuelState): void {
  s.c.rig.cut('title', (t) => {
    const k = easeInOutCubic(clamp01((t % 14) / 6.5))
    const back = t % 14 > 7 ? easeInOutCubic(clamp01(((t % 14) - 7) / 7)) : 0
    const e = k * (1 - back)
    return {
      pos: V(MathUtils.lerp(0.5, 2.2, e), MathUtils.lerp(19, 2.0, e), MathUtils.lerp(56, 18, e)),
      look: V(0, MathUtils.lerp(9, 1.6, e), MathUtils.lerp(0, -12, e)),
      fov: MathUtils.lerp(38, 42, e),
      handheld: 0.15,
    }
  })
}

export function posterShot(s: DuelState): void {
  const pp = STREET.posterPos
  const paper = s.c.world.poster.userData.paper as Object3D | undefined
  s.c.rig.cut('poster', (t) => {
    const k = easeOutCubic(clamp01(t / 2.2))
    if (paper) {
      const sc = t < FEEL.posterSlam ? 1.35 - 0.35 * easeOutCubic(t / FEEL.posterSlam) : 1
      paper.scale.setScalar(sc)
    }
    const d = MathUtils.lerp(2.1, 1.35, k)
    return {
      pos: V(pp.x + 0.12 + d, 1.75, pp.z + 0.02),
      look: V(pp.x + 0.12, 1.75, pp.z),
      fov: 35,
      handheld: 0.2,
    }
  })
}

export function backToBackShot(s: DuelState): void {
  s.c.rig.cut(
    'b2b',
    (t) => ({
      pos: V(3.4 - Math.min(t, 3) * 0.12, 1.15, 0.4),
      look: V(0, 1.15, 0),
      fov: 38,
      handheld: 0.3,
    }),
    0,
  )
}

export function walkShot(s: DuelState): void {
  const p = s.player
  s.c.rig.cut(
    'walk',
    () => {
      const P = p.root.position
      const back = s.portrait ? 5.2 : 4.6
      return {
        pos: V(P.x + sideOff(s), 1.3, P.z - back),
        look: V(P.x + sideOff(s) * 0.2, 1.15, P.z + 2.5),
        fov: walkFov(s),
        handheld: 0.25,
      }
    },
    1.4,
  )
}

/** Current slow, eased dolly-in during the wait (settles toward 0.9 m). */
export function waitPush(s: DuelState): number {
  if (!s.pushing || s.reduced) {
    return 0
  }
  const t = s.realTime - s.pushStart
  return 0.9 * (1 - Math.exp(-t / 4))
}

/**
 * The standoff: a longer lens from in front of you, pulled back so he reads
 * clearly past your shoulder, his back to you down the street.
 */
export function standoffShot(s: DuelState, dolly: boolean, blend: number): void {
  const p = s.player
  const e = s.enemy
  s.pushing = dolly
  s.pushStart = s.realTime
  s.c.rig.cut(
    dolly ? 'wait' : 'stop',
    () => {
      const P = p.root.position
      const E = e ? e.root.position : V(0, 0, P.z + 9)
      const k = waitPush(s)
      const back = s.portrait ? 6.2 : 5.4
      const side = sideOff(s)
      return {
        pos: V(P.x + side * (1 - k * 0.15), 1.32, P.z - back + k),
        look: V(P.x + side * 0.22, 1.2, MathUtils.lerp(P.z, E.z, 0.5)),
        fov: waitFov(s),
        handheld: 0.15,
      }
    },
    blend,
  )
}

/**
 * The boss standoff: low behind your right shoulder, tilted up so the clock
 * face the whole duel hangs on stays in frame above him.
 */
export function bossPose(s: DuelState, push: number, fovIn: number): Pose {
  const P = s.player.root.position
  const portrait = s.portrait
  const pos = V(P.x - (portrait ? 0.55 : 0.9), 1.05, P.z - 2.6 + push)
  const pitch = MathUtils.degToRad(portrait ? 15 : 13)
  const look = V(pos.x + (portrait ? 0.55 : 1.1), pos.y + Math.tan(pitch) * 10, pos.z + 10)
  return { pos, look, fov: (portrait ? 60 : 44) - fovIn, handheld: 0.15 }
}

/** Over-the-shoulder standoff framing; `dolly` adds the slow push-in of the wait. */
export function otsShot(s: DuelState, dolly: boolean, blend = 0.9): void {
  const p = s.player
  const e = s.enemy
  s.pushing = dolly
  s.pushStart = s.realTime
  const boss = s.boss
  s.c.rig.cut(
    dolly ? 'wait' : 'ots',
    () => {
      if (boss) {
        return bossPose(s, waitPush(s) * 0.5, 0)
      }
      const P = p.root.position
      const E = e ? e.root.position : V(0, 0, 10)
      const dist = Math.abs(E.z - P.z)
      const look = V(-dist * lookOff(s), 1.4, E.z)
      const pos = V(P.x - 0.55, 1.65, P.z - 1.8 + waitPush(s))
      return { pos, look, fov: restFov(s), handheld: 0.2 }
    },
    blend,
  )
}

/** A calm insert on the clock face (boss count). */
export function clockInsert(s: DuelState, seconds: number): void {
  s.clockInsertUntil = s.realTime + seconds
  const face = V(0, 12.2, STREET.churchZ - 3.22)
  s.c.rig.cut('clock', (t) => {
    const k = easeInOutCubic(clamp01(t / Math.max(0.1, seconds)))
    return {
      pos: V(0.4, 11.5, face.z - 5.6 + k * 0.35),
      look: face,
      fov: s.portrait ? 60 : 26,
    }
  })
}

/** Vertical fov (degrees) that keeps every point inside the frame, with a margin, from pos→look. */
function fitFov(pos: Vector3, look: Vector3, points: Vector3[], aspect: number): number {
  const fwd = look.clone().sub(pos).normalize()
  const right = V()
    .crossVectors(fwd, V(0, 1, 0))
    .normalize()
  const up = V().crossVectors(right, fwd)
  let tanV = 0
  for (const p of points) {
    const d = p.clone().sub(pos)
    const z = Math.max(0.1, d.dot(fwd))
    tanV = Math.max(tanV, Math.abs(d.dot(up)) / z, Math.abs(d.dot(right)) / z / aspect)
  }
  return MathUtils.radToDeg(2 * Math.atan(tanV * 1.3))
}

/**
 * The underboss's call: both guns in frame, Curly down the street and the rifleman on the
 * saloon roof, from a step behind you; the lens opens just enough to hold the pair.
 */
function underbossCallPose(s: DuelState, k: number): Pose | null {
  const r = s.rifleman
  const e = s.enemy
  if (!(r && s.riflemanAlive && e)) {
    return null
  }
  const P = s.player.root.position
  const pos = V(P.x - 1.0, 1.75, P.z - 3.2)
  const eHead = e.headPos(V())
  const rHead = r.headPos(V())
  const look = eHead.clone().lerp(rHead, 0.5)
  const fit = fitFov(pos, look, [eHead, rHead, V(eHead.x, 0.2, eHead.z)], s.c.rig.cam.aspect)
  const fov = MathUtils.clamp(fit, restFov(s), 80)
  return { pos, look, fov: fov - (s.reduced ? 0 : k * 2), handheld: 0.1 }
}

/** The call: a gentle, eased push-in on the standoff framing (no dolly-zoom whip). */
export function callShot(s: DuelState): void {
  const p = s.player
  const e = s.enemy
  const start = s.realTime
  const reduced = s.reduced
  const boss = s.boss
  const push0 = boss ? waitPush(s) * 0.5 : 0
  s.c.rig.cut('call', () => {
    const k = reduced ? 0 : easeInOutCubic(clamp01(((s.realTime - start) * 1000) / FEEL.callPushMs))
    if (boss) {
      return bossPose(s, push0, k * (FEEL.fovRest - FEEL.fovCall))
    }
    const under = s.underboss ? underbossCallPose(s, k) : null
    if (under) {
      return under
    }
    const P = p.root.position
    const E = e ? e.root.position : V(0, 0, 10)
    const dist = Math.abs(E.z - P.z)
    const look = V(-dist * lookOff(s), 1.4, E.z)
    // a step further back and out on your gun side than the standoff's: the turn and the draw
    // (hand, holster, gun coming up) stay in frame
    const pos = V(P.x - 0.8, 1.55, P.z - 2.3)
    if (reduced) {
      return { pos, look, fov: restFov(s) }
    }
    return {
      pos,
      look,
      fov: MathUtils.lerp(restFov(s), restFov(s) - (FEEL.fovRest - FEEL.fovCall), k),
      handheld: 0.1,
    }
  })
}

/** A framing with a slow eased orbit around the victim and a gentle push-in. */
export function drift(f: Framing, focus: Vector3, t: number, orbit: number): Pose {
  const k = easeInOutCubic(clamp01(t / 3.2))
  const a = orbit * k
  const rel = f.pos.clone().sub(focus)
  const cs = Math.cos(a)
  const sn = Math.sin(a)
  const pos = V(rel.x * cs + rel.z * sn, rel.y, -rel.x * sn + rel.z * cs).add(focus)
  const lrel = f.look.clone().sub(focus)
  const look = V(lrel.x * cs + lrel.z * sn, lrel.y, -lrel.x * sn + lrel.z * cs).add(focus)
  pos.lerp(look, 0.035 * k)
  return { pos, look, fov: f.fov, handheld: 0.08 }
}

/**
 * Onto the kill cam without a cut: hold the call framing on the impact, then swing around the
 * shooter's gun (`pivot`, the muzzle) onto the two-shot, eased in and out, in real time. `settled`
 * is the pose the swing lands on (the drift's first frame); the drift takes over from there, so the
 * hand-off is seamless. Reduced motion keeps the cut.
 */
interface Swing {
  /** Where the call left the camera. */
  from: Pose
  /** The shooter's muzzle. */
  pivot: Vector3
  /** Bows the swing out to the gun side (and a touch up), so it visibly arcs around the gun hand. */
  bend: Vector3
}

function swingFor(s: DuelState, victim: Vector3): Swing {
  const P = s.player.root.position
  const fwd = V(victim.x - P.x, 0, victim.z - P.z).normalize()
  // the shooter's right (his gun side) while he faces the victim
  const right = V(-fwd.z, 0, fwd.x)
  return {
    from: s.c.rig.pose(),
    pivot: s.player.muzzle(V()),
    bend: right.multiplyScalar(s.portrait ? 0.3 : 0.45).setY(0.12),
  }
}

function swingTo(s: DuelState, sw: Swing, t: number, settled: Pose): Pose | null {
  const hold = FEEL.shotSwingHold
  if (s.reduced || t >= hold + FEEL.shotSwingSeconds) {
    return null
  }
  const k = easeInOutCubic(clamp01((t - hold) / FEEL.shotSwingSeconds))
  return orbitPose(sw.from, settled, { pivot: sw.pivot, k, bend: sw.bend })
}

/** Seconds from the start of the kill cam until its drift begins (after the swing). */
const swingSeconds = (s: DuelState): number =>
  s.reduced ? 0 : FEEL.shotSwingHold + FEEL.shotSwingSeconds

/**
 * The kill cam: a two-shot from behind the shooter on his gun side, the victim big on a third.
 * The camera swings onto it around your gun from wherever the call left it, then only a slow,
 * eased drift.
 */
export function killShot(s: DuelState): void {
  const p = s.player
  const e = s.enemy
  const r = s.rifleman
  const start = s.realTime
  const orbit = s.killOrbit
  const under = s.underboss
  const E0 = e ? e.root.position.clone() : V(0, 0, 10)
  const shot = twoShot(p.root.position, E0, s.c.rig.cam.aspect, { height: e?.height ?? 1.78 })
  const sw = swingFor(s, E0)
  const lead = swingSeconds(s)
  // the roof shot lasts this long (real time) before easing down to the street
  const roofFor = s.killDur * 0.45 + FEEL.killCamLead
  s.c.rig.cut(
    'kill',
    () => {
      const t = s.realTime - start
      if (under && r) {
        const main = drift(shot, E0, t, orbit)
        const R = r.root.position
        const rp: Pose = {
          pos: V(R.x - 5, R.y + 0.4, R.z - 5),
          look: V(R.x, R.y + 1.0, R.z),
          fov: 40,
        }
        if (t < roofFor) {
          return rp
        }
        // ease from the roof down to the street instead of snapping
        const k = easeInOutCubic(clamp01((t - roofFor) / 0.8))
        main.pos = rp.pos.clone().lerp(main.pos, k)
        main.look = rp.look.clone().lerp(main.look, k)
        main.fov = MathUtils.lerp(rp.fov, main.fov, k)
        return main
      }
      const main = drift(shot, E0, Math.max(0, t - lead), orbit)
      return swingTo(s, sw, t, main) ?? main
    },
    0,
  )
}

/** The coward back-shot: the same swing onto the kill-cam two-shot, then held calm. */
export function cowardShot(s: DuelState): void {
  const e = s.enemy
  const E0 = e ? e.root.position.clone() : V(0, 0, 3)
  const shot = twoShot(s.player.root.position, E0, s.c.rig.cam.aspect, {
    height: e?.height ?? 1.78,
  })
  const start = s.realTime
  const sw = swingFor(s, E0)
  const lead = swingSeconds(s)
  s.c.rig.cut(
    'coward',
    () => {
      const t = s.realTime - start
      const main = drift(shot, E0, Math.max(0, t - lead), 0)
      return swingTo(s, sw, t, main) ?? main
    },
    0,
  )
}

/** The eye-line never closer than this to a standing man's spine, m (no camera inside a poncho). */
const DEATH_CLEARANCE = 1.15

/**
 * Pull a camera position out of any visible actor near it: back along the line from him to the
 * camera (straight back from `away` when it sits on his spine), to `clearance` metres.
 */
function clearOfActors(s: DuelState, pos: Vector3, away: Vector3, clearance: number): Vector3 {
  for (const a of [s.player, s.enemy]) {
    if (!a?.root.visible) {
      continue
    }
    const A = a.root.position
    const off = V(pos.x - A.x, 0, pos.z - A.z)
    const d = off.length()
    if (d >= clearance || pos.y > A.y + a.height + 0.2) {
      continue
    }
    const dir = d > 1e-3 ? off.divideScalar(d) : away.clone().setY(0).normalize()
    pos.x = A.x + dir.x * clearance
    pos.z = A.z + dir.z * clearance
  }
  return pos
}

/** Your death: the eye-line sinks and rolls toward the dirt. */
export function deathShot(s: DuelState): void {
  const p = s.player
  const e = s.enemy
  const reduced = s.reduced
  s.c.rig.cut(
    'death',
    (t) => {
      const P = p.root.position
      const E = e ? e.root.position : V(0, 0, 10)
      const facing = Math.sign(E.z - P.z) || 1
      const k = reduced ? 0 : easeInOutCubic(clamp01(t / FEEL.loseFall))
      const pos = V(P.x, MathUtils.lerp(1.62, 0.55, k), P.z + facing * 0.1)
      clearOfActors(s, pos, V(0, 0, -facing), DEATH_CLEARANCE)
      return {
        pos,
        look: V(E.x, MathUtils.lerp(1.5, 1.0, k), E.z),
        fov: 42,
        roll: MathUtils.degToRad(22) * k,
        handheld: 0.15,
      }
    },
    reduced ? 0.35 : FEEL.loseBlend,
  )
}

export function endShot(s: DuelState): void {
  s.c.rig.cut(
    'end',
    (t) => {
      const k = easeInOutCubic(clamp01(t / 10))
      return {
        pos: V(3, MathUtils.lerp(1.6, 22, k), MathUtils.lerp(30, 10, k)),
        look: V(0, MathUtils.lerp(4, 14, k), STREET.churchZ),
        fov: 45,
      }
    },
    1.5,
  )
}
