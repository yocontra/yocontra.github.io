/**
 * What the Outfitter remembers between visits (the last tab), what it keeps when you leave (the
 * owned pieces you were trying on), and what its Buy button says. The memory is device-local and
 * best effort: private mode forgets.
 */
import type { CatalogItem, Loadout } from '../data/catalog.ts'
import { money } from '../data/economy.ts'

export const TAB_KEY = 'out-west-store-tab'

export function recall(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** A remembered choice, if it is still one of `valid`; else `fallback`. */
export function recallOne<T extends string>(key: string, valid: readonly T[], fallback: T): T {
  const v = recall(key)
  return valid.find((x) => x === v) ?? fallback
}

export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode: nothing to remember
  }
}

/**
 * Leaving with a try-on: the pieces of it you own go over what's equipped (no Equip tap needed),
 * the ones you don't come off. Null when that changes nothing.
 */
export function keptLoadout(
  wearing: Loadout | null,
  equipped: Loadout,
  owned: ReadonlySet<string>,
): Loadout | null {
  if (!wearing) {
    return null
  }
  const kept: Loadout = { ...equipped }
  let changed = false
  for (const k of Object.keys(equipped) as (keyof Loadout)[]) {
    const id = wearing[k]
    if (id !== equipped[k] && (id === null || owned.has(id))) {
      Object.assign(kept, { [k]: id })
      changed = true
    }
  }
  return changed ? kept : null
}

/** The Buy button's label for `canBuy`'s verdict. */
export function buyLabel(verdict: string, item: CatalogItem, purse: number): string {
  const label: Record<string, string> = {
    ok: `Buy · ${money(item.price)}`,
    funds: `Need ${money(item.price - purse)} more`,
    level: `Unlocks at Lv ${item.level}`,
    not_for_sale: item.unlock ?? 'Not for sale',
    owned: 'Owned',
  }
  return label[verdict] ?? 'Buy'
}
