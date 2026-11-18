/** Owned bounded process/acknowledgement operations shared by simulator modes. */
import { createServer } from 'node:net'
import { recordingAcknowledged } from './simulator-host.ts'
import { nativeSafari } from './simulator-native.ts'

export async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
): Promise<T> {
  if (!(milliseconds > 0 && Number.isFinite(milliseconds))) {
    throw new Error('Operation deadline exhausted')
  }
  const controller = new AbortController()
  let rejectAbort: (reason: unknown) => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const timer = setTimeout(() => {
    const error = new Error('Operation deadline exceeded')
    controller.abort(error)
    rejectAbort(error)
  }, Math.ceil(milliseconds))
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), aborted])
  } finally {
    clearTimeout(timer)
  }
}
export interface OwnedProcess {
  pid: number
  exitCode: number | null
  exited: Promise<number>
  kill: (signal?: NodeJS.Signals | number) => void
}
export interface OwnedPipe {
  done: Promise<unknown>
  cancel: () => Promise<unknown>
}
/** Only retained spawned handles are signaled. No PID discovery or caller-owned host termination. */
export async function stopOwned(
  child: OwnedProcess,
  pipes: readonly OwnedPipe[] = [],
  budget = { term: 1000, kill: 1000, drain: 1000 },
) {
  let escalated = false
  let exited = false
  const exit = child.exited.then((code) => {
    exited = true
    return code
  })
  await Promise.resolve()
  if (!exited) {
    child.kill('SIGTERM')
    try {
      await bounded(() => exit, budget.term)
    } catch {
      if (!exited) {
        escalated = true
        child.kill('SIGKILL')
      }
    }
  }
  const exitCode = await bounded(() => exit, budget.kill)
  let pipeDrainComplete = true
  try {
    await bounded(() => Promise.all(pipes.map((p) => p.done)), budget.drain)
  } catch {
    pipeDrainComplete = false
    await bounded(() => Promise.allSettled(pipes.map((p) => p.cancel())), budget.drain)
  }
  return { pid: child.pid, exitCode, escalated, pipeDrainComplete }
}
function textPipe(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const done = (async () => {
    let text = ''
    let value = await reader.read()
    while (!value.done) {
      text += decoder.decode(value.value, { stream: true })
      value = await reader.read()
    }
    return text + decoder.decode()
  })()
  return { done, cancel: () => reader.cancel() }
}
export async function command(args: string[], timeout = 30_000, signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason
  }
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const stdout = textPipe(child.stdout)
  const stderr = textPipe(child.stderr)
  const abort = () => child.kill('SIGTERM')
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const [out, error, code] = await bounded(
      () => Promise.all([stdout.done, stderr.done, child.exited]),
      timeout,
    )
    if (code !== 0) {
      throw new Error(`${args.slice(0, 3).join(' ')} failed: ${error || code}`)
    }
    return out
  } finally {
    signal?.removeEventListener('abort', abort)
    await stopOwned(child, [stdout, stderr])
  }
}
export async function requireFreePort(port: number): Promise<void> {
  const server = createServer()
  try {
    await bounded(
      () =>
        new Promise<void>((done, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', () =>
            server.close((error) => (error ? reject(error) : done())),
          )
        }),
      2000,
    )
  } finally {
    if (server.listening) {
      server.close()
    }
  }
}
export async function until<T>(
  read: (signal: AbortSignal, remainingMs: number) => Promise<T | undefined>,
  seconds = 60,
): Promise<T> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const value = await bounded((signal) => read(signal, remaining), remaining)
    if (value !== undefined) {
      return value
    }
    await Bun.sleep(Math.min(250, Math.max(0, deadline - Date.now())))
  }
  throw new Error('Headless preflight capability deadline exceeded')
}
export async function statusJSON<T>(url: URL, signal: AbortSignal): Promise<T> {
  return (await (await fetch(url, { signal })).json()) as T
}
export interface SafariReadinessEvent {
  phase: 'launch' | 'readiness' | 'open'
  wall: number
  result?: unknown
  identity?: { bundle: string; pid: number } | null
  error?: string
}
const noFrontmostApplication =
  'axbridge could not resolve the frontmost application using the window-server strategy: window-server frontmost returned no application object'
