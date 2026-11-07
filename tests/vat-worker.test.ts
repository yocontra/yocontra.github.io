import { expect, it } from 'bun:test'
import type { VatJob } from '../src/experiments/out-west/ffa/scene/crowd/vat-shared.ts'
import { VatWorkerClient } from '../src/experiments/out-west/ffa/scene/crowd/worker-client.ts'

const job: VatJob = {
  json: {},
  clips: [],
  fps: 15,
  targetTris: 1000,
  headUuid: '',
  sockets: {},
  markers: [],
}
class FakeWorker {
  onerror: ((event: Event) => void) | null = null
  onmessageerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  terminated = false
  failPost: boolean
  constructor(failPost = false) {
    this.failPost = failPost
  }
  postMessage(): void {
    if (this.failPost) {
      throw new Error('Cannot clone')
    }
  }
  terminate(): void {
    this.terminated = true
  }
}

it('rejects all bakes when the worker fails and replaces it on the next request', async () => {
  const workers: FakeWorker[] = []
  const client = new VatWorkerClient(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
  const first = client.run(job).catch((error: unknown) => error)
  const second = client.run(job).catch((error: unknown) => error)
  workers[0]?.onerror?.(new Event('error'))
  expect(await first).toBeInstanceOf(Error)
  expect(await second).toBeInstanceOf(Error)
  const failed = workers[0]
  if (!failed) {
    throw new Error('Missing first worker')
  }
  expect(failed.terminated).toBe(true)
  const next = client.run(job).catch((error: unknown) => error)
  workers[1]?.onmessageerror?.(new Event('messageerror'))
  expect(await next).toBeInstanceOf(Error)
  expect(workers).toHaveLength(2)
})

it('rejects a synchronous message failure without retaining an unresolved bake', async () => {
  const worker = new FakeWorker(true)
  const client = new VatWorkerClient(() => worker as unknown as Worker)
  await expect(client.run(job)).rejects.toThrow('Cannot clone')
})
