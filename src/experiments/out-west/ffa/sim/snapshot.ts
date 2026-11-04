/**
 * World → wire: entity and self views, interest management (40 m at 20 Hz, 40–60 m at 10 Hz,
 * nothing beyond), per-socket delta baselines, and event relevance. Pure, so a loopback server in
 * the browser can use it as well as the lobby DO.
 */
import {
  ANIM_AIM,
  ANIM_CHANNEL,
  ANIM_DEAD,
  ANIM_DUEL,
  ANIM_HOP,
  ANIM_IDLE,
  ANIM_RELOAD,
  ANIM_ROLL,
  ANIM_RUN,
  ANIM_SLIDE,
  ANIM_VAULT,
  BOX_NONE,
  BOX_OPENING,
  BOX_WAITING,
  EF_ALIVE,
  EF_CHANNELING,
  EF_HATLESS,
  EF_HOLSTERED,
  EF_LINGERING,
  EF_MOST_WANTED,
  EF_PROTECTED,
  EF_SHOWDOWN,
  INPUT_LEAD_NONE,
  MOVE_SPRINTING,
  NONE,
  POS_SCALE,
  SELF_ALIVE,
  SELF_DEAD_EYE_READY,
  SELF_FROZEN,
  SELF_HOLSTERED,
  SELF_IN_SHOWDOWN,
  SELF_MOST_WANTED,
  SELF_PROTECTED,
  SELF_RELOADING,
  SNAP_FULL,
  STANCE_ADS,
  STANCE_CROUCH,
  STANCE_SPRINT,
} from '../../contract/town.ts'
import type { Writer } from './bytes.ts'
import { type EntityView, encodeSnapshot, type SelfView, type TownView } from './codec.ts'
import { toWireEvent, type WireEvent } from './codec-events.ts'
import { deadEyeReady, isHolstered } from './combat.ts'
import {
  HOLSTER_TICKS,
  INTEREST_FAR,
  INTEREST_NEAR,
  MOST_WANTED_REFRESH_TICKS,
} from './constants.ts'
import { radiansToAim } from './move.ts'
import { activePlayers, channelKind, dist2, humanCount, isProtected, type World } from './state.ts'
import type { Player, SimEvent } from './types.ts'

const q = (m: number): number => Math.max(0, Math.min(65_535, Math.round(m * POS_SCALE)))
/** Minimap units for the Most Wanted star (0.6 m). */
const MAP_UNIT = 0.6

/** The entity's `anim` byte: what he's doing, and his stance bits above it. */
function animOf(p: Player): number {
  const a = baseAnim(p)
  if (a === ANIM_DEAD || a === ANIM_DUEL) {
    return a
  }
  let stance = 0
  if (p.crouched) {
    stance |= STANCE_CROUCH
  }
  if (p.ads) {
    stance |= STANCE_ADS
  }
  if (p.sprinting) {
    stance |= STANCE_SPRINT
  }
  return a | stance
}

function baseAnim(p: Player): number {
  if (!p.alive) {
    return ANIM_DEAD
  }
  if (p.showdown >= 0) {
    return ANIM_DUEL
  }
  if (p.rollTicks > 0) {
    return ANIM_ROLL
  }
  if (p.slideTicks > 0) {
    return ANIM_SLIDE
  }
  if (p.climbTicks > 0) {
    return ANIM_VAULT
  }
  if (p.fallTicks > 0) {
    return ANIM_HOP
  }
  if (p.jumpTicks > 0) {
    return p.vaultStep > 0 ? ANIM_VAULT : ANIM_HOP
  }
  if (p.reloadTicks > 0) {
    return ANIM_RELOAD
  }
  if (p.channel) {
    return ANIM_CHANNEL
  }
  if (p.moving) {
    return ANIM_RUN
  }
  return p.deadEyeStart >= 0 ? ANIM_AIM : ANIM_IDLE
}

function entityFlags(w: World, p: Player): number {
  let f = 0
  const bits: [boolean, number][] = [
    [p.alive, EF_ALIVE],
    [isProtected(w, p), EF_PROTECTED],
    [isHolstered(w, p), EF_HOLSTERED],
    [w.mostWanted === p.id, EF_MOST_WANTED],
    [p.showdown >= 0, EF_SHOWDOWN],
    [p.channel !== null, EF_CHANNELING],
    [p.hatless, EF_HATLESS],
    [p.lingerUntil >= 0, EF_LINGERING],
  ]
  for (const [on, bit] of bits) {
    if (on) {
      f |= bit
    }
  }
  return f
}

