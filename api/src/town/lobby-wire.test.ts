/** The signed router stamps this version before the native Colyseus DO upgrade. */
import { expect, it } from 'bun:test'
import { TOWN_WIRE_VERSION } from '../../../src/experiments/out-west/contract/town.ts'
import { LOBBY_WIRE_HEADER, lobbyUpgradeError } from './wire.ts'

it.each([
  undefined,
  String(TOWN_WIRE_VERSION - 1),
  String(TOWN_WIRE_VERSION + 1),
  '10.0',
  'invalid',
])('refuses mismatched internal version %s before upgrade', async (wire) => {
  const headers = new Headers({ Upgrade: 'websocket' })
  if (wire !== undefined) {
    headers.set(LOBBY_WIRE_HEADER, wire)
  }
  const error = lobbyUpgradeError(new Request('http://localhost', { headers }))
  expect(error?.status).toBe(409)
  expect(await error?.text()).toContain('being updated')
})
it('requires a websocket and accepts only the exact version', () => {
  expect(lobbyUpgradeError(new Request('http://localhost'))?.status).toBe(426)
  expect(
    lobbyUpgradeError(
      new Request('http://localhost', {
        headers: { Upgrade: 'websocket', [LOBBY_WIRE_HEADER]: String(TOWN_WIRE_VERSION) },
      }),
    ),
  ).toBeNull()
})
