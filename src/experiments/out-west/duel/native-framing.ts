import { math, Vec3 } from 'playcanvas'
import { FEEL } from '../data/feel.ts'
import type { DuelActor } from './native-actor.ts'
import {
  clamp01,
  easeInOutCubic,
  easeOutCubic,
  type Framing,
  fitFov,
  orbitPose,
  type Pose,
  twoShot,
  V,
} from './native-camera.ts'
import type { NativeDirector } from './native-director.ts'

/**
 * Every camera shot in the duel, restored from the original engine. Calm by rule: cuts or long
 * eased blends, slow pushes, no whip pans, no sudden lens changes.
 */

const portrait = (d: NativeDirector): boolean => {
  const device = d.game.app.graphicsDevice
  return device.width < device.height
}
const aspect = (d: NativeDirector): number => {
  const device = d.game.app.graphicsDevice
  return device.width / Math.max(1, device.height)
}
const reduced = (d: NativeDirector): boolean => d.c.save.settings.reducedMotion
const sideOff = (d: NativeDirector): number => (portrait(d) ? 0.9 : 1.25)
const lookOff = (d: NativeDirector): number => (portrait(d) ? 0 : 0.1)
const restFov = (d: NativeDirector): number => (portrait(d) ? 50 : FEEL.fovRest)
const walkFov = (d: NativeDirector): number => (portrait(d) ? 52 : FEEL.fovWalk)
const waitFov = (d: NativeDirector): number => (portrait(d) ? 46 : FEEL.fovWait)

const at = (actor: DuelActor | null | undefined, fallback: Vec3): Vec3 =>
  actor ? actor.root.getPosition().clone() : fallback

export function headOf(actor: DuelActor): Vec3 {
  const head = actor.model.findByName('Head')
  return head
    ? head.getPosition().clone()
    : actor.root
        .getPosition()
        .clone()
        .add(V(0, 1.6, 0))
}

function muzzleOf(actor: DuelActor): Vec3 {
  return (
    actor.muzzle()?.position.clone() ??
    actor.root
      .getPosition()
      .clone()
      .add(V(-0.3, 1.3, 0.4))
  )
}

/** The wanted poster on its post: a slam of the paper, then a slow push onto it. */
export function posterShot(d: NativeDirector): void {
  // resolved on the first framed frame: the level is presented behind the loading gate
  let anchor: ReturnType<NativeDirector['arenas']['posterAnchor']> = null
  d.rig.cut('poster', (t) => {
    anchor ??= d.arenas.posterAnchor()
    const center = anchor?.center ?? V(-8.08, 1.75, -2.5)
    const normal = anchor?.normal ?? V(1, 0, 0)
    const k = easeOutCubic(clamp01(t / 2.2))
    const slam = t < FEEL.posterSlam ? 0.6 * (1 - easeOutCubic(t / FEEL.posterSlam)) : 0
    const distance = math.lerp(2.1, 1.35, k) + slam
    return {
      pos: center.clone().add(normal.clone().mulScalar(distance)),
      look: center.clone(),
      fov: portrait(d) ? 52 : 35,
      handheld: 0.2,
    }
  })
}

/** Both men back to back as the guns are cocked. */
export function backToBackShot(d: NativeDirector): void {
  const far = portrait(d) ? 6.4 : 3.4
  d.rig.cut('b2b', (t) => ({
    pos: V(far - Math.min(t, 3) * 0.12, 1.15, 0.4),
    look: V(0, 1.1, 0),
    fov: portrait(d) ? 40 : 38,
    handheld: 0.3,
  }))
}

/** The walk: ahead of you, on your shoulder, him pacing away behind you. */
export function walkShot(d: NativeDirector): void {
  d.rig.cut(
    'walk',
    () => {
      const P = at(d.player, V(0, 0, -0.4))
      const back = portrait(d) ? 5.2 : 4.6
      return {
        pos: V(P.x + sideOff(d), 1.3, P.z - back),
        look: V(P.x + sideOff(d) * 0.2, 1.15, P.z + 2.5),
        fov: walkFov(d),
        handheld: 0.25,
      }
    },
    1.4,
  )
}

