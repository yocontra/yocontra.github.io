import { expect, test as it } from 'bun:test'
import { openDatabase } from './d1.ts'

const miniflare = '/fixture/node_modules/miniflare/dist/src/index.js'

function startupError(code: string, syscall: string, frame: string): Error {
  return Object.assign(new Error('Local runtime startup failed'), { code, syscall, stack: frame })
}

const pipeFailure = () =>
  startupError('EBADF', 'send', `    at updateConfig (${miniflare}:120261:26)`)
const loopbackFailure = () =>
  startupError('ERR_ASSERTION', '', `    at getServerPort (${miniflare}:101:13)`)

it.each([
  ['workerd startup pipe', pipeFailure],
  ['loopback readiness', loopbackFailure],
] as const)(
  'disposes the failed %s attempt before opening an empty runtime',
  async (_name, fail) => {
    const first = fail()
    const events: string[] = []
    let attempts = 0
    const database = { name: 'fresh database' }
    const result = await openDatabase(() => {
      const attempt = ++attempts
      events.push(`create ${attempt}`)
      return {
        getD1Database(binding) {
          events.push(`get ${attempt} ${binding}`)
          return attempt === 1 ? Promise.reject(first) : Promise.resolve(database)
        },
        dispose: () =>
          Promise.resolve().then(() => {
            events.push(`dispose ${attempt}`)
            // Miniflare rethrows the ready rejection only after finishing disposal.
            if (attempt === 1) {
              throw first
            }
          }),
      }
    })
    expect(result.db as unknown).toBe(database)
    expect(events).toEqual(['create 1', 'get 1 DB', 'dispose 1', 'create 2', 'get 2 DB'])
    await result.runtime.dispose()
    expect(events.at(-1)).toBe('dispose 2')
  },
)

it('a repeated transport failure is disposed and still fails startup', async () => {
  const second = pipeFailure()
  const failures = [pipeFailure(), second]
  let disposals = 0
  const rejection = await openDatabase(() => {
    const failure = failures.shift()
    return {
      getD1Database: () => Promise.reject(failure),
      dispose: () => {
        disposals++
        return Promise.resolve()
      },
    }
  }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(rejection).toBe(second)
  expect(failures).toEqual([])
  expect(disposals).toBe(2)
})

it.each([
  ['wrong syscall', startupError('EBADF', 'close', `    at updateConfig (${miniflare}:120261:26)`)],
  ['later D1 I/O', startupError('EBADF', 'send', `    at dispatchFetch (${miniflare}:120261:26)`)],
  [
    'different package',
    startupError('EBADF', 'send', '    at updateConfig (/fixture/runtime.js:1:1)'),
  ],
  [
    'invalid configuration',
    startupError('ERR_RUNTIME_FAILURE', '', `    at updateConfig (${miniflare}:120261:26)`),
  ],
] as const)('keeps %s fatal after disposal', async (_name, failure) => {
  let disposals = 0
  const rejection = await openDatabase(() => ({
    getD1Database: () => Promise.reject(failure),
    dispose: () => {
      disposals++
      return Promise.resolve()
    },
  })).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(rejection).toBe(failure)
  expect(disposals).toBe(1)
})

it('retains an independent disposal failure and prevents a second start', async () => {
  const startup = pipeFailure()
  const cleanup = new Error('Cleanup did not finish')
  let attempts = 0
  const rejection = await openDatabase(() => {
    attempts++
    return {
      getD1Database: () => Promise.reject(startup),
      dispose: () => Promise.reject(cleanup),
    }
  }).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(rejection).toBeInstanceOf(AggregateError)
  expect((rejection as AggregateError).errors).toEqual([startup, cleanup])
  expect(attempts).toBe(1)
})
