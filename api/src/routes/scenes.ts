import { SCENE_ASSETS, sceneKey } from '../assets/scene-assets.ts'
import type { Env } from '../env.ts'

const WEAK_ETAG = /^W\//u
const BYTE_RANGE = /^bytes=(?<first>\d*)-(?<last>\d*)$/u
const VERSION = /^[a-f0-9]{16}$/u
const CACHE_CONTROL = 'public, max-age=300'
const IMMUTABLE = 'public, max-age=31536000, immutable'

function failure(status: number, message: string, headers?: Record<string, string>): Response {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}
function unchanged(value: string | null, etag: string): boolean {
  return Boolean(
    value
      ?.split(',')
      .some((entry) => entry.trim().replace(WEAK_ETAG, '') === etag || entry.trim() === '*'),
  )
}

/** One byte range; multipart ranges are deliberately refused rather than buffering a whole scene. */
function byteRange(value: string, size: number): { offset: number; length: number } | null {
  const match = BYTE_RANGE.exec(value)
  if (!(match && (match.groups?.first || match.groups?.last))) {
    return null
  }
  const first = match.groups?.first ? Number(match.groups?.first) : null
  const last = match.groups?.last ? Number(match.groups?.last) : null
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  ) {
    return null
  }
  if (first === null) {
    if (last === null || last <= 0) {
      return null
    }
    const length = Math.min(last, size)
    return { offset: size - length, length }
  }
  if (first >= size || (last !== null && last < first)) {
    return null
  }
  return { offset: first, length: Math.min(last ?? size - 1, size - 1) - first + 1 }
}

async function cachedScene(
  request: Request,
  cacheKey: Request,
  requested: string | undefined,
): Promise<Response | null> {
  if (request.method !== 'GET' || request.headers.has('Range')) {
    return null
  }
  const cached = await caches.default.match(cacheKey).catch(() => undefined)
  if (!cached) {
    return null
  }
  const headers = new Headers(cached.headers)
  headers.set(
    'Cache-Control',
    requested === headers.get('X-Scene-Version') ? IMMUTABLE : CACHE_CONTROL,
  )
  if (unchanged(request.headers.get('If-None-Match'), headers.get('ETag') ?? '')) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(cached.body, { status: cached.status, headers })
}

async function objectResponse(
  request: Request,
  bucket: R2Bucket,
  selection: { key: string; object: R2Object; selected: string; requested: string | undefined },
): Promise<Response> {
  const { key, object, selected, requested } = selection
  const headers = new Headers({
    'Content-Type': 'model/gltf-binary',
    'Content-Length': String(object.size),
    'Accept-Ranges': 'bytes',
    ETag: object.httpEtag,
    'Last-Modified': object.uploaded.toUTCString(),
    'Cache-Control': requested === selected ? IMMUTABLE : CACHE_CONTROL,
    'X-Content-Type-Options': 'nosniff',
    'X-Scene-Version': selected,
  })
  if (unchanged(request.headers.get('If-None-Match'), object.httpEtag)) {
    return new Response(null, { status: 304, headers })
  }
  if (request.method === 'HEAD') {
    return new Response(null, { headers })
  }
  let range: { offset: number; length: number } | undefined
  const rangeHeader = request.headers.get('Range')
  const ifRange = request.headers.get('If-Range')
  const rangeMatches =
    !ifRange ||
    ifRange === object.httpEtag ||
    Math.floor(Date.parse(ifRange) / 1000) >= Math.floor(object.uploaded.getTime() / 1000)
  if (rangeHeader && rangeMatches) {
    range = byteRange(rangeHeader, object.size) ?? undefined
    if (!range) {
      return failure(416, 'Invalid byte range.', { 'Content-Range': `bytes */${object.size}` })
    }
    headers.set(
      'Content-Range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    )
    headers.set('Content-Length', String(range.length))
  }
  const body = await bucket.get(key, {
    onlyIf: { etagMatches: object.etag },
    ...(range ? { range } : {}),
  })
  if (!(body && 'body' in body)) {
    return failure(503, 'Scene changed during read. Retry.')
  }
  return new Response(body.body, { status: range ? 206 : 200, headers })
}

/** Runs before API/auth dispatch and never touches a database, room, microphone or provider. */
export async function sceneRoutes(
  request: Request,
  env: Pick<Env, 'SCENES'>,
  url: URL,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response | null> {
  const asset = SCENE_ASSETS.find((candidate) => candidate.path === url.pathname)
  if (!asset) {
    return SCENE_ASSETS.some((candidate) => url.pathname.startsWith(candidate.path))
      ? failure(404, 'Not found.')
      : null
  }
  if (url.hostname !== 'contra.io' || url.protocol !== 'https:') {
    return failure(404, 'Not found.')
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return failure(405, 'Method not allowed.', { Allow: 'GET, HEAD' })
  }
  const versions = url.searchParams.getAll('v')
  const requested = versions[0]
  if (versions.length > 1 || (requested !== undefined && !VERSION.test(requested))) {
    return failure(400, 'Invalid asset version.')
  }
  if (!env.SCENES) {
    return failure(503, 'Scene storage unavailable.')
  }
  const current = asset.hash.slice(0, 16)
  const version = requested ?? current
  // Build revision and unrelated query values never become object keys or duplicate edge entries.
  const cacheKey = new Request(`https://contra.io${asset.path}?v=${version}`)
  try {
    const cached = await cachedScene(request, cacheKey, requested)
    if (cached) {
      return cached
    }
    let key = sceneKey(asset.path, version)
    let object = await env.SCENES.head(key)
    let selected = version
    if (!object && version !== current) {
      selected = current
      key = sceneKey(asset.path, current)
      object = await env.SCENES.head(key)
    }
    if (!object) {
      return failure(404, 'Scene not found.')
    }
    if (object.size <= 0 || (selected === current && object.size !== asset.bytes)) {
      return failure(502, 'Invalid scene object.')
    }
    const response = await objectResponse(request, env.SCENES, { key, object, selected, requested })
    if (response.status === 200 && request.method === 'GET') {
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()).catch(() => undefined))
    }
    return response
  } catch (err) {
    console.error('scene storage error', err)
    return failure(503, 'Scene storage unavailable.')
  }
}
