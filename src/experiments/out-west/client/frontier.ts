import collision from '../content/collision.json' with { type: 'json' }
import { ASSETS } from '../content/manifest.ts'
import type { CollisionData, Vec3 } from '../content/types.ts'
import type { FrontierHandle, FrontierOptions } from '../ffa/client/index.ts'
import { Buttons } from '../runtime/protocol.ts'
import { FrontierHud } from './frontier-hud.ts'
import { createLocalFrontierSession } from './frontier-session.ts'
import { FrontierVoice } from './frontier-voice.ts'
import { createRemoteFrontierSession } from './remote-session.ts'
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
  root.classList.add('pc-game-root', 'fr-root')
  const status = document.createElement('div')
  status.className = 'pc-game-status'
  const title = document.createElement('strong')
  title.textContent = 'PERDITION'
  const message = document.createElement('span')
  message.textContent = 'Riding into town…'
  status.append(title, message)
  let presentation: FrontierHud | undefined
  let voice: FrontierVoice | undefined
  const exit = (reason: 'left' | 'quit' | 'lost' | 'refused', detail?: string): void => {
    destroy()
    if (options.onExit) {
      options.onExit(reason, detail)
    } else {
      location.href = '/experiments/out-west/?saloon'
    }
  }
  const game = mountGameViewport(root, {
    collision: collisionData,
    townUrl: ASSETS.frontier.url,
    playerUrl: ASSETS.player.url,
    createSession: async () => {
      const session =
        options.server === 'loopback'
          ? await createLocalFrontierSession(collisionData, options)
          : await createRemoteFrontierSession(collisionData, {
              ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
              ...(options.lobbyId ? { lobbyId: options.lobbyId } : {}),
              ...(options.getToken ? { getToken: options.getToken } : {}),
              onState(state, detail) {
                if (state === 'retrying') {
                  status.hidden = false
                  root.append(status)
                  message.textContent = 'Reconnecting…'
                  game.inputEnabled(false)
                }
                if (state === 'open') {
                  status.remove()
                  game.inputEnabled(true)
                }
                if (state === 'closed') {
                  message.textContent = detail ?? 'Connection lost.'
                  status.hidden = false
                  root.append(status)
                  game.inputEnabled(false)
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
        voice = new FrontierVoice(root, session, options.audio ?? null)
      }
      session.subscribe((event) => {
        if (event.type === 'left' && event.player === session.selfSlot) {
          queueMicrotask(() => exit('left'))
        }
      })
      if (import.meta.env.DEV) {
        Reflect.set(globalThis, '__nativeFrontierSession', session)
      }
      return session
    },
    onState() {
      presentation?.update()
      voice?.update()
    },
  })
  root.append(status)
  const ready = game.ready
    .then(() => {
      if (lifecycle.signal.aborted) {
        return
      }
      status.remove()
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
      const detail = error instanceof Error ? error.message : 'Could not load Perdition.'
      message.textContent = detail
      const back = document.createElement('button')
      back.type = 'button'
      back.textContent = 'Back to saloon'
      back.addEventListener('click', () => exit('refused', detail), { signal: lifecycle.signal })
      status.append(back)
      root.append(status)
    })
  function destroy(): void {
    if (lifecycle.signal.aborted) {
      return
    }
    lifecycle.abort()
    presentation?.destroy()
    voice?.destroy()
    game.destroy()
    status.remove()
    root.classList.remove('pc-game-root', 'fr-root')
    if (import.meta.env.DEV) {
      Reflect.deleteProperty(globalThis, '__playcanvasFrontier')
      Reflect.deleteProperty(globalThis, '__nativeFrontierSession')
      Reflect.deleteProperty(globalThis, '__frontier')
    }
  }
  return { ready, destroy, leave: () => game.tap(Buttons.leave), debug: () => game.debug() }
}
