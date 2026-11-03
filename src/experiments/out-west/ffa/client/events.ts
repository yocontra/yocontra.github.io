// biome-ignore-all lint/complexity/useMaxParams: the tracer helper takes positional options
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: event dispatch is one flat switch per event type
/**
 * Server events → what the player sees and hears: tracers and impacts, hit markers and the hurt
 * flash, the kill feed, the death poster, money bags dropping and being taken, deposits, the
 * strongbox, Most Wanted, Call Out and the showdown (fake-out cues, the bell, the verdict).
 */
import { Color, type Vector3 } from 'three'
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
  KILL_MOST_WANTED,
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
  SHOT_RANGE_UNIT,
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
import type { WireEvent } from '../sim/codec-events.ts'
import { CALLOUT_ACCEPT_TICKS, SHOTGUN_CONE_DEG, SHOTGUN_RANGE, TICK_MS } from '../sim/constants.ts'
import { TOWN } from '../sim/layout.ts'
import { aimRadians } from '../sim/move.ts'
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
import type { Hud } from './hud.ts'
import type { NetClient } from './net.ts'

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
  posOf: (id: number) => { x: number; z: number } | null
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
  /** Burning fuses by thrower: the hiss runs from the throw to the blast. */
  fuses: Map<number, Fuse>
}

const DEAD_EYE_GOLD = new Color(3, 2.4, 0.8)

function onShot(s: Sink, ev: Extract<WireEvent, { type: typeof EV_SHOT }>): void {
  const you = s.net.you
  const p = s.posOf(ev.shooter)
  if (!p) {
    return
  }
  const aim = aimRadians(ev.aim)
  const range = ev.range * SHOT_RANGE_UNIT
  const endX = p.x + Math.cos(aim) * range
  const endZ = p.z + Math.sin(aim) * range
  if (ev.shooter !== you) {
    const m = s.muzzleOf(ev.shooter, p.x, p.z, aim)
    shotFx(s, m, aim, range, ev.flags)
    play(s, shotSound(ev.flags), p, 0.75)
    if (ev.target === you) {
      s.kick(0.25)
    } else {
      // A miss that passed close to you whizzes.
      const me = s.posOf(you)
      if (me) {
        const t = (me.x - p.x) * Math.cos(aim) + (me.z - p.z) * Math.sin(aim)
        const px = p.x + Math.cos(aim) * t
        const pz = p.z + Math.sin(aim) * t
        if (t > 0 && t < range && Math.hypot(me.x - px, me.z - pz) < 2.5) {
          s.audio?.whizz((px - me.x) / 2.5)
        }
      }
    }
  }
  impactSound(s.audio, ev.flags, endX, endZ, s.posOf(you))
  if (ev.flags & SHOT_HIT) {
    s.fx.impact(endX, endZ, true)
    if (ev.shooter === you) {
      s.hud.hit(false)
    }
  } else if (ev.flags & SHOT_WALL) {
    s.fx.impact(endX, endZ, false)
  }
}

const RIFLE_WHITE = new Color(3, 2.8, 2.2)
const SHOTGUN_CONE = (SHOTGUN_CONE_DEG * Math.PI) / 180

