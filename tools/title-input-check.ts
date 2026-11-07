/** Real Chrome regression for title controls, native keyboard activation and touch bubbling. */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4321'
const out = '.playwright-mcp/quality'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] })
let assertions = 0
function check(ok: boolean, message: string): void {
  assertions++
  if (!ok) {
    throw new Error(message)
  }
}
try {
  for (const label of ['keyboard-enter', 'keyboard-space', 'touch']) {
    const touch = label === 'touch'
    const activateKey = label === 'keyboard-space' ? 'Space' : 'Enter'
    const context = await browser.newContext({
      viewport: touch ? { width: 375, height: 812 } : { width: 1440, height: 900 },
      hasTouch: touch,
      isMobile: touch,
    })
    await context.routeWebSocket(
      (url) => url.host === new URL(base).host,
      (socket) => socket.send(JSON.stringify({ type: 'connected' })),
    )
    const page = await context.newPage()
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style')
        style.textContent = 'astro-dev-toolbar{display:none!important}'
        document.head.append(style)
      })
    })
    await page.goto(`${base}/experiments/out-west/`)
    await page.locator('.ow-title.ready').waitFor({ timeout: 120_000 })
    const credits = page.getByRole('button', { name: 'credits', exact: true })
    if (touch) {
      await credits.tap()
    } else {
      await credits.focus()
      await page.keyboard.press(activateKey)
    }
    await page.locator('.ow-credits.on').waitFor()
    check(!(await page.locator('.ow-title.pressed').count()), `${label}: Credits started the game`)
    check(
      (await credits.getAttribute('aria-expanded')) === 'true',
      `${label}: Credits state missing`,
    )
    await page.screenshot({ path: `${out}/credits-${label}-after.png` })
    if (touch) {
      await page.getByRole('button', { name: 'Close credits', exact: true }).tap()
    } else {
      await page.keyboard.press('Escape')
    }
    check((await page.locator('.ow-credits.on').count()) === 0, `${label}: Credits did not close`)
    const board = page.getByRole('button', { name: 'leaderboard', exact: true })
    if (touch) {
      await board.tap()
    } else {
      await board.focus()
      await page.keyboard.press('Space')
    }
    await page.locator('.ow-board.on').waitFor()
    check(
      !(await page.locator('.ow-title.pressed').count()),
      `${label}: Leaderboard started the game`,
    )
    await page.keyboard.press('Escape')
    // Title links and modal text retain all their key/touch interactions; only Start activates.
    const start = page.getByRole('button', { name: 'Start playing', exact: true })
    await page.screenshot({ path: `${out}/title-${label}-after.png` })
    if (touch) {
      await start.tap()
    } else {
      await start.focus()
      await page.keyboard.press(activateKey)
    }
    await page.locator('.ow-hub.on').waitFor({ timeout: 60_000 })
    check(true, `${label}: native Start activation`)
    await page.locator('.ow-title').waitFor({ state: 'detached' })
    await page.screenshot({ path: `${out}/hub-${label}-after.png` })
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.locator('.ow-sheet.on').waitFor()
    await page.locator('.ow-sheet.on').evaluate(async (sheet) => {
      await Promise.all(
        sheet
          .getAnimations({ subtree: true })
          .filter(
            (animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY,
          )
          .map((animation) => animation.finished),
      )
    })
    await page.screenshot({ path: `${out}/more-${label}-after.png` })
    // Isolated, but in the real browser: prove the extracted guard removes all of its handlers.
    const guardPage = await context.newPage()
    await guardPage.goto(base)
    const cleaned = await guardPage.evaluate(async () => {
      const moduleUrl = '/src/experiments/out-west/ui/title-input.ts'
      const { installTitleInput } = await import(/* @vite-ignore */ moduleUrl)
      const title = document.createElement('div')
      const button = document.createElement('button')
      title.append(button)
      document.body.append(title)
      let calls = 0
      const stop = installTitleInput(title, button, () => {
        calls++
      })
      button.click()
      button.click()
      const event = new KeyboardEvent('keydown', { code: 'KeyW', cancelable: true })
      globalThis.dispatchEvent(event)
      stop()
      title.remove()
      return { calls, prevented: event.defaultPrevented }
    })
    check(cleaned.calls === 1 && !cleaned.prevented, `${label}: title listeners survived cleanup`)
    await guardPage.close()
    console.log(`${label}: 6 assertions passed`)
    await context.close()
  }
  console.log(`Title input: ${assertions} assertions passed`)
} finally {
  await browser.close()
}
