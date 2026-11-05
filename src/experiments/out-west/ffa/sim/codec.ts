/**
 * The Frontier binary codec. The byte layout is specified in `contract/town.ts`; this file
 * implements it for both ends. Pure: DataView only.
 */
import {
  ENT_AIM,
  ENT_ANIM,
  ENT_CARRY,
  ENT_FLAGS,
  ENT_HP,
  ENT_PITCH,
  ENT_POS,
  ENT_POS_FULL,
  EVENT_SIZES,
  INPUT_FRAME_BYTES,
  INPUT_HEADER_BYTES,
  INPUT_LEAD_NONE,
  MAX_FRAMES_PER_INPUT,
  MSG_INPUT,
  MSG_SNAPSHOT,
  SNAP_TOWN,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_SELF_BYTES,
} from '../../contract/town.ts'
import { clampI8, clampU8, type Writer } from './bytes.ts'
import { readEvent, type WireEvent, writeEvent } from './codec-events.ts'
import { Reader } from './reader.ts'

const clampU16 = (v: number): number => Math.max(0, Math.min(65_535, Math.round(v)))

// --- Input --------------------------------------------------------------------------------------

export interface WireFrame {
  moveX: number
  moveZ: number
  aim: number
  buttons: number
  viewTick: number
  viewFrac: number
  /** Aim pitch, ±127 = ±90° up/down (wire v6; cosmetic). */
  pitch?: number
}

export interface InputMessage {
  seq: number
  ackTick: number
  ackAgeMs: number
  frames: WireFrame[]
}

export function encodeInput(w: Writer, msg: InputMessage): Uint8Array {
  w.reset()
    .u8(MSG_INPUT)
    .u16(msg.seq)
    .u8(msg.frames.length)
    .u16(msg.ackTick)
    .u8(clampU8(msg.ackAgeMs))
  for (const f of msg.frames) {
    w.i8(clampI8(f.moveX))
      .i8(clampI8(f.moveZ))
      .u16(f.aim)
      .u16(f.buttons)
      .u16(f.viewTick)
      .u8(clampU8(f.viewFrac))
      .i8(clampI8(f.pitch ?? 0))
  }
  return w.bytes()
}

/** Strict: wrong type, size or count returns null (the server counts these as abuse). */
export function decodeInput(data: ArrayBuffer | Uint8Array): InputMessage | null {
  const r = new Reader(data)
  if (r.remaining < INPUT_HEADER_BYTES || r.u8() !== MSG_INPUT) {
    return null
  }
  const seq = r.u16()
  const n = r.u8()
  if (n < 1 || n > MAX_FRAMES_PER_INPUT || r.remaining !== 3 + n * INPUT_FRAME_BYTES) {
    return null
  }
  const ackTick = r.u16()
  const ackAgeMs = r.u8()
  const frames: WireFrame[] = []
  for (let i = 0; i < n; i++) {
    frames.push({
      moveX: r.i8(),
      moveZ: r.i8(),
      aim: r.u16(),
      buttons: r.u16(),
      viewTick: r.u16(),
      viewFrac: r.u8(),
      pitch: r.i8(),
    })
  }
  return { seq, ackTick, ackAgeMs, frames }
}

/** Expand a wrapped u16 tick to the full tick nearest `reference`. */
export function unwrapTick16(tick16: number, reference: number): number {
  const base = reference - (reference & 0xff_ff)
  let t = base + tick16
  if (t - reference > 32_768) {
    t -= 65_536
  } else if (reference - t > 32_768) {
    t += 65_536
  }
  return t
}

// --- Snapshot -----------------------------------------------------------------------------------

/** One remote entity as sent: quantised fields only. */
export interface EntityView {
  id: number
  /** Quantised position (`POS_SCALE` units per metre). */
  x: number
  z: number
  /** Feet height, decimetres (0 on the street, ~32 on a porch catwalk). */
  y: number
  aim: number
  hp: number
  flags: number
  anim: number
  carry: number
  /** Aim pitch, ±127 = ±90° (wire v6). */
  pitch?: number
}

