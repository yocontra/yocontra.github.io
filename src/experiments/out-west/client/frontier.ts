import collision from '../content/collision.json' with { type: 'json' }
import { ASSETS } from '../content/manifest.ts'
import type { CollisionData, Vec3 } from '../content/types.ts'
import type { FrontierHandle, FrontierOptions } from '../ffa/client/index.ts'
import { Buttons } from '../runtime/protocol.ts'
import { FrontierHud } from './frontier-hud.ts'
import { createLocalFrontierSession } from './frontier-session.ts'
import { FrontierVoice } from './frontier-voice.ts'
import { createRemoteFrontierSession, loadRemoteAppearance } from './remote-session.ts'
import { mountGameViewport } from './viewport.ts'
import '../ui/tokens.css'
import '../ffa/client/frontier.css'
import '../ffa/client/shooter.css'
import './playcanvas.css'

function vector(values: readonly number[]): Vec3 {
  const [x, y, z] = values
  if (
    values.length !== 3 ||
    x === undefined ||
    y === undefined ||
    z === undefined ||
    !Number.isFinite(x + y + z)
  ) {
    throw new Error('Invalid collision vector')
  }
  return [x, y, z]
}
const collisionData: CollisionData = {
  version: collision.version,
  boxes: collision.boxes.map((box) => ({
    ...box,
    center: vector(box.center),
    halfExtents: vector(box.halfExtents),
  })),
  meshes: collision.meshes,
}

/** A single native renderer serves local practice and authenticated online Frontier. */
export function mountNativeFrontier(
  root: HTMLElement,
  options: FrontierOptions = {},
): FrontierHandle {
  const lifecycle = new AbortController()
  root.classList.add('pc-game-root', 'fr-root', 'pc-loading')
  const status = document.createElement('div')
  status.className = 'pc-game-status pc-travel'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  const title = document.createElement('strong')
  title.textContent = 'PERDITION'
  const message = document.createElement('span')
  message.textContent = 'Saddling up…'
  const art = document.createElement('img')
  art.className = 'pc-travel-art'
  art.src = '/experiments/out-west/ui/title-duel.svg'
  art.alt = ''
  status.append(art, title, message)
  let presentation: FrontierHud | undefined
  let voice: FrontierVoice | undefined
  let removePerformanceSnapshot: (() => void) | undefined
  let started = false
  let connection: 'open' | 'retrying' | 'closed' = 'open'
  const finishTravel = (): void => {
    status.remove()
    root.classList.remove('pc-loading')
  }
  const exit = (reason: 'left' | 'quit' | 'lost' | 'refused', detail?: string): void => {
    destroy()
    if (options.onExit) {
      options.onExit(reason, detail)
    } else {
      location.href = '/experiments/out-west/?saloon'
    }
  }
  const leaveStatus = (reason: 'lost' | 'refused', detail: string): void => {
    message.textContent = detail
    const back = document.createElement('button')
    back.type = 'button'
    back.textContent = 'Back to saloon'
    back.addEventListener('click', () => exit(reason, detail), { signal: lifecycle.signal })
    status.hidden = false
    root.classList.add('pc-loading')
    status.append(back)
    root.append(status)
    back.focus()
  }
  const game = mountGameViewport(root, {
    collision: collisionData,
    townUrl: ASSETS.frontier.url,
    playerUrl: ASSETS.player.url,
    ...(options.server === 'loopback'
      ? {}
      : {
          prepareAppearance: (signal) =>
            loadRemoteAppearance(
              {
                ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
                ...(options.getToken ? { getToken: options.getToken } : {}),
              },
              signal,
            ),
        }),
    createSession: async () => {
      const session =
        options.server === 'loopback'
          ? await createLocalFrontierSession(collisionData, options)
          : await createRemoteFrontierSession(collisionData, {
              ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
              ...(options.lobbyId ? { lobbyId: options.lobbyId } : {}),
              ...(options.getToken ? { getToken: options.getToken } : {}),
              onState(state, detail) {
                if (lifecycle.signal.aborted) {
                  return
                }
                connection = state
                voice?.setLinked(state === 'open')
                game.inputEnabled(state === 'open')
                if (state === 'retrying') {
                  game.resetFeedback()
                  status.hidden = false
                  root.append(status)
                  title.textContent = 'Rejoining Perdition'
                  message.textContent = 'Finding your place in town…'
                  root.classList.add('pc-loading')
                } else if (state === 'closed') {
                  title.textContent = 'Connection closed'
                  leaveStatus('lost', detail ?? 'Connection lost.')
                } else if (started) {
                  finishTravel()
                }
              },
            })
      if (lifecycle.signal.aborted) {
        session.dispose()
        throw new DOMException('Game was closed', 'AbortError')
      }
      session.subscribe((event) => game.event(event))
      presentation = new FrontierHud(root, session, game, () => exit('quit'))
      if (!session.practice) {
        voice = new FrontierVoice(root, session, options.audio ?? null, game.audioContext)
        voice.setLinked(connection === 'open')
      }
      session.subscribe((event) => {
        if (event.type === 'left' && event.player === session.selfSlot) {
          queueMicrotask(() => exit('left'))
        }
      })
      if (import.meta.env.DEV) {
        Reflect.set(globalThis, '__nativeFrontierSession', session)
      }
      if (import.meta.env.PUBLIC_OW_PERF_HARNESS === '1') {
        const { performanceSnapshot } = await import('./performance-snapshot.ts')
        if (!lifecycle.signal.aborted) {
          removePerformanceSnapshot = performanceSnapshot(session, game)
        }
      }
      return session
    },
    onStage(text) {
      if (!started && connection === 'open') {
        message.textContent = text
      }
    },
    onState() {
      presentation?.update()
      voice?.update()
    },
  })
  root.append(status)
  const ready = game.ready
    .then(() => {
      if (lifecycle.signal.aborted || connection === 'closed') {
        return
      }
      started = true
      if (connection === 'open') {
        finishTravel()
      }
      if (import.meta.env.DEV) {
        Reflect.set(globalThis, '__playcanvasFrontier', game)
        Reflect.set(globalThis, '__frontier', () => game.debug())
      }
    })
    .catch((error) => {
      if (lifecycle.signal.aborted) {
        return
      }
      presentation?.destroy()
      if (connection === 'closed') {
        return
      }
      const detail = error instanceof Error ? error.message : 'Could not load Perdition.'
      leaveStatus('refused', detail)
    })
  function destroy(): void {
    if (lifecycle.signal.aborted) {
      return
    }
    lifecycle.abort()
    removePerformanceSnapshot?.()
    presentation?.destroy()
    voice?.destroy()
    game.destroy()
    status.remove()
    root.classList.remove('pc-game-root', 'fr-root', 'pc-loading')
    if (import.meta.env.DEV) {
      Reflect.deleteProperty(globalThis, '__playcanvasFrontier')
      Reflect.deleteProperty(globalThis, '__nativeFrontierSession')
      Reflect.deleteProperty(globalThis, '__frontier')
    }
  }
  return { ready, destroy, leave: () => game.tap(Buttons.leave), debug: () => game.debug() }
}
