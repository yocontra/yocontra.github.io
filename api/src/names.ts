/** Display-name rules for the leaderboard. Pure; no Worker APIs. */

const MAX_LENGTH = 16
const ALLOWED = /^[\p{L}\p{N} ._'-]+$/u

// Deliberately short: catches the obvious stuff without false-positive whack-a-mole.
const BLOCKED = [
  'fuck',
  'shit',
  'cunt',
  'nigg',
  'fag',
  'retard',
  'rape',
  'nazi',
  'hitler',
  'kike',
  'spic',
  'chink',
  'whore',
  'slut',
  'cock',
  'dick',
  'pussy',
  'penis',
  'vagina',
  'porn',
]

const LEET = new Map<string, string>([
  ['0', 'o'],
  ['1', 'i'],
  ['3', 'e'],
  ['4', 'a'],
  ['5', 's'],
  ['7', 't'],
  ['8', 'b'],
  ['9', 'g'],
  ['$', 's'],
  ['@', 'a'],
  ['!', 'i'],
])

export type NameResult = { ok: true; name: string; key: string } | { ok: false; error: string }

/** Grouping key: case-, accent- and spacing-insensitive. */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function isBlocked(name: string): boolean {
  const squashed = [...name.toLowerCase()]
    .map((ch) => LEET.get(ch) ?? ch)
    .join('')
    .normalize('NFKD')
    .replace(/[^a-z]/gu, '')
  return BLOCKED.some((word) => squashed.includes(word))
}

export function validateName(raw: unknown): NameResult {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Name is required.' }
  }
  const name = raw.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  if (name.length === 0) {
    return { ok: false, error: 'Name is required.' }
  }
  if ([...name].length > MAX_LENGTH) {
    return { ok: false, error: 'Name must be 16 characters or fewer.' }
  }
  if (!ALLOWED.test(name)) {
    return { ok: false, error: "Use letters, numbers, spaces and . _ ' - only." }
  }
  if (isBlocked(name)) {
    return { ok: false, error: 'Pick a different name.' }
  }
  const key = nameKey(name)
  if (key.length === 0) {
    return { ok: false, error: 'Name needs at least one letter or number.' }
  }
  return { ok: true, name, key }
}
