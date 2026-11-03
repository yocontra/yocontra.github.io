/** Damage, kills, the Sheriff's pardon, kill bounties, death drops and bags. */
import {
  CHANNEL_NONE,
  KILL_FARMED,
  KILL_MOST_WANTED,
  KILL_PARDON,
  KILL_SHOWDOWN,
  NONE,
} from '../../contract/town.ts'
import {
  ASSIST_DAMAGE,
  ASSIST_WINDOW_TICKS,
  BAG_EXCLUSIVE_TICKS,
  BAG_EXPIRE_TICKS,
  DEATH_CAM_TICKS,
  FARM_FREE_KILLS,
  FARM_WINDOW_TICKS,
  PARDON_TICKS,
} from './constants.ts'
import { FFA_XP, ffaDeathDrop, ffaKillMint } from './progression-stub.ts'
import type { World } from './state.ts'
import type { Player } from './types.ts'

/** XP for killing a server bot. Bots never mint money, and they pay no XP so they can't be farmed. */
export const BOT_KILL_XP = 0

export function cancelChannel(w: World, p: Player): void {
  if (p.channel) {
    w.events.push({ type: 'channel_cancel', player: p.id, kind: p.channel.kind })
    p.channel = null
  }
}

/** Drop a bag of `amount` at (x, z). Returns the bag id, or −1 if nothing dropped. */
export function dropBag(
  w: World,
  x: number,
  z: number,
  amount: number,
  exclusiveFor: number,
): number {
  if (amount <= 0) {
    return -1
  }
  const bag = {
    id: w.nextBagId,
    x,
    z,
    amount,
    exclusiveFor,
    exclusiveUntil: exclusiveFor === NONE ? 0 : w.tick + BAG_EXCLUSIVE_TICKS,
    expiresAt: w.tick + BAG_EXPIRE_TICKS,
  }
  w.nextBagId = (w.nextBagId % 65_535) + 1
  w.bags.push(bag)
  w.events.push({ type: 'bag_drop', bag })
  return bag.id
}

/** Drop and burn a player's carry (death, disconnect, leaving outside the bank). */
export function spillCarry(w: World, p: Player, exclusiveFor: number, showdown: boolean): void {
  const { drop, burn } = ffaDeathDrop(p.carried, showdown)
  p.carried = 0
  w.burned += burn
  dropBag(w, p.x, p.z, drop, exclusiveFor)
}

/** Count this kill against the farm cap. True if it is the 4th+ kill of `victim` in 10 minutes. */
function isFarmed(w: World, killer: Player, victim: Player): boolean {
  const recent = (killer.kills.get(victim.accountId) ?? []).filter(
    (t) => w.tick - t < FARM_WINDOW_TICKS,
  )
  recent.push(w.tick)
  killer.kills.set(victim.accountId, recent)
  return recent.length > FARM_FREE_KILLS
}

function payAssists(w: World, victim: Player, killer: number): void {
  const byAttacker = new Map<number, number>()
  for (const d of victim.damage) {
    if (d.from !== killer && w.tick - d.tick <= ASSIST_WINDOW_TICKS) {
      byAttacker.set(d.from, (byAttacker.get(d.from) ?? 0) + d.amount)
    }
  }
  for (const [id, amount] of byAttacker) {
    const helper = w.players[id]
    if (helper && !helper.gone && amount >= ASSIST_DAMAGE && !victim.bot) {
      helper.stats.xp += FFA_XP.assist
    }
  }
}

export interface KillOptions {
  deadEye?: boolean
  showdown?: boolean
  /** Showdown losers drop 100% and burn nothing. */
  showdownDrop?: boolean
}

/** Credit the killer: bounty into carried cash, XP, unless pardoned or farmed. Returns flags. */
function creditKiller(w: World, killer: Player, victim: Player, opts: KillOptions): number {
  let flags = 0
  const pardoned = !opts.showdown && w.tick - victim.spawnTick < PARDON_TICKS
  if (pardoned) {
    return KILL_PARDON
  }
  if (isFarmed(w, killer, victim)) {
    return KILL_FARMED
  }
  killer.stats.kills++
  const mostWanted = w.mostWanted === victim.id
  if (mostWanted) {
    flags |= KILL_MOST_WANTED
  }
  if (victim.bot) {
    killer.stats.xp += BOT_KILL_XP
    return flags
  }
  const bounty = ffaKillMint(victim.level, victim.prestige, mostWanted)
  killer.carried += bounty
  w.minted += bounty
  killer.stats.xp += FFA_XP.kill + (opts.deadEye ? FFA_XP.deadEyeKill : 0)
  if (opts.deadEye) {
    killer.stats.deadEyeKills++
  }
  return flags
}

export function killPlayer(
  w: World,
  victim: Player,
  killerId: number,
  opts: KillOptions = {},
): void {
  const killer = killerId === NONE ? null : w.players[killerId]
  victim.alive = false
  victim.hp = 0
  victim.respawnTick = w.tick + DEATH_CAM_TICKS
  victim.stats.deaths++
  victim.rollTicks = 0
  victim.deadEyeStart = -1
  victim.calledBy = NONE
  cancelChannel(w, victim)
  let flags = opts.showdown ? KILL_SHOWDOWN : 0
  let bounty = 0
  if (killer && killer !== victim) {
    const before = killer.carried
    flags |= creditKiller(w, killer, victim, opts)
    bounty = killer.carried - before
    if ((flags & (KILL_PARDON | KILL_FARMED)) === 0) {
      payAssists(w, victim, killer.id)
    }
  }
  if ((flags & KILL_PARDON) === 0) {
    spillCarry(w, victim, killer ? killer.id : NONE, opts.showdownDrop === true)
  }
  victim.damage = []
  if (w.mostWanted === victim.id) {
    w.mostWanted = NONE
  }
  w.events.push({
    type: 'kill',
    victim: victim.id,
    killer: killer ? killer.id : NONE,
    flags,
    bounty,
  })
}

/** Apply hit damage. Returns true if the hit killed the target. */
export function applyDamage(
  w: World,
  target: Player,
  attacker: Player,
  amount: number,
  deadEye: boolean,
): boolean {
  const dealt = Math.min(target.hp, amount)
  target.hp -= amount
  target.lastDamageTick = w.tick
  target.damage.push({ from: attacker.id, amount: dealt, tick: w.tick })
  if (target.damage.length > 16) {
    target.damage.shift()
  }
  if (target.channel && target.channel.kind !== CHANNEL_NONE) {
    cancelChannel(w, target)
  }
  w.events.push({
    type: 'damage',
    victim: target.id,
    attacker: attacker.id,
    amount: Math.round(dealt),
    hp: Math.max(0, Math.ceil(target.hp)),
  })
  if (deadEye && !target.hatless) {
    target.hatless = true
    w.events.push({ type: 'hat_off', player: target.id })
  }
  if (target.hp <= 0) {
    killPlayer(w, target, attacker.id, { deadEye })
    return true
  }
  return false
}
