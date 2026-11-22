/** Generates matched native silhouette and anatomy views for every rider fit. */
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import type { createPlayerModelReview } from './content/player-model-review.ts'

const origin = process.argv[2] ?? 'http://127.0.0.1:4393'
const output = process.argv[3] ?? '/tmp/out-west-player-model-review'
const baseline = process.argv[4]
const selection = process.env.OW_REVIEW_FITS?.split(',')
const baselineReceipt = baseline
  ? (JSON.parse(await readFile(join(baseline, 'receipt.json'), 'utf8')) as {
      shots: string[]
      framing?: Record<string, number[]>
    })
  : undefined
const prior = baselineReceipt ? new Set(baselineReceipt.shots) : undefined
const modulePath = '/tools/content/player-model-review.ts'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
const sections: string[] = []
const shots: string[] = []
const framing: Record<string, number[]> = {}
const assets = new Map<string, Promise<string>>()
const bodies: Record<string, { url: string; sha256: string }> = {}
const assetKey = (url: URL) => `${url.pathname}?v=${url.searchParams.get('v') ?? ''}`
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
        const key = assetKey(url)
        if (!assets.has(key)) {
          const digest = response
            .body()
            .then((bytes) => createHash('sha256').update(bytes).digest('hex'))
          void digest.catch(() => undefined)
          assets.set(key, digest)
        }
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
    const selected = selection ? fits.filter((fit) => selection.includes(fit)) : fits
    if (selection && selected.length !== selection.length) {
      throw new Error(`Unknown or duplicate rider ID in ${selection.join(', ')}`)
    }
    for (const fit of selected) {
      const bodyUrl: string = await page.evaluate(
        (id) => Reflect.get(globalThis, '__playerModelReview').load(id),
        fit,
      )
      const expected = new URL(bodyUrl, origin)
      const request = assetKey(expected)
      const sha256 = await assets.get(request)
      const version = expected.searchParams.get('v')
      if (!(sha256 && version && sha256.startsWith(version))) {
        throw new Error(`The native review did not load the expected body for ${fit}: ${bodyUrl}`)
      }
      bodies[fit] = { url: request, sha256 }
      const figures: string[] = []
      for (const pose of poses) {
        const frame: number[] = await page.evaluate(
          (name) => Reflect.get(globalThis, '__playerModelReview').render(name),
          pose,
        )
        const file = `${tier}-${fit}-${pose}.png`
        if (baselineReceipt) {
          const reference = baselineReceipt.framing?.[file]
          if (!reference || reference.length !== frame.length) {
            throw new Error(`Missing camera or head position for ${file}. Recapture the baseline.`)
          }
          if (
            reference.some(
              (value, index) =>
                Math.abs(value - (frame[index] ?? Number.POSITIVE_INFINITY)) > 0.0001,
            )
          ) {
            throw new Error(`Camera or head position drifted for ${file}`)
          }
        }
        framing[file] = frame
        const png = await page.locator('canvas').screenshot({ path: join(output, file) })
        const { entropy } = await sharp(png).stats()
        if (entropy < 0.5) {
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
    await Promise.all(assets.values())
    await page.close()
  }
} finally {
  await browser.close()
}

if (prior && !selection && prior.size !== shots.length) {
  throw new Error(`Baseline covers ${prior.size} views and candidate covers ${shots.length}`)
}
if (errors.length > 0) {
  throw new Error(errors.join('\n'))
}
await writeFile(
  `${output}/receipt.json`,
  JSON.stringify(
    {
      origin,
      shots,
      assets: [...assets.keys()].sort((a, b) => a.localeCompare(b)),
      bodies,
      framing,
    },
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
<p>Inspect the full body and side and rear silhouette in idle, walking, crouch, and aim. Open the close-ups to check the skull, jaw, neck, collar, and skin highlights.</p>
${sections.join('\n')}</html>\n`,
)
console.log(`${shots.length} native rider frames written to ${output}/index.html`)
