/** Freeze the authored victory gesture on actual native outfits for contact/silhouette review. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:4396'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-tip-hat-native'
await mkdir(output)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
const ALIGNMENT =
  /^ASSERT FAILED: {2}Non-interleaved vertex format with element size not multiple of 4 can have performance impact on some platforms\. Element size: [36]$/u
const diagnostics: string[] = []
const records: unknown[] = []
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } })
  await page.routeWebSocket(`ws://${new URL(base).host}/**`, () => undefined)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !ALIGNMENT.test(message.text())) {
      errors.push(message.text())
    } else if (message.type() === 'error') {
      diagnostics.push(message.text())
    }
  })
  await page.goto(`${base}/experiments/out-west/#debug&level=1`)
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ow')), null, {
    timeout: 60_000,
  })
  await page.locator('.ow-start').click()
  await page.waitForFunction(() => Reflect.get(globalThis, '__ow').director.phase === 'cock')
  await page.locator('.ow-start').waitFor({ state: 'hidden' })
  for (const outfit of ['outfit.trail-duds', 'outfit.wool-duster']) {
    for (const paired of [false, true]) {
      const name = `${outfit}-${paired ? 'pair' : 'single'}`
      await page.evaluate(
        async ({ selected, pair }) => {
          const d = Reflect.get(globalThis, '__ow').director
          d.paused = true
          d.game.app.timeScale = 0
          d.player.root.enabled = false
          d.enemy.root.enabled = false
          Reflect.get(globalThis, '__tipHatActor')?.destroy()
          const equipmentPath = '/src/experiments/out-west/scene/native-equipment.ts'
          const catalogPath = '/src/experiments/out-west/data/catalog.ts'
          const { equippedActor } = await import(/* @vite-ignore */ equipmentPath)
          const { DEFAULT_LOADOUT } = await import(/* @vite-ignore */ catalogPath)
          const actor = await equippedActor(
            d.game,
            { ...DEFAULT_LOADOUT, outfit: selected, ...(pair ? { gun: 'gun.hardins-pair' } : {}) },
            {},
            { local: true },
          )
          actor.face(-20)
          actor.play('TipHat', 0)
          if (actor.model.anim.baseLayer.activeState !== 'TipHat') {
            throw new Error('Native gesture clip missing')
          }
          d.game.camera.setPosition(2, 1.25, 3.5)
          d.game.camera.lookAt(0, 0.95, 0)
          d.game.camera.camera.fov = 35
          Reflect.set(globalThis, '__tipHatActor', actor)
        },
        { selected: outfit, pair: paired },
      )
      for (const time of [0, 0.48, 0.75, 1.14, 1.5]) {
        const record = await page.evaluate(async (at) => {
          const actor = Reflect.get(globalThis, '__tipHatActor')
          const anim = actor.model.anim
          anim.playing = true
          anim.baseLayer.activeStateCurrentTime = at
          anim.update(0)
          anim.playing = false
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          if (
            actor.weaponMounts.some(
              (mount: { drawn: boolean; node: { enabled: boolean } }) =>
                mount.drawn && mount.node.enabled,
            )
          ) {
            throw new Error('Gun remained in hand during hat tip')
          }
          return {
            state: anim.baseLayer.activeState,
            time: anim.baseLayer.activeStateCurrentTime,
            bones: Object.fromEntries(
              ['WristR', 'Head', 'FootL', 'FootR'].map((bone) => [
                bone,
                actor.model.findByName(bone)?.getPosition().toArray(),
              ]),
            ),
          }
        }, time)
        await page.screenshot({ path: `${output}/${name}-${time}.png` })
        records.push({ name, requestedTime: time, ...record })
      }
    }
  }
  await writeFile(
    `${output}/receipt.json`,
    `${JSON.stringify({ records, errors, diagnostics }, null, 2)}\n`,
  )
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(`PASS: ${records.length} native TipHat pose captures; ${errors.length} page errors`)
} finally {
  await browser.close()
}
