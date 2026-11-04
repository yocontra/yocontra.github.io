/**
 * The practice town's rules for `LobbyCore`: only the client's loopback lobby sets them, never the
 * Lobby DO. Bots there ride in carrying a few dollars (so every kill drops a bag), wear levels near
 * yours, and read their skill from your record (`practiceSkill` in bots.ts). The money reaches no
 * wallet: loopback deposits are confirmed locally into the device's practice purse.
 */
import {
  PRACTICE_BOT_CARRY_MAX,
  PRACTICE_BOT_CARRY_MIN,
} from '../../../src/experiments/out-west/ffa/sim/constants.ts'
import type { World } from '../../../src/experiments/out-west/ffa/sim/state.ts'
import { practiceSkill } from './bot-skill.ts'
import type { BotDirector } from './bots.ts'

/** What the player's record on this device says, so the bots can teach rather than farm. */
export interface PracticeOptions {
  /** Practice rounds finished on this device. */
  rounds: number
  /** Lifetime practice kill/death ratio (1 with no record). */
  kd: number
}

/** Switch a lobby's world and bots to the practice rules (or back, with null). */
export function applyPractice(w: World, bots: BotDirector, rules: PracticeOptions | null): void {
  w.practice = rules !== null
  bots.practiceSkill = rules ? practiceSkill(rules.rounds, rules.kd) : null
  bots.reskill()
}

/**
 * Practice: every bot that just rode in (joined or respawned, this tick or the last) and carries
 * nothing gets a few dollars, so its death drops a bag. Nothing outside practice.
 */
export function stakeRespawns(w: World, rules: PracticeOptions | null): void {
  if (!rules) {
    return
  }
  for (const p of w.players) {
    if (p?.bot && p.alive && p.carried === 0 && w.tick - p.spawnTick <= 1) {
      const amount = w.rng.int(PRACTICE_BOT_CARRY_MIN, PRACTICE_BOT_CARRY_MAX)
      p.carried = amount
      w.minted += amount
    }
  }
}

/** A bot's level: practice bots within two of the human's; live bots spread over 1–25. */
export function botLevel(w: World, n: number, rules: PracticeOptions | null): number {
  if (!rules) {
    return 1 + (n % 25)
  }
  const you = w.players.find((p) => p !== null && !p.bot && !p.gone)
  return Math.max(1, (you?.level ?? 1) - 2 + (n % 5))
}
