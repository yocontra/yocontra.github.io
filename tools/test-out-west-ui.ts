/** UI-only Chromium proof: real sheets, CSS and input events; no game, microphone or provider. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { chromium } from 'playwright'

interface Fixture {
  frontier: (signedIn: boolean) => void
  voice: () => void
  state: (state: 'off' | 'connecting' | 'standby' | 'live' | 'error') => void
  ptt: (on: boolean) => void
  snapshot: () => { connects: number; live: number; talks: boolean[]; mutes: boolean[] }
}

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

const root = new URL('../', import.meta.url)
const output = process.env.OUT_WEST_UI_OUTPUT ?? '/tmp/out-west-ui-proof'
const temporary = await mkdtemp(join(tmpdir(), 'out-west-ui-'))
await mkdir(output, { recursive: true })
try {
  const entry = join(temporary, 'fixture.ts')
  await writeFile(
    entry,
    `import {frontierSheet} from ${JSON.stringify(new URL('src/experiments/out-west/ui/frontier-sheet.ts', root).pathname)};
import {VoiceControls} from ${JSON.stringify(new URL('src/experiments/out-west/voice/voice-ui.ts', root).pathname)};
${['tokens', 'out-west', 'controls', 'sheets', 'features'].map((name) => `import ${JSON.stringify(new URL(`src/experiments/out-west/ui/${name}.css`, root).pathname)};`).join('\n')}
let controls,ptt=true;const events={connects:0,live:0,talks:[],mutes:[]};
const clear=()=>{document.querySelectorAll('.ow-sheet-close').forEach(b=>b.click());controls?.dispose();controls=undefined};
globalThis.__ui={
 frontier:signedIn=>{clear();frontierSheet(document.body,signedIn,()=>events.live++)},
 voice:()=>{clear();ptt=true;events.talks=[];events.mutes=[];controls=new VoiceControls({settings:()=>({voiceChat:true,voicePushToTalk:ptt}),connect:()=>events.connects++,talk:on=>events.talks.push(on),mute:on=>events.mutes.push(on)});controls.setState('standby')},
 state:state=>controls.setState(state,state==='error'?'Microphone blocked. Retry voice.':undefined),
 ptt:on=>{ptt=on;controls.refresh()},snapshot:()=>events
};`,
  )
  const build = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    outdir: temporary,
    external: ['/experiments/out-west/*'],
  })
  if (!build.success) {
    throw new Error(build.logs.join('\n'))
  }
  const resources = new Map(build.outputs.map((artifact) => [basename(artifact.path), artifact]))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/') {
        return new Response(
          [
            '<!doctype html>',
            '<meta name="viewport" content="width=device-width,initial-scale=1">',
            '<title>Out West UI proof</title>',
            '<link rel="stylesheet" href="/fixture.css">',
            '<script type="module" src="/fixture.js"></script>',
          ].join('\n'),
          { headers: { 'content-type': 'text/html' } },
        )
      }
      const artifact = resources.get(path.slice(1))
      if (artifact) {
        return new Response(artifact)
      }
      if (path === '/experiments/out-west/frontier/') {
        return new Response('<title>Practice destination</title>', {
          headers: { 'content-type': 'text/html' },
        })
      }
      if (path.startsWith('/experiments/out-west/')) {
        return new Response(Bun.file(new URL(`public${path}`, root)))
      }
      return new Response('Not found', { status: 404 })
    },
  })
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: true })
    try {
      const errors: string[] = []
      for (const mobile of [false, true]) {
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
          isMobile: mobile,
          hasTouch: mobile,
        })
        try {
          const page = await context.newPage()
          page.on('pageerror', (error) => errors.push(error.message))
          await page.route('**/*', (route) => {
            if (new URL(route.request().url()).origin !== server.url.origin) {
              errors.push(`Unexpected external request: ${route.request().url()}`)
              return route.abort()
            }
            return route.continue()
          })
          await page.addInitScript(() => {
            navigator.mediaDevices.getUserMedia = () => {
              throw new Error('UI proof must never capture a microphone')
            }
          })
          // Keep browser callbacks self-contained: Playwright does not capture outer bindings.
          const showFrontier = async (signedIn: boolean) =>
            page.evaluate(
              (value) => (Reflect.get(globalThis, '__ui') as Fixture).frontier(value),
              signedIn,
            )
          const settled = () =>
            page.evaluate(async () => {
              await document.fonts.ready
              await Promise.all(document.getAnimations().map((animation) => animation.finished))
            })
          const prefix = mobile ? 'mobile' : 'desktop'
          await page.goto(server.url.href)
          await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ui')))
          equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), mobile)
          for (const signedIn of [false, true]) {
            await showFrontier(signedIn)
            const choices = page.locator('.ow-sheet-body .ow-hub-row button')
            equal(await choices.allTextContents(), [
              signedIn ? 'Live town' : 'Live town: sign in',
              'Practice town',
            ])
            equal(
              await choices
                .first()
                .evaluate((button) => button.classList.contains('ow-btn-primary')),
              true,
            )
            equal(
              await choices
                .last()
                .evaluate((button) => button.classList.contains('ow-btn-primary')),
              false,
            )
            await settled()
            await page.screenshot({
              path: join(output, `${prefix}-frontier-${signedIn ? 'signed-in' : 'guest'}.png`),
            })
            await choices.first().click()
            equal(await page.locator('.ow-sheet').count(), 0)
          }
          equal(
            await page.evaluate(() => (Reflect.get(globalThis, '__ui') as Fixture).snapshot().live),
            2,
          )
          await showFrontier(true)
          await Promise.all([
            page.waitForURL('**/experiments/out-west/frontier/?server=loopback'),
            page.getByRole('button', { name: 'Practice town', exact: true }).click(),
          ])
          await page.goto(server.url.href)
          await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ui')))
          await page.evaluate(() => (Reflect.get(globalThis, '__ui') as Fixture).voice())
          const talk = page.getByRole('button', { name: 'Hold to talk', exact: true })
          equal(await talk.isVisible(), mobile)
          equal(await page.getByRole('status').isVisible(), true)
          equal(
            await page.getByRole('status').textContent(),
            mobile ? 'Ready · hold TALK to talk' : 'Ready · hold T to talk',
          )
          await page.screenshot({ path: join(output, `${prefix}-voice-standby.png`) })
          await page.keyboard.down('t')
          equal(await page.getByRole('status').textContent(), 'Talking')
          await page.keyboard.up('t')
          equal(
            await page.evaluate(
              () => (Reflect.get(globalThis, '__ui') as Fixture).snapshot().talks,
            ),
            [true, false],
          )
          if (mobile) {
            await talk.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch' })
            equal(await page.getByRole('status').textContent(), 'Talking')
            await page.screenshot({ path: join(output, `${prefix}-voice-talking.png`) })
            await talk.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch' })
            equal(
              await page.evaluate(
                () => (Reflect.get(globalThis, '__ui') as Fixture).snapshot().talks,
              ),
              [true, false, true, false],
            )
          }
          for (const state of ['connecting', 'live'] as const) {
            await page.evaluate(
              (value) => (Reflect.get(globalThis, '__ui') as Fixture).state(value),
              state,
            )
            equal(await talk.isVisible(), mobile)
          }
          await page.evaluate(() => (Reflect.get(globalThis, '__ui') as Fixture).state('error'))
          const retry = page.getByRole('button', { name: 'Retry voice chat', exact: true })
          equal(await retry.isVisible(), true)
          await retry.click()
          equal(
            await page.evaluate(
              () => (Reflect.get(globalThis, '__ui') as Fixture).snapshot().connects,
            ),
            1,
          )
          await page.screenshot({ path: join(output, `${prefix}-voice-retry.png`) })
          await page.evaluate(() => (Reflect.get(globalThis, '__ui') as Fixture).state('off'))
          equal(
            await page.getByRole('button', { name: 'Connect voice chat', exact: true }).isVisible(),
            true,
          )
          await page.evaluate(() => {
            const ui = Reflect.get(globalThis, '__ui') as Fixture
            ui.state('standby')
            ui.ptt(false)
          })
          equal(await page.getByRole('status').textContent(), 'open mic')
          await page.getByRole('button', { name: 'Mute microphone', exact: true }).press('Enter')
          equal(
            await page.evaluate(
              () => (Reflect.get(globalThis, '__ui') as Fixture).snapshot().mutes,
            ),
            [true],
          )
          equal(
            await page.getByRole('button', { name: 'Unmute microphone', exact: true }).isVisible(),
            true,
          )
          equal(await page.getByRole('status').textContent(), 'microphone muted')
          await page.screenshot({ path: join(output, `${prefix}-voice-open-mic-muted.png`) })
        } finally {
          await context.close()
        }
      }
      equal(errors, [])
      const result = { desktop: 'passed', mobile: 'passed', screenshots: output }
      await writeFile(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
      console.log(JSON.stringify(result))
    } finally {
      await browser.close()
    }
  } finally {
    await server.stop(true)
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
