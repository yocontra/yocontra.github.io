import { join } from 'node:path'
import type { Page } from 'playwright'
import type { FrontierSession } from '../../src/experiments/out-west/client/frontier-session.ts'
import { CHANNEL_LEAVE } from '../../src/experiments/out-west/contract/town.ts'

export async function captureRoundReturn(page: Page, out: string, receipts: object[]) {
  const summary = page.getByRole('dialog', { name: 'Round summary' })
  if (!(await summary.isVisible())) {
    // Ask the active round to ring its bell through its existing development entry point.
    await page.evaluate(async () => {
      const path = '/src/experiments/out-west/ffa/client/round.ts'
      const { Rounds } = (await import(
        path
      )) as typeof import('../../src/experiments/out-west/ffa/client/round.ts')
      const key = Rounds.prototype.key
      Rounds.prototype.key = function (code) {
        if (code !== 'ShiftLeft') {
          return key.call(this, code)
        }
        Rounds.prototype.key = key
        this.devEnd()
        return true
      }
    })
    await page.keyboard.press('ShiftLeft')
  }
  await summary.waitFor({ timeout: 120_000 })
  await page.screenshot({
    path: join(out, 'round-summary.jpg'),
    timeout: 180_000,
    animations: 'disabled',
  })
  receipts.push({
    name: 'round-summary',
    trigger: 'final practice clock tick',
    viewport: page.viewportSize(),
    result: await summary.textContent(),
  })
  await summary.getByRole('button', { name: 'Leave town' }).click()
  const result = await Promise.race([
    page
      .locator('.ow-hub.on')
      .waitFor()
      .then(() => 'returned'),
    page
      .waitForFunction(
        (leave) => {
          const session = Reflect.get(globalThis, '__nativeFrontierSession') as
            | FrontierSession
            | undefined
          const self = session?.world.players[session.selfSlot]
          const card = document.querySelector<HTMLElement>('.fr-summary')
          return Boolean(self && self.channel?.kind === leave && card && !card.hidden)
        },
        CHANNEL_LEAVE,
        { polling: 100 },
      )
      .then(() => 'reopened'),
  ])
  if (result === 'reopened') {
    await page.screenshot({
      path: join(out, 'round-leave-paused.jpg'),
      animations: 'disabled',
      timeout: 180_000,
    })
    const trace = await page.evaluate(() => {
      const s = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
      return { tick: s.world.tick, channel: s.world.players[s.selfSlot]?.channel }
    })
    receipts.push({ name: 'round-leave-paused', ...trace })
    throw new Error('The summary reopened and paused the rider during Leave town')
  }
  await page.screenshot({
    path: join(out, 'round-return.jpg'),
    timeout: 180_000,
    animations: 'disabled',
  })
  receipts.push({ name: 'round-return', url: page.url() })
}
