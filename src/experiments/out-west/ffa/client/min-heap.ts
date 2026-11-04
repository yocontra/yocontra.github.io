/** A small binary min-heap of (index, priority), for the bank guide's walking-distance flood. */
export class MinHeap {
  private readonly ids: number[] = []
  private readonly pri: number[] = []

  get size(): number {
    return this.ids.length
  }

  push(id: number, p: number): void {
    const ids = this.ids
    const pri = this.pri
    let i = ids.length
    ids.push(id)
    pri.push(p)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if ((pri[parent] ?? 0) <= p) {
        break
      }
      ids[i] = ids[parent] ?? 0
      pri[i] = pri[parent] ?? 0
      i = parent
    }
    ids[i] = id
    pri[i] = p
  }

  pop(): [number, number] {
    const ids = this.ids
    const pri = this.pri
    const top: [number, number] = [ids[0] ?? 0, pri[0] ?? 0]
    const lastId = ids.pop() ?? 0
    const lastP = pri.pop() ?? 0
    const n = ids.length
    if (n === 0) {
      return top
    }
    let i = 0
    for (;;) {
      const l = i * 2 + 1
      if (l >= n) {
        break
      }
      const r = l + 1
      const c = r < n && (pri[r] ?? 0) < (pri[l] ?? 0) ? r : l
      if ((pri[c] ?? 0) >= lastP) {
        break
      }
      ids[i] = ids[c] ?? 0
      pri[i] = pri[c] ?? 0
      i = c
    }
    ids[i] = lastId
    pri[i] = lastP
    return top
  }
}