/** The wait's slow eased dolly-in (settles toward 0.9 m). */
export function waitPush(d: NativeDirector): number {
  if (!d.pushing || reduced(d)) {
    return 0
  }
  return 0.9 * (1 - Math.exp(-(d.realTime - d.pushStart) / 4))
}

/** The standoff: a longer lens from in front of you, him down the street past your shoulder. */
export function standoffShot(d: NativeDirector, dolly: boolean, blend: number): void {
  d.pushing = dolly
  d.pushStart = d.realTime
  d.rig.cut(
    dolly ? 'wait' : 'stop',
    () => {
      const P = at(d.player, V(0, 0, -4))
      const E = at(d.enemy, V(0, 0, P.z + 9))
      const k = waitPush(d)
      const back = portrait(d) ? 6.2 : 5.4
      const side = sideOff(d)
      return {
        pos: V(P.x + side * (1 - k * 0.15), 1.32, P.z - back + k),
        look: V(P.x + side * 0.22, 1.2, math.lerp(P.z, E.z, 0.5)),
        fov: waitFov(d),
        handheld: 0.15,
      }
    },
    blend,
  )
}

/** The boss standoff: low behind your right shoulder, tilted up so the clock face stays in frame. */
function bossPose(d: NativeDirector, push: number, fovIn: number): Pose {
  const P = at(d.player, V(0, 0, 44))
  const narrow = portrait(d)
  const pos = V(P.x - (narrow ? 0.55 : 0.9), 1.05, P.z - 2.6 + push)
  const pitch = (narrow ? 15 : 13) * math.DEG_TO_RAD
  const look = V(pos.x + (narrow ? 0.55 : 1.1), pos.y + Math.tan(pitch) * 10, pos.z + 10)
  return { pos, look, fov: (narrow ? 60 : 44) - fovIn, handheld: 0.15 }
}

/** Over-the-shoulder face-to-face framing (the boss); `dolly` adds the wait's push-in. */
export function otsShot(d: NativeDirector, dolly: boolean, blend = 0.9): void {
  d.pushing = dolly
  d.pushStart = d.realTime
  d.rig.cut(dolly ? 'wait' : 'ots', () => bossPose(d, waitPush(d) * 0.5, 0), blend)
}

/** A calm insert on the clock face (the boss's count). */
export function clockInsert(d: NativeDirector, seconds: number): void {
  const face = d.arenas.clockFace()
  if (!face) {
    return
  }
  d.clockInsertUntil = d.realTime + seconds
  d.rig.cut('clock', (t) => {
    const k = easeInOutCubic(clamp01(t / Math.max(0.1, seconds)))
    return {
      pos: V(face.x + 0.4, face.y - 0.7, face.z - 5.6 + k * 0.35),
      look: face.clone(),
      fov: portrait(d) ? 60 : 26,
    }
  })
}

/** The underboss's call: both guns in frame, the lens opening just enough to hold the pair. */
function underbossCallPose(d: NativeDirector, k: number): Pose | null {
  const r = d.rifleman
  const e = d.enemy
  if (!(r && d.riflemanAlive && e)) {
    return null
  }
  const P = at(d.player, V())
  const pos = V(P.x - 1.0, 1.75, P.z - 3.2)
  const eHead = headOf(e)
  const rHead = headOf(r)
  const look = new Vec3().lerp(eHead, rHead, 0.5)
  const fit = fitFov(pos, look, [eHead, rHead, V(eHead.x, 0.2, eHead.z)], aspect(d))
  const fov = math.clamp(fit, restFov(d), 80)
  return { pos, look, fov: fov - (reduced(d) ? 0 : k * 2), handheld: 0.1 }
}

const PORTRAIT_CALL_FOV = 38