export interface SelfView {
  x: number
  z: number
  /** Feet height, centimetres. */
  y: number
  roof: number
  climbTicks: number
  climbDeck: number
  climbDir: number
  fallTicks: number
  fallTotal: number
  fallFromX: number
  fallFromZ: number
  fallFromY: number
  fallToX: number
  fallToZ: number
  hp: number
  ammo: number
  flags: number
  rollTicks: number
  rollCooldown: number
  rollDir: number
  reloadTicks: number
  fireCooldown: number
  protectTicks: number
  deadEyeTicks: number
  channelKind: number
  channelTicks: number
  carried: number
  respawnTicks: number
  holsterTicks: number
  lastButtons: number
  /** Packed weapon state; unpack with `selfWeapon()` from the contract. */
  weapon: number
  jumpTicks: number
  jumpCooldown: number
  /** Vault travel per tick, centimetres (0: a hop or nothing). */
  vaultStep: number
  vaultAim: number
  /** `MOVE_*` bits (wire v5). */
  moveFlags: number
  sprintLock: number
  sprintOut: number
  slideTicks: number
  slideCooldown: number
  slideAim: number
  /** Velocity in the air, centimetres per tick. */
  airX: number
  airZ: number
  /** Vertical velocity, decimetres per second. */
  vy: number
  /** Feet on a surface (1) or in the air (0). */
  grounded: number
  /** Height of the surface under the feet, centimetres. */
  support: number
  /** Highest point since leaving the ground, centimetres. */
  airPeakY: number
  /** Ticks left on a committed mantle. */
  mantleTicks: number
}

export interface TownView {
  mostWanted: number
  mwX: number
  mwZ: number
  strongboxSpot: number
  strongboxValue: number
  strongboxState: number
  players: number
  banked: number
}

export interface Snapshot {
  tick: number
  lastInputSeq: number
  /** Frames of margin on this player's newest input (`INPUT_LEAD_NONE`: none since last). */
  inputLead: number
  flags: number
  self: SelfView
  /** Entities that changed or entered this tick, fully resolved against the baseline. */
  entities: EntityView[]
  removed: number[]
  town: TownView | null
  events: WireEvent[]
}

/** Field bits for an entity against its baseline (or every field when entering). */
export function entityMask(e: EntityView, base: EntityView | undefined): number {
  if (!base) {
    return ENT_POS | ENT_POS_FULL | ENT_AIM | ENT_HP | ENT_FLAGS | ENT_ANIM | ENT_CARRY | ENT_PITCH
  }
  let mask = 0
  if (e.x !== base.x || e.z !== base.z || e.y !== base.y) {
    mask |= ENT_POS
    if (Math.abs(e.x - base.x) > 127 || Math.abs(e.z - base.z) > 127) {
      mask |= ENT_POS_FULL
    }
  }
  if (e.aim !== base.aim) {
    mask |= ENT_AIM
  }
  if (e.hp !== base.hp) {
    mask |= ENT_HP
  }
  if (e.flags !== base.flags) {
    mask |= ENT_FLAGS
  }
  if (e.anim !== base.anim) {
    mask |= ENT_ANIM
  }
  if (e.carry !== base.carry) {
    mask |= ENT_CARRY
  }
  if ((e.pitch ?? 0) !== (base.pitch ?? 0)) {
    mask |= ENT_PITCH
  }
  return mask
}

function writeEntity(w: Writer, e: EntityView, base: EntityView | undefined, mask: number): void {
  w.u8(e.id).u8(mask)
  if (mask & ENT_POS) {
    if (mask & ENT_POS_FULL || !base) {
      w.u16(e.x).u16(e.z)
    } else {
      w.i8(e.x - base.x).i8(e.z - base.z)
    }
    w.u8(clampU8(e.y))
  }
  if (mask & ENT_AIM) {
    w.u8(e.aim)
  }
  if (mask & ENT_HP) {
    w.u8(e.hp)
  }
  if (mask & ENT_FLAGS) {
    w.u8(e.flags)
  }
  if (mask & ENT_ANIM) {
    w.u8(e.anim)
  }
  if (mask & ENT_CARRY) {
    w.u8(e.carry)
  }
  if (mask & ENT_PITCH) {
    w.i8(clampI8(e.pitch ?? 0))
  }
}

