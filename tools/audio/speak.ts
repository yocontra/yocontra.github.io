// biome-ignore-all lint/correctness/noUndeclaredVariables: Bun is a global in this Bun script
/**
 * Generate and review the voice takes behind `voices.ts`.
 *
 *   APPARISH_CARD_SPEND="<why>" bun --env-file=/Users/contra/Projects/apparish/server/.env \
 *     tools/audio/speak.ts <cast id…|all|player> [--only stall,death] [--take 2] [--force] [--qa]
 *   bun tools/audio/speak.ts <cast id…|all|player> --rank [--force]
 *   bun tools/audio/speak.ts --pick
 *
 * - Takes land in `raw/voice/<cast>/<key>.t<take>.mp3` (`.wav` from Gemini). An existing take is
 *   skipped unless `--force`, so a rerun never pays twice.
 * - `--qa` has Gemini listen to every take without a review yet and writes `<take>.qa.json`: the
 *   transcript, whether the words match the caption (or, for a grunt, that it has none), the
 *   delivery, artifacts, and a 1–10 fit to the character.
 * - `--rank` plays every take of a line to Gemini back to back (shuffled, blind) and asks a
 *   demanding voice director to pick one: `<key>.rank.json`. Independent 1–10 scores saturate (a
 *   listening model calls most takes a 9); a side-by-side choice does not.
 * - `--pick` chooses each line's take (the ranked winner when its words match, else the best
 *   reviewed take) and writes `voice-picks.ts` for the build.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { concat, encode, load, silence } from './dsp.ts'
import { elevenTts, geminiTts, listen } from './vendors.ts'
import { CAST, type Cast, castById, effortLines, type Line, linesOf, PLAYER } from './voices.ts'

const RAW = resolve(import.meta.dir, 'raw/voice')
const PICKS = resolve(import.meta.dir, 'voice-picks.ts')
const CONCURRENCY = Number(process.env.OW_VOICE_JOBS ?? '2')

export interface Review {
  transcript: string
  wordsMatch: boolean
  nonVerbal: boolean
  delivery: string
  artifacts: string
  fitsCharacter: number
}

export const takePath = (c: Cast, key: string, take: number): string =>
  join(RAW, c.id, `${key}.t${take}.${c.engine === 'el' ? 'mp3' : 'wav'}`)

const linesFor = (c: Cast): Line[] => (c.id === PLAYER.id ? effortLines() : linesOf(c))

async function make(c: Cast, l: Line, take: number, force: boolean): Promise<string> {
  const out = takePath(c, l.key, take)
  if (existsSync(out) && !force) {
    return 'skip'
  }
  if (c.engine === 'el') {
    await elevenTts(out, c.base, l.say, { stability: 0 })
  } else {
    await geminiTts(out, c.base, l.say, c.style)
  }
  return 'ok'
}

function reviewPrompt(c: Cast, l: Line): string {
  const want = l.text
    ? `The take must say exactly: "${l.text}" (an ellipsis is a pause; "*hic*" is a hiccup; "…" alone is a cold breath).`
    : `The take must be a non-verbal sound with no spoken words: ${l.say.replaceAll(/\[|\]/gu, '')}.`
  return `You are a strict voice director for a western video game. ${want} Character: ${c.voice}. Reply with JSON only: {"transcript": string, "wordsMatch": boolean (true when the words are exactly right, or when a non-verbal take has no words), "nonVerbal": boolean (true when there are no words), "delivery": string, "artifacts": string (clicks, distortion, an audio tag read aloud, extra words, silence), "fitsCharacter": 1-10}`
}

async function review(c: Cast, l: Line, take: number): Promise<string> {
  const f = takePath(c, l.key, take)
  const qa = `${f}.qa.json`
  if (!existsSync(f) || existsSync(qa)) {
    return 'skip'
  }
  const ask = () => listen(f, reviewPrompt(c, l))
  const r = await ask().catch(ask)
  JSON.parse(r)
  writeFileSync(qa, r)
  const j = JSON.parse(r) as Review
  return `${j.wordsMatch ? 'match' : 'MISMATCH'} fit ${j.fitsCharacter} "${j.transcript}"`
}

export interface Rank {
  /** Take numbers in the order they were played. */
  order: number[]
  takes: { n: number; transcript: string; wordsMatch: boolean; performance: number; note: string }[]
  /** The winning take number (not its position). */
  best: number
  why: string
}

const rankPath = (c: Cast, key: string) => join(RAW, c.id, `${key}.rank.json`)

