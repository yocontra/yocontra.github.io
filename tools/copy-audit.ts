// biome-ignore-all lint/performance/useTopLevelRegex: a one-shot CLI; the patterns read best where they're used
// biome-ignore-all lint/style/useNamedCaptureGroup: the groups are alternations, never read back
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: one rule list per string, read top to bottom
/**
 * Copy audit for out west: pulls the player-facing strings out of the game's source and flags the
 * copy rules they break. Re-runnable; no server needed.
 *
 *   bun tools/copy-audit.ts                 # summary + every violation
 *   bun tools/copy-audit.ts --list          # the whole inventory (file:line, kind, text)
 *   bun tools/copy-audit.ts --json          # machine-readable inventory + violations
 *   bun tools/copy-audit.ts --file=ui/daily # only files whose path contains this
 *   bun tools/copy-audit.ts --strict        # exit 1 when anything is flagged
 *   bun tools/copy-audit.ts --root=/old/tree # audit another checkout (before/after counts)
 *
 * What counts as copy: string and template literals in `src/experiments/out-west` (not the classic
 * game, tests or dev tools) and the out west pages that read as words (two or more words, or one
 * capitalised word handed to the DOM), plus the API's `error`/`message` texts. Templates are read
 * with each `${…}` as `{}`. Strings that are clearly code (class lists, selectors, CSS, URLs,
 * event names) are dropped.
 *
 * Each string is functional (rules, rewards, buttons, errors, HUD) unless it sits in a flavour spot:
 * outlaw dialogue and voice lines (spoken; captions must match the audio, so they are listed but
 * never flagged), or a flavour key such as a Gazette headline or an outlaw's epithet.
 *
 * Rules: at most 12 words per sentence (functional only), no semicolons, no em dashes, no ISO dates,
 * no "+$" inside a sentence, and no idioms from the banned list in functional copy.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT =
  process.argv.find((a) => a.startsWith('--root='))?.slice(7) ?? join(import.meta.dir, '..')
const GAME = 'src/experiments/out-west'
const PAGES = 'src/pages/experiments/out-west'
const API = 'api/src'

const arg = (k: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null
const list = process.argv.includes('--list')
const json = process.argv.includes('--json')
const strict = process.argv.includes('--strict')
const only = arg('file')

/** Not player-facing: dev tools, audits and the debug overlay. */
const SKIP_FILES = [
  /\.test\.ts$/u,
  /audit\.ts$/u,
  /\/ui\/perf\.ts$/u,
  /\.worker\.ts$/u,
  /classic/u,
  // 3D scene code: asset, bone and material names, painted signage
  /out-west\/(scene|engine|ffa\/scene)\//u,
  /d1-fake\.ts$/u,
  /fake-clock\.ts$/u,
]
/** Spoken lines: the captions must match the audio word for word, so they are never rewritten. */
const VOICED_FILES = [/audio\/voices\.ts$/u, /data\/roster-(early|late)\.ts$/u]
/** Keys whose values may carry flavour (titles, headlines, epithets, taunts, dialogue). */
const FLAVOUR_KEYS = new Set([
  'headline',
  'epithet',
  'taunt',
  'taunts',
  'quote',
  'line',
  'lines',
  'bark',
  'barks',
  'intro',
  'outro',
  'boast',
  'lament',
  'nickname',
  'masthead',
  'kicker',
  'flavour',
  'flavor',
])

/** Idioms that confuse a first-time player when they sit in rules, buttons or errors. */
const IDIOMS = [
  'ride out',
  'saddle up',
  'saddling up',
  'sit on your hands',
  'stood a round',
  'line went dead',
  'line dropped',
  'hang up your hat',
  'much obliged',
  'asking around',
  'partner',
  'hit the trail',
  'ride for',
  'rides in',
  'booked to your ledger',
  'mosey',
  'reckon',
  'yonder',
  'hightail',
]

type Kind = 'functional' | 'flavour' | 'voiced'
interface Item {
  file: string
  line: number
  kind: Kind
  text: string
}
interface Violation extends Item {
  rule: string
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name)
    if (statSync(join(ROOT, rel)).isDirectory()) {
      walk(rel, out)
    } else if (/\.(ts|astro)$/u.test(name) && !SKIP_FILES.some((r) => r.test(rel))) {
      out.push(rel)
    }
  }
}

