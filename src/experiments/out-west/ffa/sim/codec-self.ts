/** Self snapshot layout shared by the Worker and client; velocities retain decimetre precision. */
import { clampI8, clampU8, type Writer } from './bytes.ts'
import type { Reader } from './reader.ts'

const clampU16 = (v: number): number => Math.max(0, Math.min(65_535, Math.round(v)))
const clampI16 = (v: number): number => Math.max(-32_768, Math.min(32_767, Math.round(v)))

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
  fallToY: number
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

export function writeSelf(w: Writer, s: SelfView): void {
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
    .u8(clampU8(s.fallToY * 10))
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
    .i16(clampI16(s.vy * 10))
    .u8(s.grounded)
    .u16(clampU16(s.support * 100))
    .u16(clampU16(s.airPeakY * 100))
    .u8(clampU8(s.mantleTicks))
}

export function readSelf(r: Reader): SelfView {
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
    fallToY: r.u8() / 10,
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
    vy: r.i16() / 10,
    grounded: r.u8(),
    support: r.u16() / 100,
    airPeakY: r.u16() / 100,
    mantleTicks: r.u8(),
  }
  return s
}
