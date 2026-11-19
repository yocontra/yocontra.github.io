import { expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simulatorClient } from '../tools/content/simulator-client.ts'

it('rejects an empty native RPC error and still accepts later responses', async () => {
  const output = await mkdtemp(join(tmpdir(), 'out-west-native-rpc-'))
  const executable = join(output, 'mock-native-rpc')
  try {
    await writeFile(
      executable,
      `#!/usr/bin/env python3
import json
import sys

print(json.dumps({'event': 'connected'}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    response = {'id': request['id']}
    if request['op'] == 'failed':
        response['error'] = ''
    else:
        response['result'] = True
    print(json.dumps(response), flush=True)
    if request['op'] == 'close':
        break
`,
      { mode: 0o700 },
    )
    const client = await simulatorClient(executable, 10_897, 'test-device', output)
    try {
      await expect(client.call('failed')).rejects.toThrow(
        'Owned native RPC failed without a message',
      )
      await expect(client.call('read')).resolves.toBe(true)
    } finally {
      await client.close()
    }
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})
