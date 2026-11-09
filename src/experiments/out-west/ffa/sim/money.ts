/**
 * The money loop: bag pickup and expiry, bank and Stage Line channels, strongboxes, leaving town,
 * and the Most Wanted marker. All money lives here, on the server.
 */
import {
  BTN_LEAVE,
  CHANNEL_BANK,
  CHANNEL_LEAVE,
  CHANNEL_STAGE,
  CHANNEL_STRONGBOX,
  NONE,
} from '../../contract/town.ts'
import { FFA_XP, ffaBankXp, ffaDepositCommission, ffaStrongbox } from '../../data/progression.ts'
import { pressed } from './combat.ts'
import {
  BAG_PICKUP_RADIUS,
  BANK_CHANNEL_TICKS,
  LEAVE_CHANNEL_TICKS,
  MOST_WANTED_MIN,
  PRACTICE_BAG_RADIUS,
  PRACTICE_FIRST_BANK_BONUS,
  STAGE_CHANNEL_TICKS,
  STRONGBOX_CHANNEL_TICKS,
  STRONGBOX_FIRST_TICKS,
  STRONGBOX_INTERVAL_TICKS,
  STRONGBOX_RADIUS,
} from './constants.ts'
import { cancelChannel, spillCarry } from './death.ts'
import { inRect, zoneAt } from './layout.ts'
import { activePlayers, dist2, humanCount, isProtected, type World } from './state.ts'
import type { Player } from './types.ts'

/** Bank the whole carry. Banked money goes to the wallet via the lobby's ledger flush. */
export function deposit(w: World, p: Player): void {
  const amount = p.carried
  if (amount <= 0) {
    return
  }
  // The practice town's first-bank bonus rides as commission (it reaches no wallet there).
  const bonus = w.practice && !p.bot && p.depositSeq === 0 ? PRACTICE_FIRST_BANK_BONUS : 0
  const commission = ffaDepositCommission(amount) + bonus
  const xp = ffaBankXp(amount) * FFA_XP.bankPer10
  p.carried = 0
  p.depositSeq++
  p.stats.banked += amount + commission
  // Bank XP rides on the deposit entry itself, not the periodic XP flush.
  p.stats.bankXp += xp
  w.minted += commission
  w.deposits.push({
    playerId: p.id,
    accountId: p.accountId,
    seq: p.depositSeq,
    amount,
    commission,
    xp,
    bot: p.bot,
  })
  w.events.push({ type: 'deposit', player: p.id, amount, commission })
}

function strongboxDistance(w: World, p: Player): boolean {
  const box = w.strongbox
  const spot = box ? w.layout.strongboxes[box.spot] : undefined
  return (
    box !== null &&
    spot !== undefined &&
    Math.abs(p.y - (spot.y ?? 0)) <= 1.2 &&
    dist2(p.x, p.z, spot.x, spot.z) <= STRONGBOX_RADIUS ** 2
  )
}

function strongboxInReach(w: World, p: Player): boolean {
  return w.strongbox !== null && w.strongbox.openedBy < 0 && strongboxDistance(w, p)
}

/** Start a channel from a fresh press. Accepting a call-out is handled before this, by the showdown. */
export function startChannel(w: World, p: Player, buttons: number): void {
  if (p.channel || !p.alive || p.showdown >= 0 || p.lingerUntil >= 0) {
    return
  }
  if (pressed(buttons, p.lastButtons, BTN_LEAVE)) {
    p.channel = { kind: CHANNEL_LEAVE, ticks: 0, total: LEAVE_CHANNEL_TICKS }
    return
  }
  // A catwalk is not a counter: ground zones and the strongbox are out of reach from above.
  if (p.roof > 0) {
    return
  }
  // No interact key: standing still in a bank/stage zone or at the strongbox starts the hold.
  if (p.moving) {
    return
  }
  const zone = zoneAt(w.layout, p.x, p.z, p.y)
  if (zone && p.carried > 0) {
    const bank = zone.kind === 'bank'
    p.channel = {
      kind: bank ? CHANNEL_BANK : CHANNEL_STAGE,
      ticks: 0,
      total: bank ? BANK_CHANNEL_TICKS : STAGE_CHANNEL_TICKS,
      zoneId: zone.id,
    }
  } else if (strongboxInReach(w, p) && w.strongbox) {
    w.strongbox.openedBy = p.id
    w.strongbox.progress = 0
    p.channel = { kind: CHANNEL_STRONGBOX, ticks: 0, total: STRONGBOX_CHANNEL_TICKS }
  }
}