/** Every take of a line, back to back and shuffled, for Gemini to choose between. */
async function rank(c: Cast, l: Line, force: boolean): Promise<string> {
  const out = rankPath(c, l.key)
  const takes: number[] = []
  for (let t = 1; t <= 9; t++) {
    if (existsSync(takePath(c, l.key, t))) {
      takes.push(t)
    }
  }
  if (takes.length < 2 || (existsSync(out) && !force)) {
    return 'skip'
  }
  const order = takes
    .map((t) => ({ t, k: Math.random() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.t)
  const mix = join(RAW, c.id, `${l.key}.rank.m4a`)
  encode(
    concat(
      ...order.flatMap((t) => [
        load(takePath(c, l.key, t), 1, 'loudnorm=I=-18:TP=-2'),
        silence(1.5, 1),
      ]),
    ),
    mix,
    96,
  )
  const want = l.text
    ? `the line "${l.text}" (an ellipsis is a pause; "*hic*" is a hiccup; "…" alone is a cold breath)`
    : `a non-verbal sound with no words: ${l.say.replaceAll(/\[|\]/gu, '')}`
  const ask = () =>
    listen(
      mix,
      `This recording holds ${order.length} alternative takes of ${want}, for a gritty western video game, in order, separated by 1.5 seconds of silence. Character: ${c.voice}. Act as a demanding AAA voice director: the words must be exactly right (a non-verbal take must have no words), then the performance must be the most real, gritty and in character. Reply JSON only: {"takes": [{"n": 1-based position, "transcript": string, "wordsMatch": boolean, "performance": 1-10, "note": string}], "best": 1-based position, "why": string}`,
    )
  const r = JSON.parse(await ask().catch(ask)) as Omit<Rank, 'order'>
  const best = order[r.best - 1] ?? 0
  const ranked: Rank = {
    order,
    takes: r.takes.map((x) => ({ ...x, n: order[x.n - 1] ?? 0 })),
    best,
    why: r.why,
  }
  writeFileSync(out, `${JSON.stringify(ranked, null, 2)}\n`)
  const w = ranked.takes.find((x) => x.n === best)
  return `best t${best} (${w?.wordsMatch ? 'match' : 'MISMATCH'}) "${w?.transcript ?? ''}" ${r.why.slice(0, 120)}`
}

function readRank(c: Cast, key: string): Rank | null {
  try {
    return JSON.parse(readFileSync(rankPath(c, key), 'utf8')) as Rank
  } catch {
    return null
  }
}

function readReview(f: string): Review | null {
  try {
    return JSON.parse(readFileSync(`${f}.qa.json`, 'utf8')) as Review
  } catch {
    return null
  }
}

/** A take's score: right words first, then the fit. */
const score = (r: Review | null) => (r ? (r.wordsMatch ? 100 : 0) + r.fitsCharacter : -1)

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pass over speakers, lines and takes
function pick(): void {
  const rows: string[] = []
  for (const c of [...CAST, PLAYER]) {
    const dir = join(RAW, c.id)
    const files = existsSync(dir) ? readdirSync(dir) : []
    for (const l of linesFor(c)) {
      const ranked = readRank(c, l.key)
      if (ranked) {
        // the director's choice when its words are right, else the best performance that is
        const ok = ranked.takes
          .filter((x) => x.wordsMatch && existsSync(takePath(c, l.key, x.n)))
          .sort(
            (a, b) =>
              (b.n === ranked.best ? 1 : 0) - (a.n === ranked.best ? 1 : 0) ||
              b.performance - a.performance,
          )
        const t = ok[0]?.n ?? ranked.best
        if (!ok[0]) {
          console.log(`weak: ${c.id}/${l.key} (no take with the right words; shipping t${t})`)
        }
        rows.push(`  '${c.id}/${l.key}': ${t},`)
        continue
      }
      let best = 0
      let bestScore = -2
      for (let t = 1; t <= 9; t++) {
        const f = takePath(c, l.key, t)
        if (files.includes(f.split('/').pop() ?? '')) {
          const s = score(readReview(f))
          if (s > bestScore) {
            best = t
            bestScore = s
          }
        }
      }
      if (best > 0) {
        rows.push(`  '${c.id}/${l.key}': ${best},`)
        if (bestScore < 100) {
          console.log(`weak: ${c.id}/${l.key} (best take ${best}, score ${bestScore})`)
        }
      } else {
        console.log(`missing: ${c.id}/${l.key}`)
      }
    }
  }
  writeFileSync(
    PICKS,
    `/**\n * The take each voice line ships, chosen by \`speak.ts --pick\` from the Gemini reviews (right words\n * first, then the fit to the character). Edit by hand to overrule a pick.\n */\nexport const VOICE_PICKS: Readonly<Record<string, number>> = {\n${rows.join('\n')}\n}\n`,
  )
  console.log(`wrote ${rows.length} picks`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--pick')) {
    pick()
    return
  }
  const ranking = argv.includes('--rank')
  const flag = (n: string) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const take = Number(flag('--take') ?? '1')
  const only = flag('--only')?.split(',')
  const force = argv.includes('--force')
  const qa = argv.includes('--qa')
  const ids = argv.filter(
    (a, i) => !(a.startsWith('--') || ['--take', '--only'].includes(argv[i - 1] ?? '')),
  )
  const casts = ids.includes('all')
    ? CAST
    : ids.map((id) => castById(id)).filter((c) => c !== undefined)
  const jobs: { c: Cast; l: Line }[] = []
  for (const c of casts) {
    for (const l of linesFor(c)) {
      if (!only || only.some((o) => l.key.startsWith(o))) {
        jobs.push({ c, l })
      }
    }
  }
  let failed = 0
  const worker = async (): Promise<void> => {
    for (let j = jobs.shift(); j !== undefined; j = jobs.shift()) {
      const tag = `${j.c.id}/${j.l.key} t${take}`
      try {
        if (ranking) {
          // biome-ignore lint/performance/noAwaitInLoops: each worker runs its share one at a time on purpose (rate limits)
          const r = await rank(j.c, j.l, force)
          console.log(`${j.c.id}/${j.l.key} rank: ${r}`)
          continue
        }
        const made = await make(j.c, j.l, take, force)
        const rev = qa ? await review(j.c, j.l, take) : ''
        console.log(`${tag}: ${made}${rev ? ` | ${rev}` : ''}`)
      } catch (e) {
        failed++
        console.log(`FAIL ${tag}: ${String(e).slice(0, 240)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  if (failed > 0) {
    process.exit(1)
  }
}

if (import.meta.main) {
  await main()
}
