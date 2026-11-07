/** A failed worker must reject pending bakes so the loading screen can recover. */
import type { VatJob, VatResult } from './vat-shared.ts'

export class VatWorkerClient {
  private worker: Worker | null = null
  private seq = 0
  private readonly waiting = new Map<
    number,
    { ok: (value: VatResult) => void; fail: (error: Error) => void }
  >()
  private readonly create: () => Worker

  constructor(
    create: () => Worker = () =>
      new Worker(new URL('./vat.worker.ts', import.meta.url), { type: 'module' }),
  ) {
    this.create = create
  }

  run(job: VatJob): Promise<VatResult> {
    if (!this.worker) {
      const worker = this.create()
      this.worker = worker
      const broken = (event: Event) => {
        if (this.worker !== worker) {
          return
        }
        this.worker = null
        worker.terminate()
        for (const pending of this.waiting.values()) {
          pending.fail(new Error(`VAT worker failed: ${event.type}`))
        }
        this.waiting.clear()
      }
      worker.onerror = broken
      worker.onmessageerror = broken
      worker.onmessage = (
        event: MessageEvent<{ id: number; result?: VatResult; error?: string }>,
      ) => {
        const pending = this.waiting.get(event.data.id)
        this.waiting.delete(event.data.id)
        if (event.data.result) {
          pending?.ok(event.data.result)
        } else {
          pending?.fail(new Error(event.data.error ?? 'VAT bake failed'))
        }
      }
    }
    const id = ++this.seq
    const worker = this.worker
    return new Promise((ok, fail) => {
      this.waiting.set(id, { ok, fail })
      try {
        worker.postMessage({ id, job })
      } catch (error) {
        this.waiting.delete(id)
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}

const client = new VatWorkerClient()
export const runVatJob = (job: VatJob): Promise<VatResult> => client.run(job)