/** Code, not copy: class lists, selectors, CSS, URLs, keys, event and asset names. */
function isCode(s: string): boolean {
  const t = s.trim()
  if (t.length < 2 || !/[A-Za-z]/u.test(t)) {
    return true
  }
  // shader source and inline markup
  if (/gl_|void main|uniform |varying |#include|vec[234]\(|<\/?[a-z]+[ >]/u.test(t)) {
    return true
  }
  if (/^(https?:|\/|\.\/|\.\.\/|#|data:|blob:|wss?:)/u.test(t)) {
    return true
  }
  if (/[{};]\s*$/u.test(t) && /:\s*[^ ]+;/u.test(t)) {
    return true
  }
  if (
    /var\(--|\bpx\b|rgba?\(|translate|cubic-bezier|\d(px|rem|em|vh|vw|ms|s)\b.*\d(px|rem|em)/u.test(
      t,
    )
  ) {
    return /^[a-z-]+\s*:|^[\d.]|var\(|rgba?\(|translate|cubic-bezier/u.test(t)
  }
  // all tokens look like identifiers: "ow-tile ow-tile-daily", "pointerdown", "fog no-bell"
  if (t.split(/\s+/u).every((w) => /^[a-z0-9_:.[\]=-]+$/u.test(w) || /^\{\}$/u.test(w))) {
    return true
  }
  if (/^[A-Z0-9_]+$/u.test(t) || /^[a-z]+[A-Z][A-Za-z0-9]*$/u.test(t)) {
    return true
  }
  // selectors and attribute queries
  if (/^[.#[]?[a-z][\w-]*([.#[:>][\w\-=" \]]*)+$/u.test(t) && !/ [a-z]+ [a-z]+/u.test(t)) {
    return true
  }
  return false
}

function isCopy(s: string, toDom: boolean): boolean {
  if (isCode(s)) {
    return false
  }
  const words = s.trim().split(/\s+/u)
  if (words.length >= 2) {
    return /[A-Za-z]{2}/u.test(s)
  }
  // one word: only when it's handed to the DOM and reads as a word ("Back", "Equip")
  return toDom && /^[A-Z$+…][a-z’']/u.test(s.trim())
}

/** A call that writes text into the page: el(tag, cls, parent, TEXT), button(row, TEXT), … */
const DOM_CALLS = new Set([
  'el',
  'button',
  'status',
  'toast',
  'notice',
  'chip',
  'row',
  'label',
  'setText',
  'statusLine',
  'panelSheet',
  'confirm',
  'say',
  'banner',
])

function enclosingKey(node: ts.Node): string | null {
  let n: ts.Node | undefined = node.parent
  for (let depth = 0; n && depth < 4; depth++, n = n.parent) {
    if (ts.isPropertyAssignment(n) || ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) {
      const name = n.name
      return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null
    }
  }
  return null
}

function codeContext(node: ts.Node): boolean {
  const p = node.parent
  if (!p) {
    return true
  }
  if (
    ts.isImportDeclaration(p) ||
    ts.isExportDeclaration(p) ||
    ts.isLiteralTypeNode(p) ||
    ts.isElementAccessExpression(p) ||
    (ts.isPropertyAssignment(p) && p.name === node) ||
    ts.isCaseClause(p) ||
    (ts.isBinaryExpression(p) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        p.operatorToken.kind,
      ))
  ) {
    return true
  }
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    const callee = p.expression.getText()
    if (
      /console\.|querySelector|addEventListener|setAttribute|classList|getElementById|import|fetch|Error$|\.get$|\.has$|\.startsWith|\.includes|\.endsWith|\.split|\.replace|\.match|\.test|getItem|setItem|removeItem|setProperty|matchMedia|createElement|postMessage|\.send$|dispatch|emit|track|play|cue|sfx|load|asset/u.test(
        callee,
      )
    ) {
      return true
    }
    // el(tag, cls, …): the first two arguments are a tag and a class list
    if (/(^|\.)el$/u.test(callee) && (p.arguments?.indexOf(node as ts.Expression) ?? 0) < 3) {
      return true
    }
  }
  return false
}

function domSink(node: ts.Node): boolean {
  const p = node.parent
  if (!p) {
    return false
  }
  if (ts.isCallExpression(p)) {
    const name = p.expression.getText().split('.').pop() ?? ''
    return DOM_CALLS.has(name)
  }
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return /textContent|innerText|title|placeholder|ariaLabel|label/u.test(p.left.getText())
  }
  if (ts.isPropertyAssignment(p) || ts.isConditionalExpression(p) || ts.isReturnStatement(p)) {
    return true
  }
  return ts.isArrayLiteralExpression(p)
}

function templateText(node: ts.TemplateExpression): string {
  let s = node.head.text
  for (const span of node.templateSpans) {
    const inner = span.expression
    // a nested literal ("${cond ? 'a' : 'b'}") stays a placeholder; it's audited on its own
    s += /(^|\.)day$/u.test(inner.getText()) ? '{day}' : '{}'
    s += span.literal.text
  }
  return s
}

function scanTs(file: string, source: string, out: Item[]): void {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const voiced = VOICED_FILES.some((r) => r.test(file))
  const api = file.startsWith(API)
  const visit = (node: ts.Node): void => {
    let text: string | null = null
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      text = node.text
    } else if (ts.isTemplateExpression(node)) {
      text = templateText(node)
    }
    if (text !== null && !codeContext(node)) {
      const key = enclosingKey(node)
      const apiCopy =
        !api ||
        key === 'error' ||
        key === 'message' ||
        /\b(error|fail|refuse|deny|reject)\(/u.test(node.parent.getText().slice(0, 40))
      if (apiCopy && isCopy(text, domSink(node))) {
        let kind: Kind = 'functional'
        if (voiced) {
          kind = 'voiced'
        } else if (key && FLAVOUR_KEYS.has(key)) {
          kind = 'flavour'
        } else if (file.endsWith('data/gazette.ts') && key !== 'body') {
          kind = 'flavour'
        }
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart())
        out.push({ file, line: line + 1, kind, text })
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

/** .astro pages: the frontmatter as TS, then the text and the title/description/aria attributes. */
function scanAstro(file: string, source: string, out: Item[]): void {
  const fm = /^---\n([\s\S]*?)\n---/u.exec(source)
  if (fm?.[1]) {
    scanTs(file, fm[1], out)
  }
  const body = fm ? source.slice(fm[0].length) : source
  const lineOf = (i: number): number =>
    source.slice(0, i + (fm?.[0].length ?? 0)).split('\n').length
  const attr = /\b(title|description|aria-label|placeholder|alt)="([^"]+)"/gu
  for (const m of body.matchAll(attr)) {
    if (m[2] && isCopy(m[2], true)) {
      out.push({ file, line: lineOf(m.index ?? 0), kind: 'functional', text: m[2] })
    }
  }
  const stripped = body.replace(/<(script|style)[\s\S]*?<\/\1>/gu, (s) => s.replace(/[^\n]/gu, ' '))
  for (const m of stripped.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</gu)) {
    const t = (m[1] ?? '').replace(/\s+/gu, ' ').trim()
    if (t && isCopy(t, true)) {
      out.push({ file, line: lineOf(m.index ?? 0), kind: 'functional', text: t })
    }
  }
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\s·\s|\n/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

function check(item: Item): Violation[] {
  if (item.kind === 'voiced') {
    return []
  }
  const v: Violation[] = []
  const flag = (rule: string): void => {
    v.push({ ...item, rule })
  }
  const t = item.text
  if (item.kind === 'functional') {
    for (const s of sentences(t)) {
      const words = s.split(/\s+/u).filter((w) => /[A-Za-z0-9{]/u.test(w)).length
      if (words > 12) {
        flag(`long sentence (${words} words)`)
        break
      }
    }
    const lower = t.toLowerCase()
    for (const idiom of IDIOMS) {
      if (lower.includes(idiom)) {
        flag(`idiom "${idiom}"`)
      }
    }
  }
  if (t.includes(';')) {
    flag('semicolon')
  }
  if (t.includes('—')) {
    flag('em dash')
  }
  if (/\b\d{4}-\d{2}-\d{2}\b/u.test(t) || /\{day\}/u.test(t)) {
    flag('ISO date')
  }
  if (/\S\s+\+\$|\S\s+\+\{\}(?= and| XP)/u.test(t) || /[a-z] \+\$/u.test(t)) {
    flag('"+$" mid-sentence')
  }
  return v
}

const files: string[] = []
for (const dir of [GAME, PAGES, API]) {
  walk(dir, files)
}
const items: Item[] = []
for (const file of files.filter((f) => !only || f.includes(only))) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  if (file.endsWith('.astro')) {
    scanAstro(file, source, items)
  } else {
    scanTs(file, source, items)
  }
}
const violations = items.flatMap(check)
const byRule = new Map<string, number>()
for (const x of violations) {
  const rule = x.rule.replace(/ \(\d+ words\)|"[^"]+"/u, (m) => (m.startsWith(' (') ? '' : '*'))
  byRule.set(rule, (byRule.get(rule) ?? 0) + 1)
}
const kinds = { functional: 0, flavour: 0, voiced: 0 }
for (const i of items) {
  kinds[i.kind]++
}

if (json) {
  console.log(JSON.stringify({ items, violations, byRule: Object.fromEntries(byRule) }, null, 2))
} else {
  const where = (i: Item): string =>
    `${relative(GAME, i.file).startsWith('..') ? i.file : relative(GAME, i.file)}:${i.line}`
  if (list) {
    for (const i of items) {
      console.log(`${where(i)}\t${i.kind}\t${i.text.replace(/\n/gu, '\\n')}`)
    }
    console.log('')
  }
  for (const x of violations) {
    console.log(`${where(x)}\t${x.rule}\t${x.text.replace(/\n/gu, '\\n')}`)
  }
  console.log(
    `\n${items.length} strings (${kinds.functional} functional, ${kinds.flavour} flavour, ${kinds.voiced} voiced) in ${new Set(items.map((i) => i.file)).size} files`,
  )
  console.log(
    `${violations.length} violations in ${new Set(violations.map((x) => `${x.file}:${x.line}`)).size} strings`,
  )
  for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${rule}`)
  }
}
process.exit(strict && violations.length > 0 ? 1 : 0)
