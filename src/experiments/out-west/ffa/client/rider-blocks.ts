/** Frontier's block list, with confirmed poster choices taking precedence over an older load. */
export class RiderBlocks {
  private names = new Set<string>()
  private pending: Map<string, boolean> | undefined = new Map()
  private readonly changed: () => void

  constructor(initial: Promise<ReadonlySet<string>>, changed: () => void) {
    this.changed = changed
    void initial.then(
      (names) => {
        this.names = new Set(names)
        for (const [name, blocked] of this.pending ?? []) {
          this.set(name, blocked)
        }
        this.pending = undefined
        this.changed()
      },
      () => {
        this.pending = undefined
      },
    )
  }

  has(name: string | undefined): boolean {
    return name !== undefined && this.names.has(name.toLowerCase())
  }

  apply(name: string, blocked: boolean): void {
    const key = name.toLowerCase()
    this.pending?.set(key, blocked)
    this.set(key, blocked)
    this.changed()
  }

  private set(name: string, blocked: boolean): void {
    if (blocked) {
      this.names.add(name)
    } else {
      this.names.delete(name)
    }
  }
}
