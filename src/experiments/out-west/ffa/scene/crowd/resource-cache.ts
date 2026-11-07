/** Shared baked resources stay pinned while drawn; only idle entries may leave the LRU. */
interface Entry<T> {
  refs: number
  used: number
  state: 'queued' | 'loading' | 'ready'
  load: () => Promise<T>
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  value?: T
}

const RELEASED = Symbol('resource released')

export function isResourceReleasedError(error: unknown): boolean {
  return error instanceof Error && error.cause === RELEASED
}

export class ResourceCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly queue: { key: string; entry: Entry<T> }[] = []
  private idleLimit: number
  private readonly concurrency: number
  private readonly dispose: (value: T) => void
  private clock = 0
  private loading = 0
  private pumpTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: { idleLimit: number; concurrency?: number; dispose: (value: T) => void }) {
    this.idleLimit = Math.max(0, Math.floor(options.idleLimit))
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1))
    this.dispose = options.dispose
  }

  /** Changing quality sheds only unused bakes; active materials retain their pins. */
  setIdleLimit(limit: number): void {
    this.idleLimit = Math.max(0, Math.floor(limit))
    this.trim()
  }

  /** Each successful acquisition owns one pin, including while the resource is loading. */
  acquire(key: string, load: () => Promise<T>): Promise<T> {
    const have = this.entries.get(key)
    if (have) {
      have.refs++
      have.used = ++this.clock
      return have.promise
    }
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    const entry: Entry<T> = {
      refs: 1,
      used: ++this.clock,
      state: 'queued',
      load,
      promise,
      resolve,
      reject,
    }
    this.entries.set(key, entry)
    this.queue.push({ key, entry })
    this.pump()
    return entry.promise
  }

  /** Release after detaching all meshes using the resource. Extra releases are harmless. */
  release(key: string): void {
    const entry = this.entries.get(key)
    if (!entry || entry.refs === 0) {
      return
    }
    entry.refs--
    entry.used = ++this.clock
    if (entry.refs === 0 && entry.state === 'queued') {
      // A rider left before its turn: never cast/bake a body which nobody can draw.
      this.entries.delete(key)
      const i = this.queue.findIndex((job) => job.entry === entry)
      if (i >= 0) {
        this.queue.splice(i, 1)
      }
      const error = new Error('Resource released before loading')
      error.cause = RELEASED
      entry.reject(error)
    }
    this.trim()
  }

  get stats(): {
    active: number
    idle: number
    references: number
    loading: number
    queued: number
  } {
    let active = 0
    let idle = 0
    let references = 0
    for (const entry of this.entries.values()) {
      active += Number(entry.refs > 0)
      idle += Number(entry.refs === 0 && entry.state === 'ready')
      references += entry.refs
    }
    return { active, idle, references, loading: this.loading, queued: this.queue.length }
  }

  private pump(): void {
    if (
      this.pumpTimer !== undefined ||
      this.loading >= this.concurrency ||
      this.queue.length === 0
    ) {
      return
    }
    // Dressing a source actor is a main-thread task. Give input/paint a turn between new bakes.
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined
      this.start()
    }, 0)
  }

  private start(): void {
    while (this.loading < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()
      if (!job) {
        break
      }
      const { key, entry } = job
      entry.state = 'loading'
      this.loading++
      Promise.resolve()
        .then(entry.load)
        .then(
          (value) => {
            entry.value = value
            entry.state = 'ready'
            entry.used = ++this.clock
            entry.resolve(value)
            this.trim()
          },
          (error: unknown) => {
            this.entries.delete(key)
            entry.reject(error)
          },
        )
        .finally(() => {
          this.loading--
          this.pump()
        })
    }
  }

  private trim(): void {
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => entry.refs === 0 && entry.state === 'ready')
      .sort((a, b) => a[1].used - b[1].used)
    for (const [key, entry] of idle.slice(0, Math.max(0, idle.length - this.idleLimit))) {
      this.entries.delete(key)
      if (entry.value !== undefined) {
        this.dispose(entry.value)
      }
    }
  }
}
