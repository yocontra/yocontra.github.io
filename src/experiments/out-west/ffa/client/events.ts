// biome-ignore-all lint/complexity/useMaxParams: the tracer helper takes positional options
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: event dispatch is one flat switch per event type
// biome-ignore-all lint/style/noExcessiveLinesPerFile: one flat switch per event type stays auditable
/**
 * Server events → what the player sees and hears: tracers and impacts, hit markers and the hurt
 * flash, the kill feed, the death poster, money bags dropping and being taken, deposits, the
 * strongbox, Most Wanted, Call Out and the showdown (fake-out cues, the bell, the verdict).
 */
import { Color, Vector3 } from 'three'
import type { AudioEngine } from '../../audio/audio.ts'
import {
  EV_BAG_DROP,
  EV_BAG_GONE,
  EV_CALLOUT,
  EV_CHANNEL_CANCEL,
  EV_DAMAGE,
  EV_DEPOSIT,
  EV_DYNAMITE_THROWN,
  EV_EXPLOSION,
  EV_GLASS_BREAK,
  EV_HAT_OFF,
  EV_KILL,
  EV_LEFT,
  EV_PICKUP_READY,
  EV_PICKUP_TAKEN,
  EV_RESPAWN,
  EV_SHOT,
  EV_SHOWDOWN_CALL,
  EV_SHOWDOWN_END,
  EV_SHOWDOWN_FAKE,
  EV_SHOWDOWN_START,
  EV_STRONGBOX_OPEN,
  EV_STRONGBOX_SPAWN,
  KILL_DEAD_EYE,
  KILL_FARMED,
  KILL_PARDON,
  KILL_SHOWDOWN,
  NONE,
  POS_SCALE,
  SD_COWARD,
  SD_DEAD_HEAT,
  SD_FROZE,
  SD_WIN,
  type ServerControl,
  SHOT_DEAD_EYE,
  SHOT_HIT,
  SHOT_RIFLE,
  SHOT_SHOTGUN,
  SHOT_WALL,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../contract/town.ts'
import { haptic } from '../../platform/haptics.ts'
import type { Crowd } from '../scene/crowd.ts'
import type { Effects } from '../scene/fx.ts'
import type { Pickups } from '../scene/pickups.ts'
import { shotCoord, type WireEvent } from '../sim/codec-events.ts'
import { CALLOUT_ACCEPT_TICKS, TICK_MS } from '../sim/constants.ts'
import { TOWN } from '../sim/layout.ts'
import { aimRadians } from '../sim/move.ts'
import { impactNormal } from '../sim/surfaces.ts'
import type { ShotPoint } from '../sim/types.ts'
import {
  bagSound,
  FAKE_CUES,
  type Fuse,
  impactSound,
  PICKUP_SOUND,
  play,
  shotSound,
  startFuse,
  stopFuse,
  waitingOnMyCall,
} from './event-sounds.ts'
import { gestureFor } from './gesture-events.ts'
import type { Hud } from './hud.ts'
import { killLine, killToast } from './kill-line.ts'
import type { NetClient } from './net.ts'
import type { RagdollImpact } from './shot-impact.ts'
import { onGlassBreak } from './window-glass.ts'

export interface Showdown {
  id: number
  opponent: number
  cx: number
  cz: number
  called: boolean
  callAt: number
  shot: boolean
}

export interface Callout {
  challenger: number
  target: number
  until: number
}

export interface Sink {
  net: NetClient
  fx: Effects
  crowd: Crowd
  hud: Hud
  audio: AudioEngine | null
  kick: (amp: number) => void
  /** World position of a player right now (render position), or null if unknown. */
  posOf: (id: number) => { x: number; z: number; y?: number } | null
  /** Where a player's shot leaves the gun. */
  muzzleOf: (id: number, x: number, z: number, aim: number) => Vector3
  showdowns: Map<number, Showdown>
  callouts: Callout[]
  /** Who killed you, for the poster. */
  killer: { id: number; flags: number } | null
  onLeft: () => void
  /** True when the player behind this entity is on your block list (never shown to you). */
  blocked: (id: number) => boolean
  pickups: Pickups
  /** Capture the actual dressed pose before the crowd starts its temporary death animation. */
  ragdollKilled: (
    victim: number,
    at: { x: number; z: number; y?: number },
    from: { x: number; z: number; y?: number } | null,
    impact: RagdollImpact | null,
  ) => void
  /** Release the physical body before the player's live actor returns. */
  ragdollReleased: (player: number) => void
  /** Shatter one window pane in the scene by its shared index. */
  breakWindow: (index: number) => void
  /** You took a hit from (`x`, `z`): the HUD's damage arc points there. */
  damageFrom: (from: { x: number; z: number; y?: number }) => void
  /** You took `amount` from `attacker` (the death card's tally). */
  tookHit: (attacker: number, amount: number) => void
  /** Burning fuses by thrower: the hiss runs from the throw to the blast. */
  fuses: Map<number, Fuse>
}

const DEAD_EYE_GOLD = new Color(3, 2.4, 0.8)

function onShot(s: Sink, ev: Extract<WireEvent, { type: typeof EV_SHOT }>): void {
  const you = s.net.you
  const origin = new Vector3(shotCoord(ev.ox), shotCoord(ev.oy), shotCoord(ev.oz))
  const end = { x: shotCoord(ev.ex), y: shotCoord(ev.ey), z: shotCoord(ev.ez) }
  const pellets = ev.pellets.map((pellet) => ({
    x: shotCoord(pellet.x),
    y: shotCoord(pellet.y),
    z: shotCoord(pellet.z),
  }))
  const p = s.posOf(ev.shooter)
  const aim = aimRadians(ev.aim)
  const muzzle =
    p && Math.hypot(p.x - origin.x, (p.y ?? 0) + 1.62 - origin.y, p.z - origin.z) < 2
      ? s.muzzleOf(ev.shooter, p.x, p.z, aim)
      : origin
  // Local fire was predicted immediately. Its authoritative ray corrects spread without replaying
  // the flash/report; remote fire gets the full presentation once.
  shotFx(s, muzzle, end, ev.flags, pellets, ev.shooter !== you)
  if (ev.shooter === you) {
    s.fx.casing(muzzle.x, muzzle.y, muzzle.z, aim)
  } else {
    s.audio?.play(shotSound(ev.flags), { pos: origin, gain: 0.75 })
    if (ev.target === you) {
      s.kick(0.25)
    } else {
      // A miss that passed close to you whizzes.
      const me = s.posOf(you)
      if (me) {
        const dx = end.x - origin.x
        const dy = end.y - origin.y
        const dz = end.z - origin.z
        const len2 = dx * dx + dy * dy + dz * dz
        const eyeY = (me.y ?? 0) + 1.2
        const t =
          len2 > 0
            ? ((me.x - origin.x) * dx + (eyeY - origin.y) * dy + (me.z - origin.z) * dz) / len2
            : -1
        const px = origin.x + dx * t
        const py = origin.y + dy * t
        const pz = origin.z + dz * t
        if (t > 0 && t < 1 && Math.hypot(me.x - px, eyeY - py, me.z - pz) < 2.5) {
          s.audio?.whizz((px - me.x) / 2.5)
        }
      }
    }
  }
  impactSound(s.audio, ev.flags, end, s.posOf(you))
  if (ev.flags & SHOT_HIT) {
    s.fx.impactAt(end.x, end.y, end.z, true)
    if (ev.shooter === you) {
      // a Dead-Eye hit is the critical one: gold, and a sharper tick
      const crit = (ev.flags & SHOT_DEAD_EYE) !== 0
      s.hud.hit(false, crit)
      s.audio?.play('hitBody', { gain: crit ? 0.55 : 0.4, rate: crit ? 1.9 : 1.6, priority: true })
    }
  } else if (ev.flags & SHOT_WALL) {
    s.fx.impactAt(end.x, end.y, end.z, false)
    // The mark sits flush to the surface, independent of the incoming bullet angle.
    const dx = end.x - origin.x
    const dy = end.y - origin.y
    const dz = end.z - origin.z
    const normal = impactNormal(s.net.grid, end, { x: dx, y: dy, z: dz })
    s.fx.hole(end.x, end.y, end.z, normal.x, normal.y, normal.z)
  }
}

const RIFLE_WHITE = new Color(3, 2.8, 2.2)
/** Immediate no-spread feedback or a server-confirmed ray, always aimed at a 3D endpoint. */
export function shotFx(
  s: Sink,
  m: Vector3,
  end: ShotPoint,
  flags: number,
  pellets: readonly ShotPoint[] = [],
  flash = true,
): void {
  if (flags & SHOT_SHOTGUN) {
    s.fx.pellets(m, pellets.length > 0 ? pellets : [end], flash)
  } else {
    let color: Color | undefined
    if (flags & SHOT_RIFLE) {
      color = RIFLE_WHITE
    } else if (flags & SHOT_DEAD_EYE) {
      color = DEAD_EYE_GOLD
    }
    s.fx.shot(m, end, color, flash)
  }
}

function onPickups(s: Sink, ev: WireEvent, nowS: number): void {
  const you = s.net.you
  switch (ev.type) {
    case EV_PICKUP_TAKEN: {
      s.pickups.setAvailable(ev.spot, false)
      const spot = TOWN.pickups[ev.spot]
      if (spot && ev.player !== NONE) {
        s.fx.sparkle(spot.x, spot.z, 8)
        if (spot.kind !== 'dynamite') {
          s.crowd.armed(ev.player, spot.kind === 'shotgun' ? WEAPON_SHOTGUN : WEAPON_RIFLE)
        }
        if (ev.player === you) {
          s.hud.toast(PICKUP_TOAST[spot.kind] ?? spot.kind.toUpperCase(), 'gold', 1600)
          play(s, PICKUP_SOUND[spot.kind] ?? 'cocking', null, 0.9)
        }
      }
      break
    }
    case EV_PICKUP_READY:
      s.pickups.setAvailable(ev.spot, true)
      break
    case EV_DYNAMITE_THROWN: {
      const from = s.posOf(ev.player) ?? { x: ev.x / POS_SCALE, z: ev.z / POS_SCALE }
      s.pickups.throw(
        from.x,
        from.z,
        ev.x / POS_SCALE,
        ev.z / POS_SCALE,
        (ev.fuseTicks * TICK_MS) / 1000,
        nowS,
      )
      play(s, 'whip', from, 0.6)
      startFuse(s.audio, s.fuses, ev)
      break
    }
    case EV_EXPLOSION: {
      const x = ev.x / POS_SCALE
      const z = ev.z / POS_SCALE
      s.pickups.explode(x, z)
      s.fx.explosion(x, z)
      stopFuse(s.fuses, ev.by)
      s.audio?.play('explosion', { pos: { x, y: 0.5, z }, priority: true })
      const me = s.posOf(you)
      const d = me ? Math.hypot(me.x - x, me.z - z) : 99
      s.kick(Math.max(0, 0.6 - d * 0.03))
      break
    }
    default:
      break
  }
}

const PICKUP_TOAST: Record<string, string> = {
  shotgun: 'SHOTGUN: 2 shells, 9 m',
  rifle: 'RIFLE: 5 rounds, 35 m',
  dynamite: 'DYNAMITE: G or THROW to throw (2 s fuse)',
}

function onDamage(s: Sink, ev: Extract<WireEvent, { type: typeof EV_DAMAGE }>): void {
  const at = s.posOf(ev.victim)
  const from = ev.attacker === ev.victim ? null : s.posOf(ev.attacker)
  if (at) {
    s.crowd.hurt(ev.victim, at, from)
  }
  if (ev.victim === s.net.you) {
    s.tookHit(ev.attacker, ev.amount)
    s.hud.hurt(ev.amount)
    if (from) {
      s.damageFrom(from)
    }
    s.kick(0.18 + ev.amount / 200)
    haptic('hit')
    if (ev.hp > 0 && Math.random() < 0.5) {
      play(s, 'gasp', null, 0.5)
    }
  }
}

function onKill(s: Sink, ev: Extract<WireEvent, { type: typeof EV_KILL }>): void {
  const you = s.net.you
  let kind: 'died' | 'you' | 'kill' = 'kill'
  if (ev.victim === you) {
    kind = 'died'
  } else if (ev.killer === you) {
    kind = 'you'
  }
  s.hud.feed(
    killLine((id) => s.net.name(id), ev),
    kind,
  )
  const p = s.posOf(ev.victim)
  const impact = s.net.takeRagdollImpact(ev.victim, ev.killer, performance.now())
  if (p) {
    const from = ev.killer === ev.victim ? null : s.posOf(ev.killer)
    s.ragdollKilled(ev.victim, p, from, impact)
    s.crowd.killed(ev.victim, p, from)
    s.fx.dust(p.x, p.z, 8)
    play(s, 'bodyfall', p, 0.8)
  }
  if (ev.killer === you && ev.victim !== you) {
    s.hud.hit(true, (ev.flags & KILL_DEAD_EYE) !== 0)
    s.audio?.play('uiStamp', { gain: 0.6, priority: true })
    const paid = ev.flags & (KILL_PARDON | KILL_FARMED) ? 0 : ev.bounty
    s.hud.killBanner(s.net.name(ev.victim), paid, (ev.flags & KILL_DEAD_EYE) !== 0)
    if (ev.flags & KILL_SHOWDOWN) {
      // The showdown verdict owns the big toast; the bounty goes in the feed.
      s.hud.feed(`+$${paid} bounty`, 'gold')
    } else {
      s.hud.toast(killToast(ev.flags, paid, s.fx.bags.values()), 'gold', 1400)
    }
  }
  if (ev.victim === you) {
    s.killer = { id: ev.killer, flags: ev.flags }
    s.kick(0.5)
  }
}

function onShowdown(s: Sink, ev: WireEvent): void {
  const you = s.net.you
  switch (ev.type) {
    case EV_CALLOUT: {
      if (s.blocked(ev.challenger) || s.blocked(ev.target)) {
        break // a blocked player's call-out is never shown (the server won't pair you anyway)
      }
      s.callouts.push({
        challenger: ev.challenger,
        target: ev.target,
        until: performance.now() + CALLOUT_ACCEPT_TICKS * TICK_MS,
      })
      if (ev.target === you) {
        s.hud.toast(`${s.net.name(ev.challenger)} CALLS YOU OUT`, 'red', 2600)
        play(s, 'shout', s.posOf(ev.challenger), 0.8)
      } else if (ev.challenger === you) {
        s.hud.toast(`You called out ${s.net.name(ev.target)}`, '', 2000)
      }
      break
    }
    case EV_SHOWDOWN_START: {
      s.callouts = s.callouts.filter((c) => c.challenger !== ev.a && c.target !== ev.b)
      const mine = ev.a === you || ev.b === you
      s.showdowns.set(ev.id, {
        id: ev.id,
        opponent: mine ? ev.a + ev.b - you : NONE,
        cx: ev.cx / POS_SCALE,
        cz: ev.cz / POS_SCALE,
        called: false,
        callAt: 0,
        shot: false,
      })
      if (mine) {
        s.hud.toast('SHOWDOWN: wait for the bell', 'red', 2400)
        s.audio?.musicLevel(-30)
      }
      break
    }
    case EV_SHOWDOWN_FAKE: {
      const sd = s.showdowns.get(ev.id)
      if (sd) {
        play(s, FAKE_CUES[ev.cue % FAKE_CUES.length] ?? 'crow', { x: sd.cx, z: sd.cz }, 0.9)
      }
      break
    }
    case EV_SHOWDOWN_CALL:
      // Bystanders: still the call (never a positional bell), but silent while your own showdown
      // waits, so another duel's bell is never taken for yours (yours is the JSON showdown_call).
      if (!s.showdowns.get(ev.id)?.called && s.showdowns.get(ev.id)?.opponent === NONE) {
        const sd = s.showdowns.get(ev.id)
        if (sd) {
          sd.called = true
          if (!waitingOnMyCall(s.showdowns)) {
            s.audio?.call()
          }
        }
      }
      break
    case EV_SHOWDOWN_END: {
      const sd = s.showdowns.get(ev.id)
      s.showdowns.delete(ev.id)
      if (sd && sd.opponent !== NONE) {
        s.hud.toast(verdict(s, ev, you), ev.winner === you ? 'gold' : 'red', 2600)
        s.audio?.musicLevel(0, 1.5) // the town's tune comes back up
      }
      break
    }
    default:
      break
  }
}

function verdict(
  s: Sink,
  ev: Extract<WireEvent, { type: typeof EV_SHOWDOWN_END }>,
  you: number,
): string {
  if (ev.outcome === SD_DEAD_HEAT) {
    return 'TIE: both died'
  }
  if (ev.outcome === SD_FROZE) {
    return 'No one drew. Showdown over.'
  }
  if (ev.outcome === SD_COWARD) {
    return ev.winner === you ? 'They drew early. You win.' : 'You drew early. You lose.'
  }
  if (ev.outcome === SD_WIN) {
    return ev.winner === you
      ? `YOU WIN (${ev.winnerMs} ms)`
      : `${s.net.name(ev.winner)} was faster (${ev.winnerMs} ms)`
  }
  return 'Showdown cancelled'
}

export function handleEvent(s: Sink, ev: WireEvent): void {
  const you = s.net.you
  gestureFor(s.crowd, ev)
  switch (ev.type) {
    case EV_SHOT:
      onShot(s, ev)
      // after the muzzle flash: the last shell puts the revolver back in his hand
      s.crowd.fired(ev.shooter, ev.flags)
      break
    case EV_DAMAGE:
      onDamage(s, ev)
      break
    case EV_KILL:
      onKill(s, ev)
      s.crowd.disarm(ev.victim)
      break
    case EV_BAG_DROP: {
      const x = ev.x / POS_SCALE
      const z = ev.z / POS_SCALE
      s.fx.bags.set(ev.bagId, {
        id: ev.bagId,
        x,
        z,
        amount: ev.amount,
        born: performance.now() / 1000,
        mine: ev.exclusiveFor === you,
      })
      s.fx.sparkle(x, z, 6)
      break
    }
    case EV_BAG_GONE: {
      const b = s.fx.bags.get(ev.bagId)
      s.fx.bags.delete(ev.bagId)
      if (b && ev.by !== NONE) {
        s.fx.sparkle(b.x, b.z, 12)
        if (ev.by === you) {
          play(s, bagSound(b.amount), null, 0.9)
          s.hud.toast(`+$${b.amount}`, 'gold', 1000)
        }
      }
      break
    }
    case EV_DEPOSIT:
      if (ev.player === you) {
        // the bank moment (round.ts) stamps the amount in the middle of the screen
        play(s, 'deposit', null, 1)
        const p = s.posOf(you)
        if (p) {
          s.fx.sparkle(p.x, p.z, 18)
        }
      }
      break
    case EV_RESPAWN: {
      s.ragdollReleased(ev.player)
      s.crowd.disarm(ev.player)
      const p = s.posOf(ev.player)
      if (p) {
        s.fx.dust(p.x, p.z, 10)
      }
      if (ev.player === you) {
        s.killer = null
        play(s, 'respawn', null, 0.9)
      }
      break
    }
    case EV_STRONGBOX_SPAWN:
      s.hud.feed(`A strongbox worth $${ev.value} appeared. Follow the beacon.`, 'gold')
      play(s, 'hawk', null, 0.6)
      break
    case EV_STRONGBOX_OPEN:
      s.hud.feed(`${s.net.name(ev.by)} opened the strongbox: $${ev.value}`, 'gold')
      if (ev.by === you) {
        s.hud.toast(`+$${ev.value} STRONGBOX`, 'gold', 2000)
        play(s, 'register', null, 1)
      }
      break
    case EV_CHANNEL_CANCEL:
      if (ev.player === you) {
        s.hud.toast('Interrupted', 'red', 900)
      }
      break
    case EV_HAT_OFF: {
      const h = s.crowd.popHat(ev.player)
      const p = s.posOf(ev.player)
      if (h && p) {
        s.fx.throwHat(h, Math.random() - 0.5, Math.random() - 0.5)
      }
      if (p) {
        s.fx.impact(p.x, p.z, false)
      }
      break
    }
    case EV_GLASS_BREAK:
      onGlassBreak(s, ev.window)
      break
    case EV_PICKUP_TAKEN:
    case EV_PICKUP_READY:
    case EV_DYNAMITE_THROWN:
    case EV_EXPLOSION:
      onPickups(s, ev, performance.now() / 1000)
      break
    case EV_LEFT:
      if (ev.player === you) {
        s.onLeft()
      }
      break
    default:
      onShowdown(s, ev)
      break
  }
  if (ev.type === EV_SHOT && ev.shooter === you && ev.flags & SHOT_DEAD_EYE) {
    s.hud.toast('DEAD-EYE', 'gold', 700)
  }
}

export function handleControl(s: Sink, msg: ServerControl): void {
  switch (msg.type) {
    case 'showdown_call': {
      const sd = s.showdowns.get(msg.showdownId)
      if (sd) {
        sd.called = true
        sd.callAt = performance.now()
      }
      s.audio?.call()
      s.hud.toast('DRAW!', 'draw', 1200)
      break
    }
    case 'deposit':
      if (!msg.ok) {
        s.hud.feed('The bank is slow. Your deposit will retry.', 'info')
      }
      break
    case 'notice':
      s.hud.feed(msg.text, 'info')
      break
    case 'error':
      s.hud.banner(msg.fatal ? msg.message : null)
      if (!msg.fatal) {
        s.hud.feed(msg.message, 'info')
      }
      break
    default:
      break
  }
}
