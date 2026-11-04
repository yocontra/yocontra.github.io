/**
 * A second pair of ears: Gemini listens to a take and answers in JSON (`vendors.ts`).
 *
 *   bun tools/audio/listen.ts <file> [<file>…] [--music]
 *
 * `--music` asks about tempo, key, instruments, loopability and anything odd; otherwise it expects
 * a voice take and reports the transcript, delivery and artifacts.
 */
import { listen } from './vendors.ts'

const MUSIC =
  'You are a strict game-music supervisor. Reply with JSON only: {"bpm": number, "key": string, "instruments": string[], "mood": string, "structure": string, "loopsNaturally": boolean, "problems": string, "quality": 1-10, "bellsOrChimes": boolean, "vocals": boolean}'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const music = argv.includes('--music')
  const files = argv.filter((a) => !a.startsWith('--'))
  for (const f of files) {
    const ask = () => listen(f, music ? MUSIC : 'Transcribe this voice take and rate it as JSON.')
    // biome-ignore lint/performance/noAwaitInLoops: one listening pass at a time (rate limits)
    const r = await ask()
      .catch(ask)
      .catch((e: unknown) => `error: ${String(e).slice(0, 200)}`)
    console.log(`${f.split('/').pop()}: ${r.replaceAll(/\s+/gu, ' ')}`)
  }
}

if (import.meta.main) {
  await main()
}