export function entityView(w: World, p: Player): EntityView {
  return {
    id: p.id,
    x: q(p.x),
    z: q(p.z),
    y: Math.max(0, Math.min(255, Math.round(p.y * 10))),
    aim: p.aim >> 8,
    hp: Math.ceil(Math.max(0, p.hp)),
    flags: entityFlags(w, p),
    anim: animOf(p),
    carry: Math.min(255, Math.ceil(p.carried / 20)),
    pitch: p.alive ? p.pitch : 0,
  }
}

function selfFlags(w: World, p: Player): number {
  let f = 0
  const bits: [boolean, number][] = [
    [p.alive, SELF_ALIVE],
    [isProtected(w, p), SELF_PROTECTED],
    [isHolstered(w, p), SELF_HOLSTERED],
    [w.mostWanted === p.id, SELF_MOST_WANTED],
    [p.showdown >= 0, SELF_IN_SHOWDOWN],
    [p.showdown >= 0 || p.lingerUntil >= 0, SELF_FROZEN],
    [p.reloadTicks > 0, SELF_RELOADING],
    [deadEyeReady(w, p), SELF_DEAD_EYE_READY],
  ]
  for (const [on, bit] of bits) {
    if (on) {
      f |= bit
    }
  }
  return f
}

export function selfView(w: World, p: Player): SelfView {
  return {
    x: q(p.x),
    z: q(p.z),
    y: p.y,
    roof: p.roof,
    climbTicks: p.climbTicks,
    climbDeck: p.climbDeck,
    climbDir: p.climbDir,
    fallTicks: p.fallTicks,
    fallTotal: p.fallTotal,
    fallFromX: p.fallFromX,
    fallFromZ: p.fallFromZ,
    fallFromY: p.fallFromY,
    fallToX: p.fallToX,
    fallToZ: p.fallToZ,
    hp: Math.ceil(Math.max(0, p.hp)),
    ammo: p.ammo,
    flags: selfFlags(w, p),
    rollTicks: p.rollTicks,
    rollCooldown: p.rollCooldown,
    rollDir: radiansToAim(Math.atan2(p.rollDirZ, p.rollDirX)),
    reloadTicks: p.reloadTicks,
    fireCooldown: Math.max(0, p.fireCooldownMs) / 4,
    protectTicks: Math.max(0, p.protectUntil - w.tick),
    deadEyeTicks: p.deadEyeStart >= 0 ? w.tick - p.deadEyeStart : 0,
    channelKind: channelKind(p),
    channelTicks: p.channel?.ticks ?? 0,
    carried: p.carried,
    respawnTicks: p.alive ? 0 : Math.max(0, p.respawnTick - w.tick),
    holsterTicks: Math.max(0, HOLSTER_TICKS - (w.tick - p.lastFireTick)),
    lastButtons: p.lastButtons,
    weapon: (p.weapon & 3) | (Math.min(7, p.weaponRounds) << 2) | (p.dynamite > 0 ? 32 : 0),
    jumpTicks: p.jumpTicks,
    jumpCooldown: p.jumpCooldown,
    vaultStep: Math.round(p.vaultStep * 100),
    vaultAim: p.vaultAim,
    moveFlags: p.sprinting ? MOVE_SPRINTING : 0,
    sprintLock: p.sprintLock,
    sprintOut: p.sprintOut,
    slideTicks: p.slideTicks,
    slideCooldown: p.slideCooldown,
    slideAim: p.slideAim,
    airX: Math.round(p.airX * 100),
    airZ: Math.round(p.airZ * 100),
  }
}

export function townView(w: World, banked: number): TownView {
  const mw = w.mostWanted === NONE ? null : w.players[w.mostWanted]
  const box = w.strongbox
  let boxState = BOX_NONE
  if (box) {
    boxState = box.openedBy >= 0 ? BOX_OPENING : BOX_WAITING
  }
  return {
    mostWanted: mw ? mw.id : NONE,
    mwX: mw ? Math.min(255, Math.round(mw.x / MAP_UNIT)) : 0,
    mwZ: mw ? Math.min(255, Math.round(mw.z / MAP_UNIT)) : 0,
    strongboxSpot: box ? box.spot : NONE,
    strongboxValue: box ? Math.min(65_535, box.value) : 0,
    strongboxState: boxState,
    players: humanCount(w),
    banked,
  }
}