/** The call: both men turn into a gentle eased push from just behind your gun shoulder. */
export function callShot(d: NativeDirector): void {
  const start = d.realTime
  const boss = d.outlaw.gimmick === 'boss'
  const push0 = boss ? waitPush(d) * 0.5 : 0
  d.rig.cut('call', () => {
    const k = reduced(d)
      ? 0
      : easeInOutCubic(clamp01(((d.realTime - start) * 1000) / FEEL.callPushMs))
    if (boss) {
      return bossPose(d, push0, k * (FEEL.fovRest - FEEL.fovCall))
    }
    const under = d.outlaw.gimmick === 'underboss' ? underbossCallPose(d, k) : null
    if (under) {
      return under
    }
    const P = at(d.player, V())
    const E = at(d.enemy, V(0, 0, 10))
    if (portrait(d)) {
      return {
        pos: V(P.x - 0.34, 1.86, P.z - 3.1),
        look: V(E.x + 0.12, 1.2, E.z),
        fov: reduced(d)
          ? PORTRAIT_CALL_FOV
          : math.lerp(PORTRAIT_CALL_FOV, PORTRAIT_CALL_FOV - 4, k),
        handheld: reduced(d) ? 0 : 0.1,
      }
    }
    const dist = Math.abs(E.z - P.z)
    const look = V(-dist * lookOff(d), 1.4, E.z)
    const pos = V(P.x - 0.8, 1.55, P.z - 2.3)
    if (reduced(d)) {
      return { pos, look, fov: restFov(d) }
    }
    return {
      pos,
      look,
      fov: math.lerp(restFov(d), restFov(d) - (FEEL.fovRest - FEEL.fovCall), k),
      handheld: 0.1,
    }
  })
}

/** A framing with a slow eased orbit around the victim and a gentle push-in. */
function drift(f: Framing, focus: Vec3, t: number, orbit: number): Pose {
  const k = easeInOutCubic(clamp01(t / 3.2))
  const a = orbit * k
  const cs = Math.cos(a)
  const sn = Math.sin(a)
  const turn = (p: Vec3): Vec3 => {
    const rel = p.clone().sub(focus)
    return V(rel.x * cs + rel.z * sn, rel.y, -rel.x * sn + rel.z * cs).add(focus)
  }
  const pos = turn(f.pos)
  const look = turn(f.look)
  pos.lerp(pos, look, 0.035 * k)
  return { pos, look, fov: f.fov, handheld: 0.08 }
}

interface Swing {
  from: Pose
  pivot: Vec3
  bend: Vec3
}

function swingFor(d: NativeDirector, victim: Vec3): Swing {
  const P = at(d.player, V())
  const fwd = V(victim.x - P.x, 0, victim.z - P.z).normalize()
  const right = V(-fwd.z, 0, fwd.x).mulScalar(portrait(d) ? 0.3 : 0.45)
  right.y = 0.12
  return {
    from: d.rig.pose(),
    pivot: d.player ? muzzleOf(d.player) : P.add(V(0, 1.3, 0)),
    bend: right,
  }
}

function swingTo(d: NativeDirector, sw: Swing, t: number, settled: Pose): Pose | null {
  const hold = FEEL.shotSwingHold
  if (reduced(d) || t >= hold + FEEL.shotSwingSeconds) {
    return null
  }
  const k = easeInOutCubic(clamp01((t - hold) / FEEL.shotSwingSeconds))
  return orbitPose(sw.from, settled, { pivot: sw.pivot, k, bend: sw.bend })
}

const swingSeconds = (d: NativeDirector): number =>
  reduced(d) ? 0 : FEEL.shotSwingHold + FEEL.shotSwingSeconds

/**
 * The kill cam: hold on the impact, swing around your gun onto a two-shot from behind your gun
 * side with him big on a third, then only a slow eased drift. The underboss opens on the roof.
 */
export function killShot(d: NativeDirector): void {
  const start = d.realTime
  const orbit = d.killOrbit
  const r = d.rifleman
  const under = d.outlaw.gimmick === 'underboss' && r
  const E0 = at(d.enemy, V(0, 0, 10))
  const shot = twoShot(at(d.player, V()), E0, aspect(d))
  const sw = swingFor(d, E0)
  const lead = swingSeconds(d)
  const roofFor = d.killDur * 0.45 + FEEL.killCamLead
  d.rig.cut('kill', () => {
    const t = d.realTime - start
    if (under) {
      const main = drift(shot, E0, t, orbit)
      const R = r.root.getPosition()
      const rp: Pose = { pos: V(R.x - 5, R.y + 0.4, R.z - 5), look: V(R.x, R.y + 1, R.z), fov: 40 }
      if (t < roofFor) {
        return rp
      }
      const k = easeInOutCubic(clamp01((t - roofFor) / 0.8))
      return {
        pos: new Vec3().lerp(rp.pos, main.pos, k),
        look: new Vec3().lerp(rp.look, main.look, k),
        fov: math.lerp(rp.fov, main.fov, k),
        handheld: 0.08,
      }
    }
    const main = drift(shot, E0, Math.max(0, t - lead), orbit)
    return swingTo(d, sw, t, main) ?? main
  })
}

