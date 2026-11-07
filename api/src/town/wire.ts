import { TOWN_WIRE_VERSION } from '../../../src/experiments/out-west/contract/town.ts'

/** The public route stamps this after ticket verification; old Worker routes cannot join new DOs. */
export const LOBBY_WIRE_HEADER = 'X-Town-Wire-Version'

export function lobbyUpgradeError(request: Request): Response | null {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }
  if (request.headers.get(LOBBY_WIRE_HEADER) !== String(TOWN_WIRE_VERSION)) {
    return new Response('The town is being updated. Refresh the page in a moment.', { status: 409 })
  }
  return null
}
