/** Worker side of scene/lod.ts: meshopt simplification off the main thread. */
import { type SimplifyJob, simplifyIndex } from './lod.ts'

const scope = globalThis as unknown as Worker

scope.onmessage = async (e: MessageEvent<{ id: number; job: SimplifyJob }>) => {
  try {
    const result = await simplifyIndex(e.data.job)
    scope.postMessage({ id: e.data.id, result }, [result.index.buffer])
  } catch (error) {
    scope.postMessage({
      id: e.data.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