/** The underboss's second gun: point the lens at whoever is still standing. */
export function secondTargetShot(d: NativeDirector, who: 0 | 1): void {
  const start = d.realTime
  d.rig.cut(
    'second',
    () => {
      const t = d.realTime - start
      const target = who === 1 ? d.rifleman : d.enemy
      const P = at(d.player, V())
      if (!target) {
        return { pos: V(P.x - 0.8, 1.55, P.z - 2.3), look: V(0, 1.4, P.z + 8), fov: 42 }
      }
      const head = headOf(target)
      if (who === 1) {
        const R = target.root.getPosition()
        return { pos: V(R.x - 5, R.y + 1.1, R.z - 5), look: head, fov: 38, handheld: 0.08 }
      }
      return {
        pos: V(P.x - 0.7, 1.55, P.z - 2.1 + Math.min(0.3, t * 0.04)),
        look: head,
        fov: math.lerp(restFov(d), 40, Math.min(1, t * 2)),
        handheld: 0.12,
      }
    },
    0.35,
  )
}

/** The coward back-shot: the same swing onto the two-shot, then held calm. */
export function cowardShot(d: NativeDirector): void {
  const E0 = at(d.enemy, V(0, 0, 3))
  const shot = twoShot(at(d.player, V()), E0, aspect(d))
  const start = d.realTime
  const sw = swingFor(d, E0)
  const lead = swingSeconds(d)
  d.rig.cut('coward', () => {
    const t = d.realTime - start
    const main = drift(shot, E0, Math.max(0, t - lead), 0)
    return swingTo(d, sw, t, main) ?? main
  })
}

/** The eye-line keeps this far from a standing man's spine, m. */
const DEATH_CLEARANCE = 2.2

function clearOfActors(d: NativeDirector, pos: Vec3, away: Vec3): Vec3 {
  for (const a of [d.player, d.enemy]) {
    if (!a?.root.enabled || a === d.player) {
      continue
    }
    const A = a.root.getPosition()
    const off = V(pos.x - A.x, 0, pos.z - A.z)
    const dist = off.length()
    if (dist >= DEATH_CLEARANCE || pos.y > A.y + 2) {
      continue
    }
    const dir = dist > 1e-3 ? off.mulScalar(1 / dist) : V(away.x, 0, away.z).normalize()
    pos.x = A.x + dir.x * DEATH_CLEARANCE
    pos.z = A.z + dir.z * DEATH_CLEARANCE
  }
  return pos
}

/** Your death: the eye-line sinks and rolls toward the dirt. */
export function deathShot(d: NativeDirector): void {
  const P0 = at(d.player, V())
  d.rig.cut(
    'death',
    (t) => {
      const E = at(d.enemy, V(0, 0, 10))
      const facing = Math.sign(E.z - P0.z) || 1
      const k = reduced(d) ? 0 : easeInOutCubic(clamp01(t / FEEL.loseFall))
      const pos = V(P0.x, math.lerp(1.62, 0.55, k), P0.z + facing * 0.1)
      clearOfActors(d, pos, V(0, 0, -facing))
      return {
        pos,
        look: V(E.x, math.lerp(1.5, 1.0, k), E.z),
        fov: 42,
        roll: 22 * math.DEG_TO_RAD * k,
        handheld: 0.15,
      }
    },
    reduced(d) ? 0.35 : FEEL.loseBlend,
  )
}

/** The end of the run: a slow crane up the street toward the clock tower. */
export function endShot(d: NativeDirector): void {
  const face = d.arenas.clockFace() ?? V(0, 12, 60)
  d.rig.cut(
    'end',
    (t) => {
      const k = easeInOutCubic(clamp01(t / 10))
      return {
        pos: V(3, math.lerp(1.6, 22, k), math.lerp(30, 10, k) + (face.z - 64)),
        look: V(0, math.lerp(4, 14, k), face.z),
        fov: 45,
      }
    },
    1.5,
  )
}