/** Tracer and flash for a shot, by weapon (a shotgun shell is one event: draw its fan). */
export function shotFx(s: Sink, m: Vector3, aim: number, range: number, flags: number): void {
  if (flags & SHOT_SHOTGUN) {
    s.fx.pellets(m.x, m.y, m.z, aim, Math.min(range, SHOTGUN_RANGE), SHOTGUN_CONE / 2)
  } else if (flags & SHOT_RIFLE) {
    s.fx.shot(m.x, m.y, m.z, aim, range, RIFLE_WHITE)
  } else {
    s.fx.shot(m.x, m.y, m.z, aim, range, flags & SHOT_DEAD_EYE ? DEAD_EYE_GOLD : undefined)
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
  dynamite: 'DYNAMITE: G or THROW to lob it (2 s fuse)',
}

function onDamage(s: Sink, ev: Extract<WireEvent, { type: typeof EV_DAMAGE }>): void {
  if (ev.victim === s.net.you) {
    s.hud.hurt(ev.amount)
    s.kick(0.18 + ev.amount / 200)
    haptic('hit')
    if (ev.hp > 0 && Math.random() < 0.5) {
      play(s, 'gasp', null, 0.5)
    }
  }
}

function killLine(s: Sink, ev: Extract<WireEvent, { type: typeof EV_KILL }>): string {
  const marks: string[] = []
  if (ev.flags & KILL_DEAD_EYE) {
    marks.push('Dead-Eye')
  }
  if (ev.flags & KILL_SHOWDOWN) {
    marks.push('showdown')
  }
  if (ev.flags & KILL_MOST_WANTED) {
    marks.push('Most Wanted')
  }
  if (ev.flags & KILL_PARDON) {
    marks.push("sheriff's pardon")
  }
  const tail = marks.length > 0 ? ` (${marks.join(', ')})` : ''
  if (ev.killer === NONE || ev.killer === ev.victim) {
    const how = ev.killer === NONE ? 'bit the dust' : 'blew himself up'
    return `${s.net.name(ev.victim)} ${how}${tail}`
  }
  return `${s.net.name(ev.killer)} ✕ ${s.net.name(ev.victim)}${tail}`
}

function onKill(s: Sink, ev: Extract<WireEvent, { type: typeof EV_KILL }>): void {
  const you = s.net.you
  let kind: 'died' | 'you' | 'kill' = 'kill'
  if (ev.victim === you) {
    kind = 'died'
  } else if (ev.killer === you) {
    kind = 'you'
  }
  s.hud.feed(killLine(s, ev), kind)
  const p = s.posOf(ev.victim)
  if (p) {
    s.fx.dust(p.x, p.z, 8)
    play(s, 'bodyfall', p, 0.8)
  }
  if (ev.killer === you && ev.victim !== you) {
    s.hud.hit(true)
    const paid = ev.flags & (KILL_PARDON | KILL_FARMED) ? 0 : ev.bounty
    if (ev.flags & KILL_SHOWDOWN) {
      // The showdown verdict owns the big toast; the bounty goes in the feed.
      s.hud.feed(`+$${paid} bounty`, 'gold')
    } else {
      s.hud.toast(paid > 0 ? `+$${paid} BOUNTY` : 'NO BOUNTY', 'gold', 1400)
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
        s.hud.toast('SHOWDOWN: hands off… wait for the bell', 'red', 2400)
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
    return 'DEAD HEAT: nobody walks away'
  }
  if (ev.outcome === SD_FROZE) {
    return 'Nobody drew. The ring breaks.'
  }
  if (ev.outcome === SD_COWARD) {
    return ev.winner === you ? 'They flinched. Coward.' : 'You drew early. Coward.'
  }
  if (ev.outcome === SD_WIN) {
    return ev.winner === you
      ? `YOU WIN (${ev.winnerMs} ms)`
      : `${s.net.name(ev.winner)} was faster (${ev.winnerMs} ms)`
  }
  return 'The showdown was called off'
}

export function handleEvent(s: Sink, ev: WireEvent): void {
  const you = s.net.you
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
        const extra = ev.commission > 0 ? ` (+$${ev.commission} commission)` : ''
        s.hud.toast(`BANKED $${ev.amount}${extra}`, 'gold', 2200)
        play(s, 'deposit', null, 1)
        const p = s.posOf(you)
        if (p) {
          s.fx.sparkle(p.x, p.z, 18)
        }
      }
      break
    case EV_RESPAWN: {
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
      s.hud.feed(`A strongbox worth $${ev.value} turned up. Find the beacon.`, 'gold')
      play(s, 'hawk', null, 0.6)
      break
    case EV_STRONGBOX_OPEN:
      s.hud.feed(`${s.net.name(ev.by)} cracked the strongbox: $${ev.value}`, 'gold')
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
  if (ev.type === EV_DAMAGE && ev.attacker === you && ev.victim !== you) {
    const p = s.posOf(ev.victim)
    if (p) {
      s.fx.impact(p.x, p.z, true)
    }
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
        s.hud.feed('The bank is slow to confirm. Your deposit will retry.', 'info')
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
