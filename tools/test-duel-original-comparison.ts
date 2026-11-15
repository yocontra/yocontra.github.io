/** Frozen reaction-time comparison against the separately served original engine revision. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-special-duel-comparison'
const original = process.env.OW_ORIGINAL ?? 'http://127.0.0.1:4391'
const current = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4389'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const records: unknown[] = []
try {
  for (const build of [
    { name: 'original', origin: original },
    { name: 'native', origin: current },
  ]) {
    for (const level of [16, 17]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.routeWebSocket(`ws://${new URL(build.origin).host}/**`, (socket) => socket.close())
      await page.goto(`${build.origin}/experiments/out-west/#debug&level=${level}`)
      await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ow')), null, {
        timeout: 90_000,
      })
      await page.locator('.ow-start').click()
      await page.waitForFunction(
        () => Reflect.get(globalThis, '__ow').director.phase === 'cock',
        null,
        { timeout: 90_000 },
      )
      await page.locator('.ow-start').waitFor({ state: 'hidden' })
      const initial = await page.evaluate(
        async ({ native, boss }) => {
          const d = Reflect.get(globalThis, '__ow').director
          d.paused = true
          const path = `/src/experiments/out-west/${native ? 'duel/native-camera' : 'duel/state'}.ts`
          const { V } = await import(path)
          if (native) {
            await d.debris.ready
            d.game.app.timeScale = 0
            if (!boss) {
              d.remotePace(6)
            }
            d.wait()
            d.call()
          } else {
            if (!boss) {
              const { BACK_TO_BACK_Z } = await import(path)
              d.paces = 6
              d.pDist = 6 * d.player.paceLength
              d.eDist = 6 * d.enemy.paceLength
              d.player.root.position.z = -BACK_TO_BACK_Z - d.pDist
              d.enemy.root.position.z = BACK_TO_BACK_Z + d.eDist
            }
            d.enterWait(false)
            const callPath = '/src/experiments/out-west/duel/standoff.ts'
            const { onCall } = await import(callPath)
            onCall(d, d.duelId)
            d.c.world.apply(d.outlaw.day)
            const presentationPath = '/src/experiments/out-west/duel/present.ts'
            const { tickPresentation } = await import(presentationPath)
            // Pausing holds gameplay timers; settle the original draw flash explicitly.
            tickPresentation(d, 0.2)
          }
          const rig = native ? d.rig : d.c.rig
          rig.trauma = 0
          rig.cut('matched-special-duel', () => ({
            pos: boss ? V(4, 2, 49) : V(5, 3, -13),
            look: boss ? V(0, 1.2, 53) : V(0, 2, 6),
            fov: 55,
          }))
          rig.update(0, 0)
          for (const actor of [d.player, d.enemy, d.rifleman]) {
            if (native) {
              actor?.model.anim?.update(0.2)
            } else {
              actor?.update(0.2)
            }
          }
          return { phase: d.phase, level: d.level, bossPhase: d.bossPhase }
        },
        { native: build.name === 'native', boss: level === 17 },
      )
      await page.screenshot({ path: `${output}/${build.name}-${level}-call.png` })
      const shots = await page.evaluate(
        async ({ native, boss }) => {
          const d = Reflect.get(globalThis, '__ow').director
          const path = '/src/experiments/out-west/duel/standoff.ts'
          const old = native ? undefined : await import(path)
          const fire = (ms: number) => {
            const press = {
              action: 'fire',
              t: (native ? d.callTime : d.callT) + ms,
              source: 'key',
              x: -1,
              y: -1,
            }
            if (native) {
              d.shoot(press)
            } else {
              old?.playerShoots(d, press)
            }
            return {
              phase: d.phase,
              shots: native ? d.shots : d.targetsDown,
              enemy: d.enemyAlive,
              rifleman: d.riflemanAlive,
            }
          }
          const first = fire(200)
          if (!boss) {
            const early = fire(250)
            const second = fire(310)
            if (
              first.rifleman ||
              !first.enemy ||
              early.shots !== 1 ||
              second.phase !== 'win' ||
              second.shots !== 2
            ) {
              throw new Error(
                `Underboss parity failed: ${JSON.stringify({ first, early, second })}`,
              )
            }
            return { first, early, second }
          }
          if (first.phase !== 'bossWound') {
            throw new Error('Boss did not enter the wound phase')
          }
          return { first }
        },
        { native: build.name === 'native', boss: level === 17 },
      )
      const ending = await page.evaluate(
        async ({ native, boss }) => {
          const d = Reflect.get(globalThis, '__ow').director
          const path = `/src/experiments/out-west/duel/${native ? 'native-outcome' : 'outcome'}.ts`
          const outcome = await import(path)
          if (boss) {
            d.phaseT = 0.08
            outcome.tickBossWound(d)
            for (let frame = 0; frame < 30; frame++) {
              if (native) {
                d.debris.update(1 / 60)
              } else {
                d.c.physics.update(1 / 60, 0)
              }
            }
            d.phaseT = 2.41
            outcome.tickBossWound(d)
            if (d.bossPhase !== 2) {
              throw new Error('Boss second phase not restored after 2.4 seconds')
            }
          } else {
            d.phaseT = 0.3
            outcome.tickWin(d, 0.3)
          }
          if (!native) {
            const presentationPath = '/src/experiments/out-west/duel/present.ts'
            const { tickPresentation } = await import(presentationPath)
            tickPresentation(d, 0.3)
          }
          // Let transient impact frames complete before recording the settled outcome.
          for (let frame = 0; frame < 6; frame++) {
            for (const actor of [d.player, d.enemy, d.rifleman]) {
              if (native) {
                actor?.model.anim?.update(1 / 60)
              } else {
                actor?.update(1 / 60)
              }
            }
            if (native) {
              const momentsPath = '/src/experiments/out-west/duel/native-moments.ts'
              // Vite may stamp imports after a source edit. Use the mounted module instance:
              // a fresh unstamped import would have a different kill-frame WeakMap.
              const mounted = performance
                .getEntriesByType('resource')
                .find((entry) => new URL(entry.name).pathname.endsWith(momentsPath))?.name
              const { tickMoments } = await import(mounted ?? momentsPath)
              tickMoments(d, 1 / 60, 1 / 60)
              d.rig.update(1 / 60)
            }
            await new Promise(requestAnimationFrame)
          }
          if (native && d.game.camera.camera.clearColor.toString() === '#ff0000') {
            throw new Error('Settled comparison retained an impact frame')
          }
          return {
            phase: d.phase,
            bossPhase: d.bossPhase,
            reaction: native ? d.reactionMs : d.lastReaction,
          }
        },
        { native: build.name === 'native', boss: level === 17 },
      )
      await page.screenshot({ path: `${output}/${build.name}-${level}-outcome.png` })
      records.push({ build: build.name, level, initial, shots, ending, errors })
      if (errors.length > 0) {
        throw new Error(errors.join('\n'))
      }
      await page.close()
    }
  }
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify({ originalRevision: '18e39f5', records }, null, 2),
  )
} finally {
  await browser.close()
}
