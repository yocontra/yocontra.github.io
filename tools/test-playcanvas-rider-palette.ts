import { chromium } from 'playwright'

const build = await Bun.build({
  entrypoints: [new URL('./content/frontier-palette-probe.ts', import.meta.url).pathname],
  target: 'browser',
})
const script = build.outputs[0]
if (!(script && build.success)) {
  throw new Error(build.logs.map(String).join('\n'))
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: ({ url }) =>
    new URL(url).pathname === '/probe.js'
      ? new Response(script, { headers: { 'Content-Type': 'text/javascript' } })
      : new Response('<!doctype html><title>Frontier native palette</title>', {
          headers: { 'Content-Type': 'text/html' },
        }),
})
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  await page.goto(server.url.href)
  const result = await page.evaluate(async () => {
    const url = '/probe.js'
    const { probePalette } = await import(url)
    return probePalette()
  })
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
  await server.stop(true)
}
