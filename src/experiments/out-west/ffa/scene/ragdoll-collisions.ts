/** Cannon's default dense contact matrix clears static×static slots every substep. */
import { ArrayCollisionMatrix, type Body } from 'cannon-es'

const key = (a: Body, b: Body): string => (a.id < b.id ? `${a.id}/${b.id}` : `${b.id}/${a.id}`)

export class SparseCorpseContacts extends ArrayCollisionMatrix {
  private readonly contacts = new Set<string>()

  override get(a: Body, b: Body): number {
    return Number(this.contacts.has(key(a, b)))
  }

  override set(a: Body, b: Body, value: boolean): void {
    if (value) {
      this.contacts.add(key(a, b))
    } else {
      this.contacts.delete(key(a, b))
    }
  }

  override reset(): void {
    this.contacts.clear()
  }

  override setNumObjects(_size: number): void {
    // Keep the inherited API, with no quadratic backing-store allocation on addBody.
    this.matrix.length = 0
  }
}
