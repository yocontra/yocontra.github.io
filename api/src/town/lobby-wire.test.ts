/** Actual workerd DO boundary: old Worker routes must never reach a new binary stream. */
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  CONTRACT_VERSION,
  type ServerControl,
  TOWN_WIRE_VERSION,
} from '../../../src/experiments/out-west/contract/town.ts'

const dir = mkdtempSync(join(tmpdir(), 'out-west-lobby-wire-'))
interface RolloutResult {
  refused: { wire: string | null; status: number; upgraded: boolean; text: string }[]
  current: { status: number; controls: ServerControl[] }
}
let result: RolloutResult

beforeAll(() => {
  const entry = join(dir, 'worker.ts')
  writeFileSync(
    entry,
    `
    export { Lobby } from ${JSON.stringify(resolve(import.meta.dir, 'lobby.ts'))};
    export { LobbyDirectory } from ${JSON.stringify(resolve(import.meta.dir, 'directory.ts'))};
    export default { fetch(request, env) {
      return env.LOBBIES.get(env.LOBBIES.idFromName('wire-rollout')).fetch(request);
    } };
  `,
  )
  const output = join(dir, 'worker.js')
  const built = spawnSync(
    'bun',
    ['build', entry, '--target=browser', '--external=cloudflare:workers', `--outfile=${output}`],
    { encoding: 'utf8' },
  )
  if (built.status !== 0) {
    throw new Error(`Could not bundle the actual lobby fixture: ${built.stderr.toString()}`)
  }
  const tested = spawnSync(
    'node',
    [
      '--experimental-strip-types',
      resolve(import.meta.dir, 'testing/wire-runtime.ts'),
      output,
      resolve(import.meta.dir, '../../migrations'),
      String(TOWN_WIRE_VERSION),
    ],
    { encoding: 'utf8' },
  )
  if (tested.status !== 0) {
    throw new Error(`Actual lobby fixture failed: ${tested.stderr.toString()}`)
  }
  result = JSON.parse(tested.stdout.toString())
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

it.each([
  undefined,
  String(TOWN_WIRE_VERSION - 1),
  String(TOWN_WIRE_VERSION + 1),
  '10.0',
  'invalid',
])('refuses internal wire %s before upgrade, welcome or binary', (wire) => {
  const response = result.refused.find((entry) => entry.wire === (wire ?? null))
  expect(response?.status).toBe(409)
  expect(response?.upgraded).toBe(false)
  expect(response?.text).toContain('being updated')
})

it('retains exact-current welcome and complete town state through the actual DO', () => {
  expect(result.current.status).toBe(101)
  expect(result.current.controls[0]).toMatchObject({
    type: 'welcome',
    contractVersion: CONTRACT_VERSION,
  })
  expect(result.current.controls.find((message) => message.type === 'town_state')).toMatchObject({
    type: 'town_state',
    state: { brokenWindows: [] },
  })
})