function readEntity(r: Reader, baseline: Map<number, EntityView>): EntityView {
  const id = r.u8()
  const mask = r.u8()
  const base = baseline.get(id)
  const e: EntityView = base
    ? { ...base }
    : { id, x: 0, z: 0, y: 0, aim: 0, hp: 0, flags: 0, anim: 0, carry: 0 }
  if (mask & ENT_POS) {
    if (mask & ENT_POS_FULL) {
      e.x = r.u16()
      e.z = r.u16()
    } else {
      e.x += r.i8()
      e.z += r.i8()
    }
    e.y = r.u8()
  }
  if (mask & ENT_AIM) {
    e.aim = r.u8()
  }
  if (mask & ENT_HP) {
    e.hp = r.u8()
  }
  if (mask & ENT_FLAGS) {
    e.flags = r.u8()
  }
  if (mask & ENT_ANIM) {
    e.anim = r.u8()
  }
  if (mask & ENT_CARRY) {
    e.carry = r.u8()
  }
  if (mask & ENT_PITCH) {
    e.pitch = r.i8()
  }
  baseline.set(id, e)
  return e
}

function writeSelf(w: Writer, s: SelfView): void {
  w.u16(s.x)
    .u16(s.z)
    .u16(clampU16(s.y * 100))
    .u8(clampU8(s.roof))
    .u8(clampU8(s.climbTicks))
    .u8(clampU8(s.climbDeck))
    .i8(clampI8(s.climbDir))
    .u8(clampU8(s.fallTicks))
    .u8(clampU8(s.fallTotal))
    .u16(clampU16(s.fallFromX * 100))
    .u16(clampU16(s.fallFromZ * 100))
    .u8(clampU8(s.fallFromY * 10))
    .u16(clampU16(s.fallToX * 100))
    .u16(clampU16(s.fallToZ * 100))
    .u8(clampU8(s.hp))
    .u8(s.ammo)
    .u8(s.flags)
    .u8(s.rollTicks)
    .u8(s.rollCooldown)
    .u16(s.rollDir)
    .u8(s.reloadTicks)
    .u8(clampU8(s.fireCooldown))
    .u8(clampU8(s.protectTicks))
    .u8(clampU8(s.deadEyeTicks))
    .u8(s.channelKind)
    .u8(clampU8(s.channelTicks))
    .u32(s.carried)
    .u8(clampU8(s.respawnTicks))
    .u8(clampU8(s.holsterTicks))
    .u16(s.lastButtons)
    .u8(s.weapon)
    .u8(clampU8(s.jumpTicks))
    .u8(clampU8(s.jumpCooldown))
    .u8(clampU8(s.vaultStep))
    .u16(s.vaultAim)
    .u8(s.moveFlags)
    .u8(clampU8(s.sprintLock))
    .u8(clampU8(s.sprintOut))
    .u8(clampU8(s.slideTicks))
    .u8(clampU8(s.slideCooldown))
    .u16(s.slideAim)
    .i8(s.airX)
    .i8(s.airZ)
    .i8(clampI8(Math.round(s.vy * 10)))
    .u8(s.grounded)
    .u16(clampU16(s.support * 100))
    .u16(clampU16(s.airPeakY * 100))
    .u8(clampU8(s.mantleTicks))
}

function readSelf(r: Reader): SelfView {
  const s: SelfView = {
    x: r.u16(),
    z: r.u16(),
    y: r.u16() / 100,
    roof: r.u8(),
    climbTicks: r.u8(),
    climbDeck: r.u8(),
    climbDir: r.i8(),
    fallTicks: r.u8(),
    fallTotal: r.u8(),
    fallFromX: r.u16() / 100,
    fallFromZ: r.u16() / 100,
    fallFromY: r.u8() / 10,
    fallToX: r.u16() / 100,
    fallToZ: r.u16() / 100,
    hp: r.u8(),
    ammo: r.u8(),
    flags: r.u8(),
    rollTicks: r.u8(),
    rollCooldown: r.u8(),
    rollDir: r.u16(),
    reloadTicks: r.u8(),
    fireCooldown: r.u8(),
    protectTicks: r.u8(),
    deadEyeTicks: r.u8(),
    channelKind: r.u8(),
    channelTicks: r.u8(),
    carried: r.u32(),
    respawnTicks: r.u8(),
    holsterTicks: r.u8(),
    lastButtons: r.u16(),
    weapon: r.u8(),
    jumpTicks: r.u8(),
    jumpCooldown: r.u8(),
    vaultStep: r.u8(),
    vaultAim: r.u16(),
    moveFlags: r.u8(),
    sprintLock: r.u8(),
    sprintOut: r.u8(),
    slideTicks: r.u8(),
    slideCooldown: r.u8(),
    slideAim: r.u16(),
    airX: r.i8(),
    airZ: r.i8(),
    vy: r.i8() / 10,
    grounded: r.u8(),
    support: r.u16() / 100,
    airPeakY: r.u16() / 100,
    mantleTicks: r.u8(),
  }
  return s
}

