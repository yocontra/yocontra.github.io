/** Real page boot, timed keyboard play, equipped variants, boss phases, and Daily lifecycle. */
import { chromium, type Locator } from 'playwright'

const base = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://localhost:4389'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/experiments/out-west/#debug&level=1`)
  const gazette = page.getByRole('dialog', { name: 'The Perdition Gazette' })
  await page.addLocatorHandler(gazette, async (overlay) => {
    await overlay.locator('.ow-gz-hint.on').click()
  })
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ow')), null, {
    timeout: 60_000,
  })
  await page.locator('.ow-title.ready .ow-logo').click()
  await page.waitForFunction(() => Reflect.get(globalThis, '__ow').director.phase === 'cock')
  const pause = page.getByRole('button', { name: 'Pause', exact: true })
  const pauseIcon = pause.locator('span').first()
  const paused = page.getByRole('heading', { name: 'Paused', exact: true })
  const pauseInputs = ['mouse', 'touch', 'Space', 'Enter'] as const
  const cdp = await page.context().newCDPSession(page)
  const tap = async (target: Locator) => {
    await target.scrollIntoViewIfNeeded()
    const bounds = await target.boundingBox()
    if (!bounds) {
      throw new Error(`Cannot tap ${target}`)
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }],
    })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  for (const method of pauseInputs) {
    if (method === 'mouse') {
      await pauseIcon.click()
    } else if (method === 'touch') {
      await tap(pauseIcon)
    } else {
      await pause.press(method)
    }
    await paused.waitFor({ timeout: 3000 })
    if (await page.evaluate(() => Reflect.get(globalThis, '__ow').director.c.input.pointerHeld)) {
      throw new Error(`Pause passed ${method} input to the duel`)
    }
    await page.keyboard.press('Escape')
    await paused.waitFor({ state: 'hidden' })
  }
  await pause.click()
  await paused.waitFor()
  const remap = (action: string) =>
    page.locator('.ow-key-row').filter({ hasText: action }).getByRole('button')
  const walkKey = remap('Walk')
  const retryKey = remap('Retry')
  const originalWalk = await walkKey.textContent()
  const originalRetry = await retryKey.textContent()
  await walkKey.click()
  await retryKey.click()
  if ((await walkKey.textContent()) !== originalWalk) {
    throw new Error('Switching remap rows left the prior prompt active')
  }
  for (const [key, label] of [
    ['Escape', 'Esc'],
    ['p', 'P'],
    ['r', originalRetry],
  ] as const) {
    await page.keyboard.press(key)
    if ((await retryKey.textContent()) !== label || !(await paused.isVisible())) {
      throw new Error(`Active remap did not retain ${key}`)
    }
    if (key !== 'r') {
      await retryKey.click()
    }
  }

  await walkKey.click()
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
    } finally {
      Reflect.deleteProperty(document, 'hidden')
      document.dispatchEvent(new Event('visibilitychange'))
    }
  })
  if ((await walkKey.textContent()) !== originalWalk) {
    throw new Error('Hiding the page left a remap pending')
  }

  await walkKey.click()
  await page.locator('.ow-menu').getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  const music = settings.getByRole('slider', { name: 'Music', exact: true })
  const beforeVolume = await music.inputValue()
  await music.press(beforeVolume === '0' ? 'ArrowRight' : 'ArrowLeft')
  if (
    (await music.inputValue()) === beforeVolume ||
    (await walkKey.textContent()) !== originalWalk
  ) {
    throw new Error('Pending remap captured a key from the Settings sheet')
  }
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await walkKey.click()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await paused.waitFor({ state: 'hidden' })
  await page.keyboard.press('w')
  await pause.click()
  if ((await walkKey.textContent()) !== originalWalk) {
    throw new Error('Resuming left a detached remap waiting for gameplay input')
  }
  await page.keyboard.press('Escape')
  await paused.waitFor({ state: 'hidden' })

  await page.keyboard.down('w')
  await page.waitForFunction(() => Reflect.get(globalThis, '__ow').director.phase === 'wait')
  await page.keyboard.up('w')
  await page.waitForFunction(
    () => Reflect.get(globalThis, '__ow').director.phase === 'call',
    null,
    { timeout: 30_000 },
  )
  await page.keyboard.press('Space')
  await page.waitForFunction(() => Reflect.get(globalThis, '__ow').director.phase === 'win')
  await page.screenshot({ path: '/tmp/out-west-native-duel-result.png' })
  const result = await page.evaluate(async () => {
    const game = Reflect.get(globalThis, '__ow')
    const d = game.director
    const first = { phase: d.phase, duels: d.c.save.run.duels.length, purse: d.c.save.run.total }
    if (first.duels !== 1 || first.purse <= 0) {
      throw new Error('Timed keyboard win did not book exactly one positive bounty')
    }
    d.saloon()
    const modulePath = '/src/experiments/out-west/data/catalog.ts'
    const { DEFAULT_LOADOUT } = await import(/* @vite-ignore */ modulePath)
    const original = d.player.root
    game.dress(
      {
        ...DEFAULT_LOADOUT,
        outfit: 'outfit.wool-duster',
        hat: 'hat.sombrero',
        gun: 'gun.hardins-pair',
        extra: 'extra.red-bandana',
        holster: 'holster.buscadero',
      },
      { 'outfit.wool-duster': 'indigo', 'hat.sombrero': 'sand', 'extra.red-bandana': 'oxblood' },
    )
    await new Promise<void>((resolve, reject) => {
      let n = 0
      const timer = setInterval(() => {
        if (d.player.root !== original) {
          clearInterval(timer)
          resolve()
        } else if (n++ > 400) {
          clearInterval(timer)
          reject(new Error('Equipment timed out'))
        }
      }, 25)
    })
    if (d.player.weaponMounts.length !== 4) {
      throw new Error('Paired revolvers lost a mount')
    }
    const mats = d.player.root
      .findComponents('render')
      .flatMap((render: { meshInstances: { material: { name: string; diffuseMap: unknown } }[] }) =>
        render.meshInstances.map((mesh) => mesh.material),
      )
    const equipmentPath = '/src/experiments/out-west/content/equipment.ts'
    const { EQUIPMENT } = await import(/* @vite-ignore */ equipmentPath)
    const outfit = EQUIPMENT['outfit.wool-duster']
    const fitted = await d.game.loadContainer((outfit.pair ?? outfit).url)
    const fabric = fitted.resource.data.gltf.materials.find(
      (material: { name?: string }) => material.name === 'Dyeable',
    )
    const indigoUrl = fabric?.extras?.nativePbr?.dyes?.indigo
    if (!indigoUrl) {
      throw new Error('Authored indigo PBR map missing')
    }
    const indigo = await d.game.loadTexture(indigoUrl, { srgb: true, flipY: false })
    if (
      !mats.some(
        (mat: { name: string; diffuseMap: unknown }) =>
          mat.name === 'Dyeable' && mat.diffuseMap === indigo.resource,
      )
    ) {
      throw new Error('Indigo dye missing')
    }
    d.hubShot('store')
    return first
  })
  await page.screenshot({ path: '/tmp/out-west-native-equipment-live.png' })
  await page.evaluate(() => Reflect.get(globalThis, '__ow').director.finishRun())
  const ledger = page.locator('.ow-end.on')
  const legend = ledger.getByRole('button', { name: 'Legend mode', exact: true })
  const cancel = ledger.getByRole('button', { name: 'Cancel', exact: true })
  await legend.click()
  await cancel.waitFor({ timeout: 3000 })
  await tap(cancel)
  await cancel.waitFor({ state: 'hidden' })
  await legend.press('Space')
  await cancel.waitFor({ timeout: 3000 })
  await cancel.press('Enter')
  await cancel.waitFor({ state: 'hidden' })
  await ledger.getByRole('button', { name: 'Back', exact: true }).click()
  await ledger.waitFor({ state: 'hidden' })
  await cdp.detach()
  const acts: string[] = []
  for (const [slot, stage, fakeout] of [
    [6, 'depot', 'crow'],
    [10, 'mission', 'door'],
    [13, 'bank', 'coin'],
  ] as const) {
    await page.evaluate(
      async ({ level, arena, cue }) => {
        const d = Reflect.get(globalThis, '__ow').director
        await d.startLevel(level)
        if (d.arenas.id !== arena) {
          throw new Error(`Wrong act arena for slot ${level}`)
        }
        if (d.game.stage.findByName('street').enabled) {
          throw new Error('Street geometry overlaps act arena')
        }
        d.remotePace(6)
        d.wait()
        d.clock.cancel() // Capture the manual cue without allowing an unattended duel to resolve.
        d.cue(cue)
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        const actor = d.game.stage.findByName(cue === 'crow' ? 'town-crow-0' : `fakeout-${cue}`)
        if (!actor?.enabled) {
          throw new Error(`Missing readable native ${cue} fakeout`)
        }
        const component = actor.findComponents('anim')[0]
        if (component?.baseLayer?.activeState !== (cue === 'crow' ? 'Fly' : 'Gun_Shoot')) {
          throw new Error(`Native ${cue} animation did not play`)
        }
      },
      { level: slot, arena: stage, cue: fakeout },
    )
    await page.screenshot({ path: `/tmp/out-west-native-${stage}-cue.png` })
    acts.push(stage)
  }
  const lifecycle = await page.evaluate(async () => {
    const d = Reflect.get(globalThis, '__ow').director
    const original = d.c.save
    await d.startLevel(16)
    d.enter('call')
    d.resolve('win', 200)
    if (d.phase !== 'bossWound' || d.bossPhase !== 2 || !d.enemyAlive) {
      throw new Error('Boss phase two was not restored alive')
    }
    d.enter('call')
    d.resolve('win', 200)
    if (d.phase !== 'win' || d.c.save.run.duels.length !== 2) {
      throw new Error('Boss result booked at wrong phase')
    }
    d.saloon()
    await d.startLevel(0)
    d.enter('call')
    d.callTime = performance.now() - 180
    d.plan = { callT: d.callTime, shots: [], e: 0 }
    const point = d.enemy.model.findByName('Head').getPosition().clone()
    point.y += 0.12
    const screen = d.game.camera.camera.worldToScreen(point)
    const canvas = d.game.app.graphicsDevice.canvas
    const rect = canvas.getBoundingClientRect()
    d.shoot({
      action: 'fire',
      source: 'pointer',
      t: performance.now(),
      x: rect.left + (screen.x * rect.width) / canvas.width,
      y: rect.top + (screen.y * rect.height) / canvas.height,
    })
    if (!d.hatShot || d.phase !== 'win') {
      throw new Error('Native pointer trick shot did not win with hat-shot metadata')
    }
    d.saloon()
    let exited = false
    const normalFog = d.game.app.scene.fog.type
    const session = { listen: () => undefined, send: () => undefined, close: () => undefined }
    await d.dailyDuel({ outlaw: 0, modifiers: ['fog', 'no-bell'] }, session, () => {
      exited = true
    })
    if (
      d.c.save === original ||
      d.game.app.scene.fog.type !== 'exp2' ||
      d.game.app.scene.fog.density !== 0.07
    ) {
      throw new Error('Daily did not isolate save or apply native fog')
    }
    d.leaveSpecial()
    if (d.c.save !== original || !exited || d.game.app.scene.fog.type !== normalFog) {
      throw new Error('Daily did not restore gauntlet and environment')
    }
    const keys = d.c.input.keys
    if (!keys.walk.includes('KeyW')) {
      throw new Error('Keyboard settings lost')
    }
    Reflect.get(globalThis, '__ow').destroy()
    if (d.c.input.enabled || !d.lifecycle.signal.aborted) {
      throw new Error('Game destroy did not release input/lifecycle')
    }
    return { bossPhases: 2, dailySaveRestored: true, disposed: true }
  })
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(
    JSON.stringify(
      { pauseInputs, remapLifecycle: true, ledgerControls: true, result, acts, lifecycle, errors },
      null,
      2,
    ),
  )
} finally {
  await browser.close()
}