function finishChannel(w: World, p: Player, kind: number): void {
  if (kind === CHANNEL_BANK || kind === CHANNEL_STAGE) {
    deposit(w, p)
  } else if (kind === CHANNEL_STRONGBOX && w.strongbox) {
    const box = w.strongbox
    p.carried += box.value
    p.stats.xp += FFA_XP.strongbox
    w.minted += box.value
    w.events.push({ type: 'strongbox_open', spot: box.spot, by: p.id, value: box.value })
    w.strongbox = null
    w.nextStrongboxTick = w.tick + STRONGBOX_INTERVAL_TICKS
  } else if (kind === CHANNEL_LEAVE) {
    leaveTown(w, p)
  }
}

/** The end of the 5 s "Leave town" channel: banked inside the bank, dropped anywhere else. */
export function leaveTown(w: World, p: Player): void {
  if (inRect(w.grid.bankArea, p.x, p.z)) {
    deposit(w, p)
  } else {
    spillCarry(w, p, NONE, false)
  }
  p.gone = true
  w.events.push({ type: 'left', player: p.id })
}

/**
 * Advance a channel. Damage (and death) always cancels it; a zone channel only cancels when the
 * rider leaves its zone, and the strongbox channel only when the rider leaves its circle. The
 * short "leave town" channel still needs you to stand still.
 */
export function progressChannel(w: World, p: Player): void {
  const ch = p.channel
  if (!ch) {
    return
  }
  let cancel = p.lastDamageTick === w.tick || !p.alive
  if (!cancel) {
    if (ch.kind === CHANNEL_BANK || ch.kind === CHANNEL_STAGE) {
      const zone = zoneAt(w.layout, p.x, p.z, p.y)
      const want = ch.kind === CHANNEL_BANK ? 'bank' : 'stage'
      cancel = !zone || zone.kind !== want || (ch.zoneId !== undefined && zone.id !== ch.zoneId)
    } else if (ch.kind === CHANNEL_STRONGBOX) {
      cancel = !strongboxDistance(w, p) || w.strongbox?.openedBy !== p.id
    } else if (ch.kind === CHANNEL_LEAVE) {
      cancel = p.moving
    }
  }
  if (cancel) {
    if (ch.kind === CHANNEL_STRONGBOX && w.strongbox?.openedBy === p.id) {
      w.strongbox.openedBy = -1
      w.strongbox.progress = 0
    }
    cancelChannel(w, p)
    return
  }
  ch.ticks++
  if (ch.kind === CHANNEL_STRONGBOX && w.strongbox) {
    w.strongbox.progress = ch.ticks
  }
  if (ch.ticks >= ch.total) {
    p.channel = null
    finishChannel(w, p, ch.kind)
  }
}

/** Automatic pickup within 1.2 m (2.5 m in practice); the killer's 2 s exclusivity; burn after 45 s. */
export function updateBags(w: World): void {
  const r2 = (w.practice ? PRACTICE_BAG_RADIUS : BAG_PICKUP_RADIUS) ** 2
  w.bags = w.bags.filter((bag) => {
    if (w.tick >= bag.expiresAt) {
      w.burned += bag.amount
      w.events.push({ type: 'bag_gone', bagId: bag.id, by: NONE })
      return false
    }
    for (const p of activePlayers(w)) {
      const exclusive = w.tick < bag.exclusiveUntil && bag.exclusiveFor !== p.id
      const eligible =
        p.alive && p.lingerUntil < 0 && !isProtected(w, p) && p.showdown < 0 && p.roof === 0
      if (eligible && !exclusive && dist2(p.x, p.z, bag.x, bag.z) <= r2) {
        p.carried += bag.amount
        w.events.push({ type: 'bag_gone', bagId: bag.id, by: p.id })
        return false
      }
    }
    return true
  })
}

/** Spawn a strongbox at a random landmark every 3 minutes (the first a minute in). */
export function updateStrongbox(w: World): void {
  if (w.nextStrongboxTick === 0) {
    w.nextStrongboxTick = w.tick + STRONGBOX_FIRST_TICKS
  }
  if (w.strongbox || w.tick < w.nextStrongboxTick || w.layout.strongboxes.length === 0) {
    return
  }
  const spot = w.rng.int(0, w.layout.strongboxes.length - 1)
  // Bots don't count toward the value: they would print money for an empty town.
  const value = ffaStrongbox(humanCount(w))
  w.strongbox = { spot, value, openedBy: -1, progress: 0 }
  w.events.push({ type: 'strongbox_spawn', spot, value })
}

/** The player carrying the most (at least $300), refreshed every 2 s. Ties go to the lower id. */
export function refreshMostWanted(w: World): void {
  let best: Player | null = null
  for (const p of activePlayers(w)) {
    if (p.alive && p.carried >= MOST_WANTED_MIN && (!best || p.carried > best.carried)) {
      best = p
    }
  }
  w.mostWanted = best ? best.id : NONE
}
