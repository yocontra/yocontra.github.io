/**
 * Suppression ratchet. Biome suppressions are a debt ledger: they are fine where a rule is wrong
 * for a file, but the total must not grow silently. This prints the current counts by rule and
 * fails when either total goes above the committed baseline.
 *
 * When a cleanup lowers a count, lower `BASELINE` here in the same commit.
 */
import { readFile } from 'node:fs/promises'
import { Glob } from 'bun'

const BASELINE = {
  directives: 467,
  ignoreAll: 351,
} as const

const DIRECTIVE = /biome-ignore(?:-all|-start)?\s+(?:lint|assist)\/(?<rule>[a-z]+\/[A-Za-z0-9]+)/gu

const files = [...new Glob('{src,api,tools,scripts}/**/*.{ts,astro}').scanSync('.')]
const texts = await Promise.all(files.map((file) => readFile(file, 'utf8')))

const byRule = new Map<string, number>()
let directives = 0
let ignoreAll = 0

for (const text of texts) {
  for (const match of text.matchAll(DIRECTIVE)) {
    directives++
    if (match[0].startsWith('biome-ignore-all')) {
      ignoreAll++
    }
    const rule = match.groups?.rule ?? 'unknown'
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1)
  }
}

const top = [...byRule]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([rule, count]) => `  ${String(count).padStart(4)} ${rule}`)
  .join('\n')

console.log(`suppressions: ${directives} directives, ${ignoreAll} whole-file`)
if (top) {
  console.log(`top rules:\n${top}`)
}

const over = [
  directives > BASELINE.directives ? `directives ${directives} > ${BASELINE.directives}` : '',
  ignoreAll > BASELINE.ignoreAll ? `whole-file ${ignoreAll} > ${BASELINE.ignoreAll}` : '',
].filter(Boolean)

if (over.length > 0) {
  console.error(`\nSuppression budget exceeded: ${over.join(', ')}`)
  console.error('Fix the violation or justify it and raise BASELINE in scripts/lint-debt.ts.')
  process.exit(1)
}

if (directives < BASELINE.directives || ignoreAll < BASELINE.ignoreAll) {
  console.log('\nLower BASELINE in scripts/lint-debt.ts to lock in the reduction.')
}
