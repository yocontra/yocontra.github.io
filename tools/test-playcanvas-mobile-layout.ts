/** Real touch layout checks, including Safari's toolbar-reduced landscape height. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import type { GameViewport } from '../src/experiments/out-west/client/viewport.ts'
import { DEFAULTS } from '../src/experiments/out-west/ffa/client/settings.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-mobile-layout-final'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({
    viewport: { width: 812, height: 265 },
    isMobile: true,
    hasTouch: true,
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(
    `${origin}/experiments/out-west/frontier/?server=loopback&bots=0&seed=7&spawn=72,66`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => Reflect.get(globalThis, '__playcanvasFrontier'), undefined, {
    timeout: 90_000,
  })
  const results: {
    size: { width: number; height: number }
    controlScale: number
    leftHanded: boolean
    controls: { name: string; box: DOMRect }[]
    map: DOMRect | undefined
    objective: DOMRect | undefined
    feed: DOMRect | undefined
    funds: DOMRect | undefined
    clock: DOMRect | undefined
    vitals: DOMRect | undefined
  }[] = []
  for (const size of [
    { width: 812, height: 265 },
    { width: 667, height: 265 },
    { width: 375, height: 664 },
  ]) {
    await page.setViewportSize(size)
    for (const controlScale of [0.8, 1, 1.35]) {
      for (const leftHanded of [false, true]) {
        await page.evaluate(
          (settings) => {
            ;(Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).configure(settings)
          },
          { ...DEFAULTS, controlScale, leftHanded },
        )
        const state = await page.evaluate(() => {
          document.querySelector('.fr-tc')?.classList.add('carry')
          const carried = document.querySelector('.fr-carried')
          if (carried) {
            carried.textContent = '$1,250'
          }
          const banked = document.querySelector<HTMLElement>('.fr-banked')
          if (banked) {
            banked.hidden = false
            banked.textContent = '$250 banked'
          }
          const round = document.querySelector('.fr-round')
          if (round) {
            round.textContent = 'Round 1 · 5:59'
          }
          const feedElement = document.querySelector('.fr-feed')
          if (feedElement && feedElement.childElementCount === 0) {
            const row = document.createElement('div')
            row.className = 'fr-feed-row'
            row.textContent = 'Calamity Blackwood shot Dusty Montgomery'
            feedElement.append(row)
          }
          const description = document.querySelector<HTMLElement>('.fr-obj-text')
          if (description) {
            description.style.animation = 'none'
          }
          // Show every contextual action for geometry only; eligibility is covered by domain tests.
          for (const node of document.querySelectorAll<HTMLElement>('.pc-use,.pc-call,.pc-throw')) {
            node.hidden = false
          }
          const controls = [...document.querySelectorAll<HTMLElement>('.pc-control')].map(
            (node) => ({
              name: node.textContent ?? '',
              box: node.getBoundingClientRect().toJSON(),
            }),
          )
          const map = document.querySelector('.fr-map')?.getBoundingClientRect().toJSON()
          const objective = document.querySelector('.fr-obj')?.getBoundingClientRect().toJSON()
          const feed = document.querySelector('.fr-feed')?.getBoundingClientRect().toJSON()
          const funds = document.querySelector('.fr-tc')?.getBoundingClientRect().toJSON()
          const clock = document.querySelector('.fr-round')?.getBoundingClientRect().toJSON()
          const vitals = document.querySelector('.fr-tl')?.getBoundingClientRect().toJSON()
          return { controls, map, objective, feed, funds, clock, vitals }
        })
        const overlap = (a: DOMRect, b: DOMRect) =>
          a.left < b.right - 0.5 &&
          a.right > b.left + 0.5 &&
          a.top < b.bottom - 0.5 &&
          a.bottom > b.top + 0.5
        const status = [state.funds, state.clock, state.objective, state.feed].filter(
          (box): box is DOMRect => Boolean(box && box.width > 0 && box.height > 0),
        )
        if (state.vitals && state.map && overlap(state.vitals, state.map)) {
          throw new Error(`Vitals overlap map: ${JSON.stringify({ size, ...state })}`)
        }
        for (const [index, box] of status.entries()) {
          if (status.slice(index + 1).some((other) => overlap(box, other))) {
            throw new Error(`HUD status overlaps: ${JSON.stringify({ size, ...state })}`)
          }
        }
        for (const [index, button] of state.controls.entries()) {
          const box = button.box
          if (
            box.width < 44 ||
            box.height < 44 ||
            box.left < 0 ||
            box.right > size.width ||
            box.top < 0 ||
            box.bottom > size.height
          ) {
            throw new Error(
              `Unusable target: ${JSON.stringify({ size, controlScale, leftHanded, button })}`,
            )
          }
          if (state.map && overlap(box, state.map)) {
            throw new Error(
              `Map overlap: ${JSON.stringify({ size, controlScale, leftHanded, button })}`,
            )
          }
          if (status.some((panel) => overlap(box, panel))) {
            throw new Error(
              `HUD covers control: ${JSON.stringify({ size, controlScale, leftHanded, button, status })}`,
            )
          }
          for (const other of state.controls.slice(index + 1)) {
            if (overlap(box, other.box)) {
              throw new Error(
                `Controls overlap: ${JSON.stringify({ size, controlScale, leftHanded, a: button.name, b: other.name })}`,
              )
            }
          }
        }
        results.push({ size, controlScale, leftHanded, ...state })
      }
    }
    await page.screenshot({ path: `${output}/${size.width}x${size.height}.png` })
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  await writeFile(`${output}/measurements.json`, JSON.stringify({ results, errors }, null, 2))
  console.log(JSON.stringify({ layouts: results.length, errors }))
} finally {
  await browser.close()
}
