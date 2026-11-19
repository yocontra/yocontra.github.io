import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { simulatorClient } from './simulator-client.ts'
import { commandPlan, nativeSafari, requireBootedRecoveryDevice } from './simulator-native.ts'
import {
  type InitialDisplay,
  nativeDisplay,
  type OrientationClient,
  readOrientationState,
  restoreDisplay,
} from './simulator-orientation.ts'
import {
  bounded,
  type OwnedProcess,
  requireFreePort,
  stopOwned,
  until,
} from './simulator-process.ts'

export interface DisplayRecovery {
  udid: string
  port: number
  python: string
  output: string
  initial: InitialDisplay
  run: (args: string[], timeout: number) => Promise<string>
}

export function pidAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export function isOrientationTimeout(error: string): boolean {
  return (
    error.includes('Owned native RPC timed out:') || error === 'Error: Operation deadline exceeded'
  )
}

/** No orientation command may run against a renewed device, Safari process or display. */
export async function restoreOnSameDisplay(
  native: OrientationClient,
  initial: InitialDisplay,
  observe: (evidence: Record<string, unknown>) => void,
) {
  const state = await bounded(
    (signal) =>
      readOrientationState(native, {
        commanded: false,
        milliseconds: 6000,
        maxRpcMs: 3000,
        signal,
      }),
    6000,
  )
  const safari = nativeSafari(state.ax, state.apps)
  const current = nativeDisplay(state.ax)
  observe({ phase: 'recovery-identity', safari, screen: current })
  if (
    safari?.pid !== initial.safariPID ||
    current.display.unique_id !== initial.screen.display.unique_id ||
    current.display.scale !== initial.screen.display.scale
  ) {
    throw new Error('Native Safari or display changed before restoration recovery')
  }
  return bounded(
    () => restoreDisplay(native, initial, { milliseconds: 15_000, maxRpcMs: 5000, observe }),
    15_000,
  )
}

function reportsPort(log: string, port: number): boolean {
  return log.split('\n').some((line) => {
    try {
      return (JSON.parse(line) as { grpc_port?: number } | null)?.grpc_port === port
    } catch {
      return false
    }
  })
}

/** One fresh headless companion on the already-owned, still-booted exact device. */
export async function recoverOwnedOrientation(options: DisplayRecovery) {
  const { udid, port, python, output, initial, run } = options
  const result: Record<string, unknown> = {}
  const observations: Record<string, unknown>[] = []
  const ownedPids: number[] = []
  let companion: OwnedProcess | undefined
  let client: Awaited<ReturnType<typeof simulatorClient>> | undefined
  try {
    const list = await run(['xcrun', 'simctl', 'list', 'devices', 'available', '--json'], 4000)
    requireBootedRecoveryDevice(JSON.parse(list), udid)
    await requireFreePort(port)
    const folder = join(output, 'orientation-recovery')
    await mkdir(folder)
    const log = join(folder, 'companion.log')
    companion = Bun.spawn(commandPlan(udid, '', port).companion, {
      stdout: Bun.file(log),
      stderr: Bun.file(join(folder, 'companion-stderr.log')),
    })
    const owned = companion
    ownedPids.push(owned.pid)
    await until(async (signal) => {
      if (owned.exitCode !== null) {
        throw new Error('Owned recovery companion exited before readiness')
      }
      const content = await readFile(log, { encoding: 'utf8', signal }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            return ''
          }
          throw error
        },
      )
      return reportsPort(content, port) || undefined
    }, 12)
    // simulatorClient independently verifies the exact device UDID before exposing any RPC.
    client = await simulatorClient(python, port, udid, folder)
    ownedPids.push(client.pid)
    const connected = client
    const native = {
      call: (...args: Parameters<OrientationClient['call']>) => {
        if (owned.exitCode !== null || pidAbsent(owned.pid)) {
          throw new Error('Owned recovery companion exited')
        }
        return connected.call(...args)
      },
    }
    const restore = await restoreOnSameDisplay(native, initial, (evidence) =>
      observations.push(evidence),
    )
    result.orientationDisplay = restore
    result.displayRestored = restore.displayRestored
    result.rawOrientationRestored = restore.rawOrientationRestored
  } catch (error) {
    result.failure = String(error)
  } finally {
    if (client) {
      const owned = client
      try {
        result.nativeClient = await bounded(() => owned.close(), 6000)
      } catch (error) {
        result.nativeClientFailure = String(error)
        try {
          result.nativeTermination = await bounded(() => owned.terminate(), 6000)
        } catch (stopError) {
          result.nativeTerminationFailure = String(stopError)
        }
      }
    }
    if (companion) {
      try {
        result.companion = await stopOwned(companion)
      } catch (error) {
        result.companionCleanupFailure = String(error)
      }
    }
  }
  return Object.assign(result, { observations, ownedPids })
}