function writeTown(w: Writer, t: TownView): void {
  w.u8(t.mostWanted)
    .u8(t.mwX)
    .u8(t.mwZ)
    .u8(t.strongboxSpot)
    .u16(t.strongboxValue)
    .u8(t.strongboxState)
    .u8(t.players)
    .u32(t.banked)
}

function readTown(r: Reader): TownView {
  return {
    mostWanted: r.u8(),
    mwX: r.u8(),
    mwZ: r.u8(),
    strongboxSpot: r.u8(),
    strongboxValue: r.u16(),
    strongboxState: r.u8(),
    players: r.u8(),
    banked: r.u32(),
  }
}

export interface SnapshotInput {
  tick: number
  lastInputSeq: number
  inputLead: number
  flags: number
  self: SelfView
  entities: readonly EntityView[]
  removed: readonly number[]
  town: TownView | null
  events: readonly WireEvent[]
}

/**
 * Encode a snapshot, diffing entities against `baseline` (the last state sent to this socket) and
 * updating it. Entities with nothing changed are skipped.
 */
export function encodeSnapshot(
  w: Writer,
  s: SnapshotInput,
  baseline: Map<number, EntityView>,
): Uint8Array {
  const flags = s.town ? s.flags | SNAP_TOWN : s.flags & ~SNAP_TOWN
  const lead = s.inputLead === INPUT_LEAD_NONE ? INPUT_LEAD_NONE : clampI8(s.inputLead)
  w.reset().u8(MSG_SNAPSHOT).u32(s.tick).u16(s.lastInputSeq).i8(lead).u8(flags)
  const countAt = w.offset
  w.u8(0).u8(s.removed.length)
  writeSelf(w, s.self)
  for (const id of s.removed) {
    w.u8(id)
    baseline.delete(id)
  }
  let count = 0
  for (const e of s.entities) {
    const base = baseline.get(e.id)
    const mask = entityMask(e, base)
    if (mask === 0) {
      continue
    }
    writeEntity(w, e, base, mask)
    baseline.set(e.id, { ...e })
    count++
  }
  w.patchU8(countAt, count)
  if (s.town) {
    writeTown(w, s.town)
  }
  const events = s.events.slice(0, 255)
  w.u8(events.length)
  for (const ev of events) {
    writeEvent(w, ev)
  }
  return w.bytes()
}

export function decodeSnapshot(
  data: ArrayBuffer | Uint8Array,
  baseline: Map<number, EntityView>,
): Snapshot | null {
  const r = new Reader(data)
  if (r.remaining < SNAPSHOT_HEADER_BYTES + SNAPSHOT_SELF_BYTES || r.u8() !== MSG_SNAPSHOT) {
    return null
  }
  const tick = r.u32()
  const lastInputSeq = r.u16()
  const inputLead = r.i8()
  const flags = r.u8()
  const entityCount = r.u8()
  const removedCount = r.u8()
  const self = readSelf(r)
  const removed: number[] = []
  for (let i = 0; i < removedCount; i++) {
    const id = r.u8()
    removed.push(id)
    baseline.delete(id)
  }
  const entities: EntityView[] = []
  for (let i = 0; i < entityCount; i++) {
    entities.push(readEntity(r, baseline))
  }
  const town = flags & SNAP_TOWN ? readTown(r) : null
  const eventCount = r.u8()
  const events: WireEvent[] = []
  for (let i = 0; i < eventCount; i++) {
    const ev = readEvent(r)
    if (ev) {
      events.push(ev)
    }
  }
  return { tick, lastInputSeq, inputLead, flags, self, entities, removed, town, events }
}

/** Bytes an event of `type` occupies after its type byte. */
export const eventSize = (type: number): number => EVENT_SIZES[type] ?? 0
