/** Generates a native face and collar contact sheet for every supported player fit. */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import type { createPlayerModelReview } from './content/player-model-review.ts'

const origin = process.argv[2] ?? 'http://127.0.0.1:4393'
const output = process.argv[3] ?? '/tmp/out-west-player-model-review'
const baseline = process.argv[4]
const prior: ReadonlySet<string> | undefined = baseline
  ? new Set(JSON.parse(await readFile(join(baseline, 'receipt.json'), 'utf8')).shots)
  : undefined
const modulePath = '/tools/content/player-model-review.ts'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
const sections: string[] = []
const shots: string[] = []
const assets = new Set<string>()
await mkdir(output, { recursive: true })

try {
  for (const tier of ['low', 'high'] as const) {
    const page = await browser.newPage({
      viewport: { width: 640, height: 640 },
      serviceWorkers: 'block',
    })
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('response', (response) => {
      const url = new URL(response.url())
      if (response.ok() && url.pathname.includes('/native-v2/') && url.pathname.endsWith('.glb')) {
        assets.add(url.pathname + url.search)
      }
    })
    await page.routeWebSocket(`${origin.replace(/^http/u, 'ws')}/**`, () => undefined)
    await page.route('**/__player_model_review', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><body>',
      }),
    )
    await page.goto(`${origin}/__player_model_review`)
    const { fits, poses } = await page.evaluate(
      async ({ graphicsTier, path }) => {
        const fixture = (await import(/* @vite-ignore */ path)) as {
          createPlayerModelReview: typeof createPlayerModelReview
        }
        const review = await fixture.createPlayerModelReview(graphicsTier)
        Reflect.set(globalThis, '__playerModelReview', review)
        return { fits: review.fits, poses: review.poses }
      },
      { graphicsTier: tier, path: modulePath },
    )
    const rows: string[] = []
    for (const fit of fits) {
      await page.evaluate((id) => Reflect.get(globalThis, '__playerModelReview').load(id), fit)
      const figures: string[] = []
      for (const pose of poses) {
        await page.evaluate(
          (name) => Reflect.get(globalThis, '__playerModelReview').render(name),
          pose,
        )
        const file = `${tier}-${fit}-${pose}.png`
        const png = await page.locator('canvas').screenshot({ path: join(output, file) })
        const { entropy } = await sharp(png).stats()
        if (entropy < 2) {
          throw new Error(`Blank or nearly blank native frame ${file}`)
        }
        const views: [string, string][] = [[file, baseline ? 'Candidate' : 'Capture']]
        if (baseline && prior) {
          if (!prior.has(file)) {
            throw new Error(`Missing matched baseline view ${file}`)
          }
          const source = join(baseline, file)
          await access(source)
          views.unshift([relative(output, source), 'Baseline'])
        }
        const label = pose.replaceAll('-', ' ')
        figures.push(
          `<div><h4>${label}</h4><div class="views">${views
            .map(
              ([view, caption]) =>
                `<figure><a href="${view}"><img src="${view}" loading="lazy" alt="${label} (${caption})"></a><figcaption>${caption}</figcaption></figure>`,
            )
            .join('')}</div></div>`,
        )
        shots.push(file)
      }
      rows.push(`<h3>${fit}</h3><div class="row">${figures.join('')}</div>`)
    }
    sections.push(`<details open><summary>${tier} graphics</summary>${rows.join('\n')}</details>`)
    await page.close()
  }
} finally {
  await browser.close()
}

if (prior && prior.size !== shots.length) {
  throw new Error(`Baseline covers ${prior.size} views and candidate covers ${shots.length}`)
}
if (errors.length > 0) {
  throw new Error(errors.join('\n'))
}
await writeFile(
  `${output}/receipt.json`,
  JSON.stringify(
    { origin, shots, assets: [...assets].sort((a, b) => a.localeCompare(b)) },
    null,
    2,
  ),
)
await writeFile(
  `${output}/index.html`,
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Out West player model review</title>
<style>
body{color:#f0e9da;background:#201c19;font:1rem system-ui;margin:2rem}
summary{cursor:pointer;font-size:1.25rem}.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr));gap:1rem}
.views{display:flex;gap:.5rem}.views figure{flex:1;min-width:0}figure{margin:0}img{display:block;width:100%;height:auto}figcaption{margin:.25rem 0 .8rem}
</style>
<h1>Out West player model review</h1>
<p>Open the full-size views to inspect the skull, jaw, ears, neck, collar, and skin highlights.</p>
${sections.join('\n')}</html>\n`,
)
console.log(`${shots.length} native close-ups written to ${output}/index.html`)
