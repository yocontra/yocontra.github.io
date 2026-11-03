/**
 * TEMPORARY local stub of stream C's `data/progression.ts` FFA formulas, with the exact agreed
 * signatures. Delete this file and import from `../../data/progression.ts` once C lands.
 */
const round5 = (n: number): number => Math.round(n / 5) * 5

const baseBounty = (level: number, prestige: number): number =>
  round5(50 * 1.065 ** (level - 1) * (1 + 0.2 * prestige))

export function ffaKillMint(victimLevel: number, victimPrestige = 0, mostWanted = false): number {
  const mint = Math.floor(0.25 * baseBounty(victimLevel, victimPrestige))
  return mostWanted ? Math.floor(mint * 1.5) : mint
}

export function ffaDeathDrop(carried: number, showdown = false): { drop: number; burn: number } {
  if (carried <= 0) {
    return { drop: 0, burn: 0 }
  }
  if (showdown) {
    return { drop: carried, burn: 0 }
  }
  const drop = Math.min(carried, Math.max(10, Math.floor(carried * 0.7)))
  return { drop, burn: carried - drop }
}

export function ffaDepositCommission(amount: number): number {
  return amount >= 500 ? Math.min(300, Math.floor(amount * 0.1)) : 0
}

export function ffaStrongbox(playersInLobby: number): number {
  return 400 + 20 * playersInLobby
}

export const FFA_XP = {
  kill: 30,
  assist: 10,
  deadEyeKill: 10,
  showdownWin: 60,
  strongbox: 50,
  bankPer10: 1,
} as const

export const ffaBankXp = (amount: number): number => Math.floor(amount / 10)
