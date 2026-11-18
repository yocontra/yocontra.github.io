/** Headless-only actual-game hip/iron-sight composition and obstruction review. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve as resolvePath } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { SIGHTS } from '../src/experiments/out-west/client/first-person-sights.ts'
import type { FrontierSession } from '../src/experiments/out-west/client/frontier-session.ts'
import type { GameViewport } from '../src/experiments/out-west/client/viewport.ts'
import { CONTENT_VERSION } from '../src/experiments/out-west/content/manifest.ts'
import { DEFAULTS } from '../src/experiments/out-west/ffa/client/settings.ts'
import { frameObstruction } from './content/frame-obstruction.ts'
import type { captureFraming } from './content/long-gun-framing-probe.ts'

const origin = process.env.OUT_WEST_URL ?? 'http://127.0.0.1:4402'
const output = process.env.OUT_WEST_OUTPUT ?? '/tmp/out-west-long-gun-framing'
const quick = process.argv.includes('--quick')
const identifyParts = process.argv.includes('--parts')
const staging = process.env.OUT_WEST_VIEWMODELS
const probe = '/tools/content/long-gun-framing-probe.ts'
const VIEWMODEL_ASSET =
  /\/native-v2\/(?:viewmodels\/|dynamic\/(?:held-|viewmodel-arm-curves)).*\.glb/u
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const staged = staging
  ? await Promise.all(
      ['outfit.trail-duds', ...(quick ? [] : ['outfit.wool-duster'])].map(async (fit) => {
        const path = resolvePath(staging, `${fit}.glb`)
        const body = await readFile(path)
        return { path, body, sha256: hash(body) }
      }),
    )
  : []
const servedAssets = new Map<string, { url: string; bytes: number; sha256: string }>()
const assetReads: Promise<void>[] = []
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results: unknown[] = []
const errors: string[] = []
const startedAt = new Date().toISOString()
try {
  for (const [orientation, viewport] of [
    ['landscape', { width: 1280, height: 720 }],
    ...(quick ? [] : ([['phone-landscape', { width: 812, height: 375 }]] as const)),
    ['portrait', { width: 375, height: 812 }],
  ] as const) {
    const page = await browser.newPage({ viewport })
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('response', (response) => {
      if (VIEWMODEL_ASSET.test(response.url())) {
        assetReads.push(
          response
            .body()
            .then((body) => {
              servedAssets.set(response.url(), {
                url: response.url(),
                bytes: body.length,
                sha256: hash(body),
              })
            })
            .catch((error: unknown) => {
              errors.push(`Asset receipt: ${String(error)}`)
            }),
        )
      }
    })
    if (staging) {
      await page.route('**/native-v2/viewmodels/*.glb?*', async (route) => {
        const filename = basename(new URL(route.request().url()).pathname)
        const source = staged.find((file) => basename(file.path) === filename)
        if (!source) {
          errors.push(`Missing staged native viewmodel ${filename}`)
          await route.abort()
          return
        }
        await route.fulfill({ contentType: 'model/gltf-binary', body: source.body })
      })
    }
    await page.goto(
      `${origin}/experiments/out-west/frontier/?server=loopback&bots=0&seed=7&spawn=104,64`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(
      () => Boolean(Reflect.get(globalThis, '__playcanvasFrontier')),
      null,
      { timeout: 120_000 },
    )
    await page.evaluate(() =>
      (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).firstPerson(true),
    )
    await page.evaluate(async (path) => (await import(path)).observeFraming(), probe)
    await page.waitForFunction(
      () => {
        const game = Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport
        const actors = game.debug().actors
        return (
          'viewmodel' in actors &&
          actors.loaded === 1 &&
          actors.viewmodel.arms === 1 &&
          actors.viewmodel.pending === 0
        )
      },
      null,
      { timeout: 120_000 },
    )
    for (const outfit of ['outfit.trail-duds', ...(quick ? [] : ['outfit.wool-duster'])]) {
      const previous = await page.evaluate(
        async (path) => (await import(path)).activeFramingActor(),
        probe,
      )
      await page.evaluate(async (next) => {
        const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
        const self = session.selfId
        const loadout = {
          outfit: next,
          gun: 'gun.rusty-six',
          hat: 'hat.plainsman',
          spurs: 'spurs.plain-rowels',
          holster: 'holster.plain-leather',
          extra: null,
        }
        Reflect.set(session, 'appearance', (id: string) =>
          id === self ? { loadout, dyes: {}, key: `${next}:framing` } : undefined,
        )
        for (let frame = 0; frame < 10; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
      }, outfit)
      await page.waitForFunction(
        async ({ path, old }) => {
          const game = Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport
          const actors = game.debug().actors
          const current = (await import(path)).activeFramingActor()
          return (
            current &&
            current !== old &&
            'viewmodel' in actors &&
            actors.loading === 0 &&
            actors.viewmodel.pending === 0 &&
            actors.viewmodel.arms === 1
          )
        },
        { path: probe, old: previous },
        { timeout: 120_000 },
      )
      for (const [weapon, kind] of [
        ['rifle', 2],
        ['shotgun', 1],
      ] as const) {
        for (const crouched of quick ? [false] : [false, true]) {
          for (const [mode, aimed] of [
            ['hip', false],
            ['ads', true],
          ] as const) {
            await page.evaluate(
              async (pose) => {
                const session = Reflect.get(
                  globalThis,
                  '__nativeFrontierSession',
                ) as FrontierSession
                const game = Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport
                const self = session.world.players[session.selfSlot]
                if (!self) {
                  throw new Error('Missing native rider')
                }
                self.weapon = pose.kind
                self.weaponRounds = 8
                self.reloadTicks = 0
                const path = '/src/experiments/out-west/runtime/protocol.ts'
                const { Buttons } = await import(path)
                for (let frame = 0; frame < 70; frame++) {
                  if (pose.aimed) {
                    game.tap(Buttons.aim)
                  }
                  if (pose.crouched) {
                    game.tap(Buttons.crouch)
                  }
                  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
                }
              },
              { kind, crouched, aimed },
            )
            const result = (await page.evaluate(
              async ({ path, held, viewParts }) =>
                (await import(path)).captureFraming(held, viewParts),
              { path: probe, held: weapon, viewParts: identifyParts },
            )) as ReturnType<typeof captureFraming>
            const label = `${orientation}-${outfit}-${weapon}-${crouched ? 'crouch' : 'stand'}-${mode}`
            if (result.contentVersion !== CONTENT_VERSION) {
              throw new Error(`${label} served a different content manifest`)
            }
            const expectedProfile = SIGHTS.get(weapon)
            if (
              result.profile.relief !== expectedProfile?.relief ||
              result.profile.zoom !== expectedProfile.zoom
            ) {
              throw new Error(`${label} served different sight profiles`)
            }
            if (
              result.stance.crouched !== crouched ||
              result.stance.aimed !== aimed ||
              result.stance.weapon !== kind
            ) {
              throw new Error(`${label} captured a different native stance`)
            }
            const eye = result.view.eye
            const physicalEyeError = Math.hypot(
              eye.x - result.physicalEye.x,
              eye.y - result.physicalEye.y,
              eye.z - result.physicalEye.z,
            )
            if (physicalEyeError > 1e-6) {
              throw new Error(`${label} moved the physical eye by ${physicalEyeError}`)
            }
            const expectedWorldFov =
              DEFAULTS.fovFirst * (aimed ? (SIGHTS.get(weapon)?.zoom ?? 1) : 1)
            if (Math.abs(result.view.fov - expectedWorldFov) > 1e-6) {
              throw new Error(`${label} changed the world lens`)
            }
            if (aimed) {
              const gun = result.geometry.filter(
                ({ material, visible }) => visible && material === 'Gun',
              )
              if (
                gun.length === 0 ||
                gun.some(({ boundsDepth }) => boundsDepth.nearest <= boundsDepth.cameraNear)
              ) {
                throw new Error(`${label} placed the gun inside the camera near plane`)
              }
              const arms = result.view.arms
              for (const landmark of [arms.front, arms.rear]) {
                if (
                  Math.hypot(landmark.x - viewport.width / 2, landmark.y - viewport.height / 2) >
                  1.5
                ) {
                  throw new Error(`${label} moved a sight landmark off the reticle`)
                }
              }
            }
            const image = Buffer.from(result.image.split(',')[1] ?? '', 'base64')
            const mask = Buffer.from(result.mask.split(',')[1] ?? '', 'base64')
            await writeFile(`${output}/${label}.png`, image)
            await writeFile(`${output}/${label}-mask.png`, mask)
            const parts = result.parts
              ? Buffer.from(result.parts.split(',')[1] ?? '', 'base64')
              : undefined
            if (parts) {
              await writeFile(`${output}/${label}-parts.png`, parts)
            }
            const { data, info } = await sharp(mask)
              .removeAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true })
            const { image: _image, mask: _mask, parts: _parts, ...proof } = result
            results.push({
              label,
              ...proof,
              physicalEyeError,
              images: {
                native: `${label}.png`,
                nativeSha256: hash(image),
                mask: `${label}-mask.png`,
                maskSha256: hash(mask),
                parts: parts ? `${label}-parts.png` : undefined,
                partsSha256: parts ? hash(parts) : undefined,
              },
              obstruction: frameObstruction(data, info),
            })
          }
        }
      }
    }
    await Promise.all(assetReads)
    await page.close()
  }
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error))
} finally {
  await Promise.all(assetReads)
  await browser.close()
}
if (results.length !== (quick ? 8 : 48)) {
  errors.push(`Expected ${quick ? 8 : 48} native framing cases; captured ${results.length}`)
}
await writeFile(
  `${output}/receipt.json`,
  JSON.stringify(
    {
      startedAt,
      completedAt: new Date().toISOString(),
      source: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
      files: await Promise.all(
        [
          'src/experiments/out-west/client/application.ts',
          'src/experiments/out-west/client/first-person-curves.ts',
          'src/experiments/out-west/client/first-person-layer.ts',
          'src/experiments/out-west/client/first-person-model.ts',
          'src/experiments/out-west/client/first-person-sights.ts',
          'src/experiments/out-west/content/viewmodels.ts',
          'src/experiments/out-west/content/manifest.ts',
          'tools/content/frame-obstruction.ts',
          'tools/content/long-gun-framing-probe.ts',
          'tools/test-playcanvas-long-gun-framing.ts',
        ].map(async (path) => ({
          path,
          sha256: hash(await readFile(path)),
        })),
      ),
      profiles: [...SIGHTS].map(([weapon, profile]) => ({
        weapon,
        relief: profile.relief,
        zoom: profile.zoom,
      })),
      headless: true,
      nativeSafetyChecks: errors.length === 0 ? 'pass' : 'fail',
      visualAcceptance: 'not-assessed-by-this-probe',
      scope: 'Native game geometry and camera safety; not foreground/device performance acceptance',
      staged: staged.map(({ path, body, sha256 }) => ({ path, bytes: body.length, sha256 })),
      servedAssets: [...servedAssets.values()],
      results,
      errors,
    },
    null,
    2,
  ),
)
if (errors.length > 0) {
  throw new Error(errors.join('; '))
}
console.log(JSON.stringify({ output, cases: results.length, errors }))
