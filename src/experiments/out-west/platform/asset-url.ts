/** New builds miss older service workers' cache-first keys without interrupting their clients. */
const INLINE_URL = /^(?:data|blob):/iu

export function assetUrl(
  url: string,
  revision = import.meta.env?.PUBLIC_OW_ASSET_REVISION ?? '',
): string {
  if (!revision || INLINE_URL.test(url)) {
    return url
  }
  const fragmentAt = url.indexOf('#')
  const fragment = fragmentAt < 0 ? '' : url.slice(fragmentAt)
  const resource = fragmentAt < 0 ? url : url.slice(0, fragmentAt)
  const queryAt = resource.indexOf('?')
  const path = queryAt < 0 ? resource : resource.slice(0, queryAt)
  const query = new URLSearchParams(queryAt < 0 ? '' : resource.slice(queryAt + 1))
  query.set('owrev', revision)
  return `${path}?${query}${fragment}`
}
