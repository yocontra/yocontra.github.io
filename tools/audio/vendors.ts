// biome-ignore-all lint/style/useNamedCaptureGroup: one-number capture from a MIME type
/**
 * The generators behind the out west voice and music, reached through the sibling Apparish repo's
 * own vendor doors so no key is ever read, printed or copied here:
 *
 * - ElevenLabs text-to-speech (`eleven_v3`, premade voices; the free plan has no voice design or
 *   library voices) goes through Apparish's `cardSpendFetch`, which injects the key and refuses
 *   to run unless `APPARISH_CARD_SPEND` names why the spend is approved. Run with
 *   `--env-file=/Users/contra/Projects/apparish/server/.env` so it finds the key.
 * - Google (Vertex AI, on the project's cloud credit): Gemini TTS, Lyria 2 instrumental music
 *   (30 s, 48 kHz stereo) and a Gemini listening pass that transcribes a take and rates it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const CARD_SPEND = '/Users/contra/Projects/apparish/server/src/lib/card-spend.ts'
const GOOGLE = '/Users/contra/Projects/apparish/scripts/lib/google-genai.ts'
const FFMPEG = '/opt/homebrew/bin/ffmpeg'
const RATE = /rate=(\d+)/u
const HOST = /^https:\/\/[^/]+/u
const LOCATION = /locations\/[^/]+/u

type CardFetch = (vendor: 'elevenlabs', path: string, init?: RequestInit) => Promise<Response>
interface InlinePart {
  inlineData?: { mimeType?: string; data?: string }
}
interface GenAi {
  models: {
    generateContent: (req: unknown) => Promise<{
      text?: string
      candidates?: { content?: { parts?: InlinePart[] } }[]
    }>
  }
}
interface GoogleLib {
  createGoogleAIClient: () => GenAi
  geminiRestTarget: (model: string) => Promise<{ url: string; headers: Record<string, string> }>
}

const google = async (): Promise<GoogleLib> => (await import(GOOGLE)) as GoogleLib
const cardFetch = async (): Promise<CardFetch> =>
  ((await import(CARD_SPEND)) as { cardSpendFetch: CardFetch }).cardSpendFetch

function write(out: string, bytes: ArrayBuffer | Uint8Array): void {
  // synchronous: a take must be whole on disk before the next step reads it
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, new Uint8Array(bytes))
}

export interface ElevenOpts {
  /** 0 (most expressive) … 1 (most stable); v3 takes 0, 0.5 or 1. */
  stability?: number
  seed?: number
}

/** ElevenLabs TTS to an mp3 (44.1 kHz, 128 kbps). Throws with the API's message on failure. */
export async function elevenTts(
  out: string,
  voiceId: string,
  text: string,
  o: ElevenOpts = {},
): Promise<void> {
  const f = await cardFetch()
  const r = await f('elevenlabs', `/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_v3',
      voice_settings: { stability: o.stability ?? 0.5, similarity_boost: 0.75 },
      ...(o.seed === undefined ? {} : { seed: o.seed }),
    }),
  })
  if (!r.ok) {
    throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`)
  }
  write(out, await r.arrayBuffer())
}

/** Gemini TTS (a prebuilt voice steered by performance notes) to a 24 kHz mono wav. */
export async function geminiTts(
  out: string,
  voice: string,
  text: string,
  direction: string,
): Promise<void> {
  const ai = (await google()).createGoogleAIClient()
  const res = await ai.models.generateContent({
    model: 'gemini-3.1-flash-tts-preview',
    contents: `Synthesize speech. Speak only the transcript, verbatim. Do not read the performance notes aloud.\n\nPERFORMANCE NOTES:\n${direction}\n\nTRANSCRIPT:\n${text}`,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  })
  const part = res.candidates?.[0]?.content?.parts?.find((p) =>
    p.inlineData?.mimeType?.startsWith('audio/'),
  )
  const data = part?.inlineData?.data
  if (!data) {
    throw new Error('Gemini TTS returned no audio')
  }
  const rate = RATE.exec(part.inlineData?.mimeType ?? '')?.[1] ?? '24000'
  mkdirSync(dirname(out), { recursive: true })
  const w = Bun.spawnSync(
    [
      FFMPEG,
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      's16le',
      '-ar',
      rate,
      '-ac',
      '1',
      '-i',
      'pipe:0',
      out,
    ],
    { stdin: Buffer.from(data, 'base64'), stdout: 'pipe', stderr: 'pipe' },
  )
  if (w.exitCode !== 0) {
    throw new Error(w.stderr.toString())
  }
}

/** Lyria 2 on Vertex AI: about 30 s of instrumental music, 48 kHz stereo wav. */
export async function lyria(
  out: string,
  prompt: string,
  negative?: string,
  seed?: number,
): Promise<void> {
  const t = await (await google()).geminiRestTarget('lyria-002')
  const url = t.url
    .replace(HOST, 'https://us-central1-aiplatform.googleapis.com')
    .replace(LOCATION, 'locations/us-central1')
    .replace(':generateContent', ':predict')
  const instance: Record<string, unknown> = { prompt }
  if (negative) {
    instance.negative_prompt = negative
  }
  if (seed !== undefined) {
    instance.seed = seed
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: t.headers,
    body: JSON.stringify({ instances: [instance], parameters: {} }),
  })
  const j = (await r.json()) as { predictions?: { bytesBase64Encoded?: string }[] }
  const b64 = j.predictions?.[0]?.bytesBase64Encoded
  if (!(r.ok && b64)) {
    throw new Error(`Lyria ${r.status}: ${JSON.stringify(j).slice(0, 300)}`)
  }
  write(out, Buffer.from(b64, 'base64'))
}

const MIME: Record<string, string> = { wav: 'audio/wav', m4a: 'audio/mp4', mp3: 'audio/mpeg' }

/** Gemini listens to a file and answers `prompt` (JSON when `json`). */
export async function listen(file: string, prompt: string, json = true): Promise<string> {
  const ai = (await google()).createGoogleAIClient()
  const data = Buffer.from(await Bun.file(file).arrayBuffer()).toString('base64')
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: MIME[file.split('.').pop() ?? ''] ?? 'audio/mpeg', data } },
          { text: prompt },
        ],
      },
    ],
    config: json ? { responseMimeType: 'application/json' } : {},
  })
  return res.text ?? ''
}
