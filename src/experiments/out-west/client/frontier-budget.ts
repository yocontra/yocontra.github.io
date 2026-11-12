/**
 * Voice budgets for Frontier's busiest families. A budget lets at most `max` sounds start inside a
 * sliding `window`; past that, a request only gets through when it arrives clearly louder than the
 * quietest sound already in the window (the nearest gun wins), and the rest are turned away (a
 * far report collapses into its tail; a far strike is lost under the near ones, as it would be).
 */
export class VoiceBudget {
  readonly max: number
  readonly window: number
  played = 0
  dropped = 0
  private readonly recent: { t: number; level: number }[] = []

  constructor(max: number, window: number) {
    this.max = max
    this.window = window
  }

  /** Whether a sound arriving at `level` (linear gain at the ear) may start at `clock`. */
  admit(clock: number, level: number): boolean {
    const recent = this.recent
    while (recent.length > 0 && clock - (recent[0] as { t: number }).t > this.window) {
      recent.shift()
    }
    if (recent.length < this.max) {
      recent.push({ t: clock, level })
      this.played++
      return true
    }
    let quietest = 0
    for (let i = 1; i < recent.length; i++) {
      if ((recent[i] as { level: number }).level < (recent[quietest] as { level: number }).level) {
        quietest = i
      }
    }
    if (level > (recent[quietest] as { level: number }).level * 1.4) {
      recent.splice(quietest, 1)
      recent.push({ t: clock, level })
      this.played++
      return true
    }
    this.dropped++
    return false
  }

  /** Sounds started inside the window as of the last request. */
  get live(): number {
    return this.recent.length
  }
}

/**
 * Round-robin over a sound's variants: every variant plays once, in a fresh random order, before
 * any repeats, and a new round never opens on the variant that closed the last one.
 */
export function variantDeck(random = Math.random): (name: string, count: number) => number {
  const decks = new Map<string, { order: number[]; last: number }>()
  return (name, count) => {
    if (count <= 1) {
      return 0
    }
    const deck = decks.get(name) ?? { order: [], last: -1 }
    decks.set(name, deck)
    if (deck.order.length === 0) {
      const order = Array.from({ length: count }, (_, i) => i)
      for (let i = count - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        ;[order[i], order[j]] = [order[j] as number, order[i] as number]
      }
      if (order[0] === deck.last) {
        order.push(order.shift() as number)
      }
      deck.order = order
    }
    const v = deck.order.shift() as number
    deck.last = v
    return v
  }
}
