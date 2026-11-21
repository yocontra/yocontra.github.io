/** Refresh Daily Outlaw likenesses from the native wanted-portrait renderer. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { OUTLAWS } from '../src/experiments/out-west/data/outlaws.ts'

const origin = process.argv[2] ?? 'http://127.0.0.1:4393'
const output = process.argv[3] ?? 'public/experiments/out-west/ui/portraits'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.routeWebSocket(`${new URL(origin).origin.replace(/^http/u, 'ws')}/**`, () => undefined)
  await page.goto(new URL('/404', origin).href, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    const base = '/src/experiments/out-west/'
    const [{ GameApplication }, { DuelActor, duelOpponentUrl }, { NativePortraits }] =
      await Promise.all([
        import(`${base}client/application.ts`),
        import(`${base}duel/native-actor.ts`),
        import(`${base}duel/native-portrait.ts`),
      ])
    document.body.innerHTML = '<div id="portrait-stage"><canvas></canvas></div>'
    const game = await GameApplication.create({
      canvas: document.querySelector('canvas'),
      viewport: document.querySelector('#portrait-stage'),
      tier: 'low',
      pixelRatio: 1,
    })
    const portraits = new NativePortraits(game)
    const render = async (index: number) => {
      const actor = await DuelActor.create(game, duelOpponentUrl(index), 'portrait sitter')
      try {
        actor.face(0)
        actor.play('Idle_Character', 0)
        actor.model.anim?.update(0.18)
        if (actor.model.anim) {
          actor.model.anim.playing = false
        }
        const painted: HTMLCanvasElement | null = await portraits.print(index, actor)
        if (!painted) {
          throw new Error(`Portrait failed for outlaw ${index}`)
        }
        const pixels = painted
          .getContext('2d')
          ?.getImageData(0, 0, painted.width, painted.height).data
        if (
          !pixels ||
          pixels.filter((value, i) => i % 4 === 3 && value > 128).length <
            painted.width * painted.height * 0.12
        ) {
          throw new Error(`Portrait is empty for outlaw ${index}`)
        }
        const image = document.createElement('canvas')
        image.width = 288
        image.height = 243
        const context = image.getContext('2d')
        if (!context) {
          throw new Error('Portrait cannot be exported')
        }
        context.drawImage(painted, 0, 0, image.width, image.height)
        return image.toDataURL('image/webp', 0.86).split(',')[1]
      } finally {
        actor.destroy()
      }
    }
    Reflect.set(globalThis, '__outlawPortrait', render)
  })
  for (const [index, outlaw] of OUTLAWS.entries()) {
    const data: string | undefined = await page.evaluate(
      (id) => Reflect.get(globalThis, '__outlawPortrait')(id),
      index,
    )
    if (!data) {
      throw new Error(`Missing portrait for ${outlaw.name}`)
    }
    await writeFile(join(output, `outlaw-${index}.webp`), Buffer.from(data, 'base64'))
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(`Rendered ${OUTLAWS.length} native outlaw portraits`)
} finally {
  await browser.close()
}