const idbCommandFailure = /^idb --companion 127\.0\.0\.1:[1-9]\d{3,4} failed: /u
function startupAXPending(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }
  // The CLI command adapter adds this exact prefix; the persistent client does not.
  const message = error.message.trimEnd().replace(idbCommandFailure, '')
  return message === noFrontmostApplication
}
/** Only readiness may wait for this observed guest startup state; both reads share its budget. */
export async function readSafariReadiness(
  reads: {
    ax: (milliseconds: number, signal: AbortSignal) => Promise<unknown>
    apps: (milliseconds: number, signal: AbortSignal) => Promise<unknown>
  },
  milliseconds: number,
  signal: AbortSignal,
) {
  const deadline = Date.now() + milliseconds
  let ax: unknown
  let axError: string | undefined
  try {
    ax = await reads.ax(milliseconds, signal)
  } catch (error) {
    if (!startupAXPending(error)) {
      throw error
    }
    axError = String(error)
  }
  const remaining = deadline - Date.now()
  if (!(remaining > 0) || signal.aborted) {
    throw new Error(
      `Native Safari state deadline exceeded${axError ? `; preceding AX observation: ${axError}` : ''}`,
    )
  }
  try {
    const apps = await reads.apps(remaining, signal)
    return { ax, apps, ...(axError ? { axError } : {}) }
  } catch (error) {
    // Retain both failures if the independent mapping fails after a pending AX observation.
    if (axError) {
      throw new Error(`${String(error)}; preceding AX observation: ${axError}`, { cause: error })
    }
    throw error
  }
}
/** One launch and one URL action; only native readiness observations are polled. */
export async function openSafariWhenReady(options: {
  launch: (milliseconds: number, signal: AbortSignal) => Promise<unknown>
  read: (milliseconds: number, signal: AbortSignal) => Promise<{ ax: unknown; apps: unknown }>
  open: (milliseconds: number, signal: AbortSignal) => Promise<unknown>
  observe: (event: SafariReadinessEvent) => void | Promise<void>
  seconds?: number
}) {
  const seconds = options.seconds ?? 30
  const milliseconds = seconds * 1000
  let phase: SafariReadinessEvent['phase'] = 'launch'
  try {
    const launched = await bounded((signal) => options.launch(milliseconds, signal), milliseconds)
    await options.observe({ phase, wall: Date.now(), result: launched })
    phase = 'readiness'
    const identity = await until(async (signal, remaining) => {
      const result = await options.read(remaining, signal)
      const ready = Array.isArray(result.apps) ? nativeSafari(result.ax, result.apps) : undefined
      await options.observe({ phase, wall: Date.now(), result, identity: ready ?? null })
      return ready
    }, seconds)
    phase = 'open'
    const opened = await bounded((signal) => options.open(milliseconds, signal), milliseconds)
    await options.observe({ phase, wall: Date.now(), result: opened })
    return identity
  } catch (error) {
    await options.observe({ phase, wall: Date.now(), error: String(error) })
    throw error
  }
}
/** Restore navigation can finish before the page's separate ACK reaches the host. */
export function waitForSettingsRestore(stateURL: URL, seconds: number) {
  return until(async (signal) => {
    const response = await fetch(stateURL, { signal })
    if (response.status === 404) {
      return
    }
    if (response.status !== 200) {
      throw new Error(`Settings restore status HTTP ${response.status}`)
    }
    const value: unknown = await response.json()
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Malformed settings restore status')
    }
    const restored: unknown = Reflect.get(value, 'settingsRestored')
    if (restored === true) {
      return true
    }
    if (restored === undefined) {
      return
    }
    throw new Error(
      restored === false
        ? 'Guest settings restoration reported failure'
        : 'Malformed settings restore acknowledgement',
    )
  }, seconds)
}
export async function waitForRecording(stateURL: URL) {
  const recording = await until(async (signal) => {
    const value: unknown = await statusJSON(stateURL, signal)
    return recordingAcknowledged(value) ? value : undefined
  }, 10)
  if (Date.now() - recording.wall > 1000) {
    throw new Error('Recording acknowledgement is stale; no late HID test')
  }
  return recording
}
