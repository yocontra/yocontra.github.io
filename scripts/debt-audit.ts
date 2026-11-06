/**
 * Drift ratchet for the three debt classes that TypeScript cannot catch:
 *
 * 1. the same named numeric constant declared in both `src/` and `api/` with the same value
 *    (client/server tuning that must be kept in step by hand);
 * 2. scene classification by `object.name` (`o.name === 'windows'`) instead of typed metadata;
 * 3. `as unknown as` in shipping source, which steps around the type system.
 *
 * Fails when a count exceeds the committed baseline. Lower the baseline in the same commit as a
 * cleanup; raise it only with a reason.
 */
import { Glob } from 'bun'

const BASELINE = {
  crossBoundaryConstants: 3,
  nameClassification: 17,
  doubleAssertions: 14,
} as const

async function texts(pattern: string): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = []
  for (const file of new Glob(pattern).scanSync('.')) {
    if (file.includes('.test.') || file.includes('/testing/')) {
      continue
    }
    out.push({ file, text: await Bun.file(file).text() })
  }
  return out
}

// --- 1. Constants declared on both sides of the client/server boundary -------------------------

const declarations = new Map<string, { value: string; source: 'src' | 'api' }[]>()
for (const { file, text } of await texts('{src,api}/**/*.ts')) {
  const side = file.startsWith('src/') ? 'src' : 'api'
  for (const match of text.matchAll(
    /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{1,40})\s*=\s*(-?\d+(?:\.\d+)?)\s*$/gmu,
  )) {
    const name = match[1]
    const value = match[2]
    if (!name || !value) {
      continue
    }
    const list = declarations.get(name) ?? []
    list.push({ value, source: side })
    declarations.set(name, list)
  }
}

const crossBoundary: string[] = []
for (const [name, list] of declarations) {
  const values = new Set(list.map((item) => item.value))
  if (values.size !== 1) {
    continue
  }
  if (list.some((item) => item.source === 'src') && list.some((item) => item.source === 'api')) {
    crossBoundary.push(`${name} = ${[...values][0]}`)
  }
}

// --- 2. Scene classification by object name ----------------------------------------------------

const nameHits: string[] = []
for (const { file, text } of await texts('src/experiments/out-west/{scene,ffa,duel}/**/*.ts')) {
  text.split('\n').forEach((line, index) => {
    if (/\.name\s*(?:===|!==)/u.test(line)) {
      nameHits.push(`${file}:${index + 1}`)
    }
  })
}

// --- 3. Double assertions in shipping source ---------------------------------------------------

const doubleCasts: string[] = []
for (const { file, text } of await texts('src/**/*.ts')) {
  text.split('\n').forEach((line, index) => {
    if (line.includes('as unknown as')) {
      doubleCasts.push(`${file}:${index + 1}`)
    }
  })
}

const checks = [
  ['crossBoundaryConstants', crossBoundary, BASELINE.crossBoundaryConstants],
  ['nameClassification', nameHits, BASELINE.nameClassification],
  ['doubleAssertions', doubleCasts, BASELINE.doubleAssertions],
] as const

let failed = false
for (const [name, hits, baseline] of checks) {
  console.log(`${name}: ${hits.length} (baseline ${baseline})`)
  if (hits.length > 0) {
    for (const hit of hits.slice(0, 12)) {
      console.log(`  ${hit}`)
    }
    if (hits.length > 12) {
      console.log(`  … and ${hits.length - 12} more`)
    }
  }
  if (hits.length > baseline) {
    failed = true
    console.error(`  ^ ${name} grew past its baseline`)
  } else if (hits.length < baseline) {
    console.log(`  lower BASELINE.${name} to ${hits.length} in scripts/debt-audit.ts`)
  }
}

if (failed) {
  process.exit(1)
}