/** Whether a sim event goes to `viewer`. Local events (shots, damage) only within interest. */
export function eventRelevant(w: World, ev: SimEvent, viewer: Player): boolean {
  const far2 = INTEREST_FAR ** 2
  const near = (id: number): boolean => {
    const p = w.players[id]
    return (
      p !== null &&
      p !== undefined &&
      (id === viewer.id || dist2(p.x, p.z, viewer.x, viewer.z) <= far2)
    )
  }
  switch (ev.type) {
    case 'shot':
      return near(ev.shooter) || ev.target === viewer.id
    case 'damage':
      return near(ev.victim) || ev.attacker === viewer.id
    case 'channel_cancel':
    case 'hat_off':
      return near(ev.player)
    default:
      return true
  }
}

/** Per-socket encoder state: the delta baseline and whether the next snapshot must be full. */
export class ClientStream {
  readonly baseline = new Map<number, EntityView>()
  full: boolean

  constructor() {
    this.full = true
  }

  /** Force a full snapshot next (reconnects). */
  reset(): void {
    this.baseline.clear()
    this.full = true
  }
}

/** Who a snapshot is for: the viewing player and their socket's encoder state. */
export interface SnapshotViewer {
  viewer: Player
  stream: ClientStream
}

export interface SnapshotContext {
  /** The viewer's wallet as last confirmed by the ledger. */
  banked: number
  /** Sim events of this tick (already filtered for the viewer if desired). */
  events: readonly SimEvent[]
  /** The viewer's input margin since the last snapshot (`InputQueue.takeLead()`); none if absent. */
  inputLead?: number
}

/** Events that rebuild the world for a fresh baseline: bags, showdowns, taken pickups, lit fuses. */
function catchUpEvents(w: World): WireEvent[] {
  const out: WireEvent[] = []
  for (const bag of w.bags) {
    out.push(toWireEvent({ type: 'bag_drop', bag }))
  }
  for (const sd of w.showdowns.values()) {
    out.push(toWireEvent({ type: 'showdown_start', showdown: sd }))
  }
  for (const pk of w.pickups) {
    if (pk.availableAt > 0) {
      out.push(toWireEvent({ type: 'pickup_taken', spot: pk.spot, player: NONE }))
    }
  }
  for (const f of w.fuses) {
    const fuseTicks = Math.max(0, f.explodeAt - w.tick)
    out.push(toWireEvent({ type: 'dynamite_thrown', player: f.by, x: f.x, z: f.z, fuseTicks }))
  }
  return out
}

/** Build and encode this tick's snapshot for one viewer. */
export function snapshotFor(
  w: World,
  { viewer, stream }: SnapshotViewer,
  ctx: SnapshotContext,
  out: Writer,
): Uint8Array {
  const near2 = INTEREST_NEAR ** 2
  const far2 = INTEREST_FAR ** 2
  const full = stream.full
  const entities: EntityView[] = []
  const inView = new Set<number>()
  for (const p of activePlayers(w)) {
    if (p.id === viewer.id) {
      continue
    }
    const d2 = dist2(p.x, p.z, viewer.x, viewer.z)
    if (d2 > far2) {
      continue
    }
    inView.add(p.id)
    // 40–60 m: refresh every other tick (staggered by id) unless it's new to this socket.
    if (d2 > near2 && !full && stream.baseline.has(p.id) && (w.tick + p.id) % 2 !== 0) {
      continue
    }
    entities.push(entityView(w, p))
  }
  const removed: number[] = []
  for (const id of stream.baseline.keys()) {
    if (!inView.has(id)) {
      removed.push(id)
    }
  }
  const events = ctx.events.filter((ev) => eventRelevant(w, ev, viewer)).map(toWireEvent)
  const town = full || w.tick % MOST_WANTED_REFRESH_TICKS === 0 ? townView(w, ctx.banked) : null
  const bytes = encodeSnapshot(
    out,
    {
      // The state after tick T is stamped T (the history index the client's view time refers to).
      tick: w.tick - 1,
      lastInputSeq: viewer.lastSeq,
      inputLead: ctx.inputLead ?? INPUT_LEAD_NONE,
      flags: full ? SNAP_FULL : 0,
      self: selfView(w, viewer),
      entities,
      removed,
      town,
      events: full ? [...catchUpEvents(w), ...events] : events,
    },
    stream.baseline,
  )
  stream.full = false
  return bytes
}
