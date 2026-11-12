/**
 * A second pair of ears for sound effects: Gemini describes each take and rates it for a use.
 *
 *   bun tools/audio/audition.ts "<what it should be>" <file> [<file>…]
 */
import { listen } from './vendors.ts'

const ask = (want: string) =>
  `You are a strict AAA game sound supervisor. The intended use: ${want}. Listen and reply with JSON only: {"heard": string (what the sound actually is, with timestamps of distinct events in seconds), "events": number, "fits": boolean, "quality": 1-10, "problems": string}`

async function main(): Promise<void> {
  const [want, ...files] = process.argv.slice(2)
  if (!want) {
    throw new Error('usage: audition.ts "<use>" <file>…')
  }
  for (const f of files) {
    const once = () => listen(f, ask(want))
    const r = await once()
      .catch(once)
      .catch((e: unknown) => `error: ${String(e).slice(0, 200)}`)
    console.log(`${f.split('/').pop()}: ${r.replaceAll(/\s+/gu, ' ')}`)
  }
}

if (import.meta.main) {
  await main()
}
