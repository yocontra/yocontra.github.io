import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import type { NativeEnvironment } from '../../src/experiments/out-west/client/environment.ts'
import type { FrontierSession } from '../../src/experiments/out-west/client/frontier-session.ts'

// On a software GPU, keep the game loop live while expensive frames render.
export async function configureRenderTicks(ticks: number) {
  const native = performance
    .getEntriesByType('resource')
    .find(
      (entry) =>
        entry.name.includes('/.vite/') && new URL(entry.name).pathname.endsWith('/playcanvas.js'),
    )
  if (!native) {
    throw new Error('Cannot identify the running PlayCanvas module')
  }
  const { AppBase } = (await import(native.name)) as typeof import('playcanvas')
  const app = AppBase.getApplication()
  const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
  if (!app) {
    throw new Error('Missing game application')
  }
  Reflect.set(globalThis, '__referenceApp', app)
  app.autoRender = false
  let next = session.world.tick
  app.on('update', () => {
    if (session.world.tick >= next) {
      app.renderNextFrame = true
      next = session.world.tick + ticks
    }
  })
}

export async function setLight(time: number) {
  const envPath = '/src/experiments/out-west/client/environment.ts'
  const { NativeEnvironment: Environment } = (await import(
    envPath
  )) as typeof import('../../src/experiments/out-west/client/environment.ts')
  const env = await new Promise<NativeEnvironment>((resolve) => {
    const update = Environment.prototype.syncTumbleweeds
    Environment.prototype.syncTumbleweeds = function (...args) {
      Environment.prototype.syncTumbleweeds = update
      update.apply(this, args)
      resolve(this)
    }
  })
  await env.setTime(time)
}

export function photographBar(page: Page, out: string) {
  return photograph(page, out, {
    file: 'bar-reference.jpg',
    day: 0.3,
    eye: [28.1, 1.55, 38.4],
    target: [25.6, 1.1, 36.95],
  })
}

export function photographDesert(page: Page, out: string) {
  return photograph(page, out, {
    file: 'desert-reference.jpg',
    day: 0,
    eye: [50.5, 1.75, 14.3],
    target: [61, 1.4, 11],
  })
}

async function photograph(
  page: Page,
  out: string,
  view: {
    file: string
    day: number
    eye: [number, number, number]
    target: [number, number, number]
  },
) {
  await page.setViewportSize({ width: 812, height: 375 })
  await page.evaluate(setLight, view.day)
  const data = await page.evaluate(async ({ eye, target }) => {
    const pc = performance
      .getEntriesByType('resource')
      .find(
        (e) => e.name.includes('/.vite/') && new URL(e.name).pathname.endsWith('/playcanvas.js'),
      )
    if (!pc) {
      throw new Error('Missing running engine')
    }
    const { AppBase } = (await import(pc.name)) as typeof import('playcanvas')
    const app = AppBase.getApplication()
    const camera = app?.root.findByName('camera')
    if (!(app && camera)) {
      throw new Error('Missing Frontier camera')
    }
    const image = new Promise<string>((resolve) => {
      app.once('prerender', () => {
        app.graphicsDevice.setResolution(812, 375)
        camera.setPosition(...eye)
        camera.lookAt(...target)
      })
      app.once('postrender', () =>
        resolve((app.graphicsDevice.canvas as HTMLCanvasElement).toDataURL('image/jpeg', 0.94)),
      )
    })
    app.renderNextFrame = true
    return await image
  }, view)
  await writeFile(join(out, view.file), Buffer.from(data.split(',')[1] ?? '', 'base64'))
}
