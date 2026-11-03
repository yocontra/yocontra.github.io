/**
 * Build-time GitHub / npm stats. Every call degrades to a fallback so offline builds never fail.
 */
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'contra.io-build',
    }
    if (token && url.startsWith('https://api.github.com')) {
      headers.Authorization = `Bearer ${token}`
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
      return null
    }
    return (await res.json()) as T
  } catch {
    return null
  }
}

interface RepoResponse {
  stargazers_count: number
}

const memo = new Map<string, Promise<number | null>>()

/** `owner/repo`, or `org:<name>` to sum stars across an org's public repos. */
export function getStars(source: string): Promise<number | null> {
  const cached = memo.get(source)
  if (cached) {
    return cached
  }
  const promise = source.startsWith('org:')
    ? getJson<RepoResponse[]>(
        `https://api.github.com/orgs/${source.slice(4)}/repos?per_page=100&type=public`,
      ).then((repos) => repos?.reduce((sum, repo) => sum + repo.stargazers_count, 0) ?? null)
    : getJson<RepoResponse>(`https://api.github.com/repos/${source}`).then(
        (repo) => repo?.stargazers_count ?? null,
      )
  memo.set(source, promise)
  return promise
}

export async function getWeeklyDownloads(pkg: string): Promise<number | null> {
  const data = await getJson<{ downloads: number }>(
    `https://api.npmjs.org/downloads/point/last-week/${pkg}`,
  )
  return data?.downloads ?? null
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
export const formatCompact = (n: number): string => compact.format(n)
