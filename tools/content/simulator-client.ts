/** Small process adapter for the installed public Python fb-idb API, one owned channel. */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bounded, stopOwned } from './simulator-process.ts'
export async function simulatorClient(python: string, port: number, udid: string, output: string) {
  const process = Bun.spawn(
    [
      python,
      '-B',
      join(import.meta.dir, 'simulator-idb.py'),
      '--port',
      String(port),
      '--udid',
      udid,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: Bun.file(join(output, 'idb-stderr.log')) },
  )
  let sequence = 0
  let connected = false
  const events: unknown[] = []
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  const reader = process.stdout.getReader()
  const read = (async () => {
    let buffer = ''
    let chunk = await reader.read()
    while (!chunk.done) {
      const bytes = chunk.value
      buffer += new TextDecoder().decode(bytes)
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const row = JSON.parse(buffer.slice(0, index)) as {
          event?: string
          id?: number
          error?: string
          result?: unknown
        }
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        await appendFile(join(output, 'native.jsonl'), `${JSON.stringify(row)}\n`)
        if (row.event) {
          events.push(row)
          connected ||= row.event === 'connected'
        } else if (row.id !== undefined) {
          const callback = pending.get(row.id)
          pending.delete(row.id)
          if (row.error) {
            callback?.reject(new Error(row.error))
          } else {
            callback?.resolve(row.result)
          }
        }
      }
      chunk = await reader.read()
    }
    for (const value of pending.values()) {
      value.reject(new Error('Owned idb client exited before response'))
    }
  })().catch((error) => {
    for (const value of pending.values()) {
      value.reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
  const terminate = () => stopOwned(process, [{ done: read, cancel: () => reader.cancel() }])
  const deadline = Date.now() + 15_000
  while (!connected && Date.now() < deadline && process.exitCode === null) {
    await Bun.sleep(100)
  }
  if (!connected) {
    await terminate()
    throw new Error('Persistent idb client capability unavailable; see retained stderr/native log')
  }
  return {
    pid: process.pid,
    events,
    terminate,
    call(op: string, args: Record<string, unknown> = {}, timeout = 15_000): Promise<unknown> {
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Owned native RPC timed out: ${op}`))
        }, timeout)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        process.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`)
        process.stdin.flush()
      })
    },
    async close() {
      let closeFailure: string | undefined
      try {
        if (process.exitCode === null) {
          await this.call('close', {}, 2000)
          process.stdin.end()
          try {
            // Allow the public client async context to close normally before TERM escalation.
            await bounded(() => process.exited, 500)
          } catch {
            // A close ACK alone cannot block bounded owned-process termination.
          }
        }
      } catch (error) {
        closeFailure = String(error)
      }
      const stopped = await terminate()
      return { ...stopped, ...(closeFailure ? { closeFailure } : {}) }
    },
  }
}
