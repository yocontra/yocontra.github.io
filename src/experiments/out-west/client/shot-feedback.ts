interface Incarnation<T> {
  spawnTick: number
  confirmed: number
  pending: Map<number, { value: T; until: number }>
}

/** Predicted feedback and duplicate suppression are scoped to the server's rider incarnation. */
export class ShotFeedback<T> {
  private readonly riders = new Map<number, Incarnation<T>>()
  private incarnation(id: number, spawnTick: number): Incarnation<T> | undefined {
    const previous = this.riders.get(id)
    if (previous && previous.spawnTick > spawnTick) {
      return undefined
    }
    if (previous?.spawnTick === spawnTick) {
      return previous
    }
    const current = {
      spawnTick,
      confirmed: -1,
      pending: new Map<number, { value: T; until: number }>(),
    }
    this.riders.set(id, current)
    return current
  }
  predict(player: { id: number; spawnTick: number; shots: number }, value: T, now: number): number {
    const { id, spawnTick, shots } = player
    const rider = this.incarnation(id, spawnTick)
    if (!rider) {
      return -1
    }
    for (const [shot, entry] of rider.pending) {
      if (entry.until < now) {
        rider.pending.delete(shot)
      }
    }
    const next = Math.max(shots, rider.confirmed, ...rider.pending.keys()) + 1
    if (rider.pending.size >= 8) {
      rider.pending.delete(rider.pending.keys().next().value ?? -1)
    }
    rider.pending.set(next, { value, until: now + 5000 })
    return next
  }
  confirm(
    id: number,
    spawnTick: number,
    shotId: number,
    now: number,
  ): { duplicate: boolean; predicted: T | undefined } {
    if (
      !(
        Number.isSafeInteger(shotId) &&
        shotId >= 0 &&
        Number.isSafeInteger(spawnTick) &&
        spawnTick >= 0
      )
    ) {
      throw new Error('The town was updated. Reload the page to play.')
    }
    const rider = this.incarnation(id, spawnTick)
    if (!rider || shotId <= rider.confirmed) {
      return { duplicate: true, predicted: undefined }
    }
    rider.confirmed = shotId
    const pending = rider.pending.get(shotId)
    rider.pending.delete(shotId)
    return {
      duplicate: false,
      predicted: pending && pending.until >= now ? pending.value : undefined,
    }
  }
  clear(): void {
    this.riders.clear()
  }
}
