/** Visual and live native binding checks across weapon classes, accessories and animation extremes. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const root = process.env.OUT_WEST_URL ?? 'http://127.0.0.1:4390'
const output = '/tmp/out-west-character-poses-final'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
const results: unknown[] = []
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } })
  await page.routeWebSocket(
    (url) => url.origin === 'ws://127.0.0.1:4390',
    () => undefined,
  )
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${root}/404`, { waitUntil: 'domcontentloaded' })
  const cases = [
    {
      name: 'all-categories-idle-side',
      loadout: {
        outfit: 'outfit.trail-duds',
        hat: 'hat.sombrero',
        gun: 'gun.hardins-pair',
        holster: 'holster.silver-conchos',
        extra: 'extra.red-bandana',
        spurs: 'spurs.legend-rowels',
      },
      clip: 'Idle',
      yaw: 120,
    },
    {
      name: 'paired-aim',
      loadout: { gun: 'gun.hardins-pair' },
      clip: 'Idle_Gun_Pointing',
      yaw: -55,
    },
    { name: 'paired-draw', loadout: { gun: 'gun.hardins-pair' }, clip: 'Draw', yaw: -55 },
    { name: 'paired-shot', loadout: { gun: 'gun.hardins-pair' }, clip: 'Gun_Shoot', yaw: -55 },
    { name: 'paired-spin', loadout: { gun: 'gun.hardins-pair' }, clip: 'Spin', yaw: -55 },
    {
      name: 'shirt-vest-single-aim',
      loadout: { outfit: 'outfit.shirt-vest' },
      clip: 'Idle_Gun_Pointing',
      yaw: -55,
    },
    {
      name: 'shirt-vest-pair-aim',
      loadout: { outfit: 'outfit.shirt-vest', gun: 'gun.hardins-pair' },
      clip: 'Idle_Gun_Pointing',
      yaw: -55,
    },
    {
      name: 'shirt-vest-crouch',
      loadout: { outfit: 'outfit.shirt-vest' },
      clip: 'Crouch_Idle',
      yaw: 120,
    },
    {
      name: 'shirt-vest-pair-spin',
      loadout: { outfit: 'outfit.shirt-vest', gun: 'gun.hardins-pair' },
      clip: 'Spin',
      yaw: -55,
    },
    { name: 'single-draw', loadout: {}, clip: 'Draw', yaw: -55 },
    { name: 'single-fakeout', loadout: {}, clip: 'Flinch', yaw: -55 },
    { name: 'single-hit', loadout: {}, clip: 'HitRecieve', yaw: -55 },
    { name: 'single-death', loadout: {}, clip: 'Death', yaw: -55 },
    {
      name: 'crouch-spurs',
      loadout: { spurs: 'spurs.legend-rowels' },
      clip: 'Crouch_Idle',
      yaw: 120,
    },
    {
      name: 'stride-spurs',
      loadout: { spurs: 'spurs.legend-rowels' },
      clip: 'Stride_Run_2',
      yaw: 120,
    },
  ]
  for (const item of cases) {
    const pose = await page.evaluate(async (sample) => {
      const path = '/tools/content/character-preview.ts'
      const view = await import(path)
      await view.previewCharacter(sample.loadout, {}, sample.clip, sample.yaw)
      view.assertCharacterBindings()
      return view.poseMetrics()
    }, item)
    await page.screenshot({ path: `${output}/${item.name}.png` })
    results.push({ name: item.name, pose })
  }
  for (const weapon of ['rifle', 'shotgun'] as const) {
    for (const shot of [false, true]) {
      const pose = await page.evaluate(
        async (sample) => {
          const path = '/tools/content/character-preview.ts'
          const view = await import(path)
          await view.previewHeldWeapon(sample.weapon, sample.shot)
          view.assertCharacterBindings()
          return view.poseMetrics()
        },
        { weapon, shot },
      )
      await page.screenshot({ path: `${output}/${weapon}-${shot ? 'shot' : 'hold'}.png` })
      results.push({ weapon, shot, pose })
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join(';'))
  }
  await writeFile(`${output}/results.json`, JSON.stringify({ results, errors }, null, 2))
  console.log('PASS native gear binding and weapon/animation extremes', results.length)
} finally {
  await browser.close()
}
