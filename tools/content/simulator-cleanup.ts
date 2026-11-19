import {
  isOrientationTimeout,
  pidAbsent,
  recoverOwnedOrientation,
} from './simulator-display-recovery.ts'
import { type InitialDisplay, restoreDisplay } from './simulator-orientation.ts'
/** Always attempt later owned cleanup after restore/RPC failure; no caller hosts are terminated. */
import {
  bounded,
  type OwnedProcess,
  requireFreePort,
  stopOwned,
  waitForSettingsRestore,
} from './simulator-process.ts'

interface Client {
  pid: number
  call: (op: string, args?: Record<string, unknown>, timeout?: number) => Promise<unknown>
  close: () => Promise<unknown>
  terminate: () => Promise<unknown>
}
interface CleanupContext {
  booted: boolean
  native: Client | undefined
  companion: OwnedProcess | undefined
  run: (args: string[], timeout?: number) => Promise<string>
  options: { udid: string; port: number; python?: string; output?: string }
  stateURL: URL
  url: URL
  initialDisplay: InitialDisplay | undefined
  qaPageAttempted: boolean
  budgets?: { restore: number; rpc: number; close: number; shutdown: number }
  recoverOrientation?: typeof recoverOwnedOrientation
}
async function recoverDisplayIfNeeded(
  context: CleanupContext,
  cleanup: Record<string, unknown>,
  ownedPids: number[],
) {
  const { booted, native, companion, options, initialDisplay, run } = context
  if (
    !(
      booted &&
      native &&
      companion &&
      initialDisplay?.commandAttempted &&
      options.python &&
      options.output
    ) ||
    typeof cleanup.orientationRestoreFailure !== 'string' ||
    !isOrientationTimeout(cleanup.orientationRestoreFailure)
  ) {
    return
  }
  if (!ownedPids.every(pidAbsent)) {
    cleanup.orientationRecoverySkipped = 'The original owned processes have not exited'
    return
  }
  try {
    const recover = context.recoverOrientation ?? recoverOwnedOrientation
    const result = await recover({
      ...options,
      python: options.python,
      output: options.output,
      initial: initialDisplay,
      run,
    })
    cleanup.orientationRecovery = result
    ownedPids.push(...result.ownedPids)
    if (result.displayRestored === true) {
      cleanup.displayRestored = true
      cleanup.rawOrientationRestored = result.rawOrientationRestored
    }
  } catch (error) {
    cleanup.orientationRecoveryFailure = String(error)
  }
}

export async function cleanupGuest(context: CleanupContext) {
  const { booted, native, companion, run, options, stateURL, url, initialDisplay } = context
  const budget = context.budgets ?? { restore: 5000, rpc: 2000, close: 6000, shutdown: 30_000 }
  const cleanup: Record<string, unknown> = {}
  if (booted && context.qaPageAttempted) {
    try {
      // run() is the owned command() runner; await its bounded kill/drain completion too.
      await run(
        [
          'xcrun',
          'simctl',
          'openurl',
          options.udid,
          new URL(`/__qa/restore?id=${url.searchParams.get('id')}`, url).href,
        ],
        budget.restore,
      )
      cleanup.settingsRestored = await waitForSettingsRestore(stateURL, budget.restore / 1000)
    } catch (error) {
      cleanup.settingsRestoreFailure = String(error)
    }
  }
  if (!context.qaPageAttempted) {
    cleanup.settingsRestoreSkipped = 'No QA URL was attempted; no game settings were touched'
  }
  if (native) {
    try {
      if (initialDisplay?.commandAttempted) {
        const restored = await bounded(
          () =>
            restoreDisplay(native, initialDisplay, {
              milliseconds: budget.rpc * 2,
              maxRpcMs: budget.rpc,
            }),
          budget.rpc * 2,
        )
        cleanup.orientationDisplay = restored
        cleanup.displayRestored = restored.displayRestored
        cleanup.rawOrientationRestored = restored.rawOrientationRestored
      } else {
        cleanup.orientationRestoreSkipped = 'No orientation command was attempted'
      }
    } catch (error) {
      cleanup.orientationRestoreFailure = String(error)
    }
    try {
      cleanup.nativeClient = await bounded(() => native.close(), budget.close)
    } catch (error) {
      cleanup.nativeClientFailure = String(error)
      try {
        cleanup.nativeTermination = await bounded(() => native.terminate(), budget.close)
      } catch (stopError) {
        cleanup.nativeTerminationFailure = String(stopError)
      }
    }
  }
  try {
    if (companion) {
      cleanup.companion = await stopOwned(companion)
    }
  } catch (error) {
    cleanup.companionCleanupFailure = String(error)
  }
  const ownedPids = [companion?.pid, native?.pid].filter((pid): pid is number => pid !== undefined)
  await recoverDisplayIfNeeded(context, cleanup, ownedPids)
  // This remains last even if either preceding cleanup failed or timed out.
  if (booted) {
    try {
      await run(['xcrun', 'simctl', 'shutdown', options.udid], budget.shutdown)
      const list = JSON.parse(
        await run(['xcrun', 'simctl', 'list', 'devices', 'available', '--json'], budget.shutdown),
      )
      cleanup.deviceShutdown = Object.values(
        list.devices as Record<string, { udid: string; state: string }[]>,
      )
        .flat()
        .some((device) => device.udid === options.udid && device.state === 'Shutdown')
    } catch (error) {
      cleanup.shutdownFailure = String(error)
    }
  }
  cleanup.ownedPids = ownedPids
  cleanup.ownedPidsAbsent = ownedPids.every(pidAbsent)
  try {
    await requireFreePort(options.port)
    cleanup.nativePortFree = true
  } catch {
    cleanup.nativePortFree = false
  }
  return cleanup
}
