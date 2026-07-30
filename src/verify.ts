import fs from 'node:fs'
import path from 'node:path'

/** 行內程式碼形式的位置引用：`src/api/login.ts:19` 或 `src/x.vue:10-42` */
const REFERENCE = /`([\w./@-]+\.(?:vue|ts|tsx|js|mjs)):(\d+)(?:-(\d+))?`/g

export interface Violation {
  kind: 'MISSING_FILE' | 'LINE_OUT_OF_RANGE' | 'NOT_IN_PACKET' | 'UNCITED_EFFECT' | 'STALE_SOURCE'
  reference: string
  detail: string
}

/** 封包的原始碼區塊：`### \`name\` — \`file:start-end\`` 後面接一個 fenced block */
const PACKET_EXCERPT = /^### `(.+?)` — `([\w./@-]+):(\d+)-(\d+)`\s*$\n+```ts\n([\s\S]*?)\n```/gm

/** frontmatter 的 `covers:` 清單，內容是 entryId（`file:line:tag:event`） */
const COVERS_ENTRY = /^\s*-\s*([\w./@-]+):(\d+):/gm

/**
 * 手冊自己宣告涵蓋的流程觸發位置。
 *
 * 一份敘述用 `covers:` 宣告它涵蓋哪些觸發點時，引用那些觸發點的位置是正當的——
 * 那正是宣告的意思。不認這件事會讓「一份敘述涵蓋多個控件」的正確寫法被誤判成臆測。
 */
function declaredCoverLocations(markdown: string): Set<string> {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown)
  const out = new Set<string>()
  if (!frontmatter) return out
  const block = /(?:^|\n)covers:\s*\n((?:\s*-\s*.+\n?)+)/.exec(frontmatter[1]!)
  if (!block) return out
  for (const m of block[1]!.matchAll(COVERS_ENTRY)) out.add(`${m[1]}:${m[2]}`)
  return out
}

/** 封包裡標成寫入的副作用行，例如 `- [API] POST /x（**寫入**）  \`src/a.ts:19\`` */
const MUTATING_EFFECT = /^- \[[^\]]+\] (.+?)（\*\*寫入\*\*.*?`([\w./@-]+):(\d+)`\s*$/gm

export interface VerifyResult {
  references: number
  violations: Violation[]
}

function collectReferences(markdown: string): { file: string; line: number; raw: string }[] {
  const out: { file: string; line: number; raw: string }[] = []
  for (const m of markdown.matchAll(REFERENCE)) {
    out.push({ file: m[1]!, line: Number(m[2]), raw: m[0] })
  }
  return out
}

/**
 * 驗證生成的手冊沒有幻覺。
 *
 * 兩層檢查，第二層才是真正有效的那層：
 * 1. 檔案存在、行號在範圍內——擋掉憑空捏造的路徑
 * 2. **引用必須出現在封包裡**——擋掉「檔案真的存在、行號也合法，但那一行根本
 *    不在這條流程上」的幻覺。這是純檔案檢查抓不到、卻最容易發生的一種
 */
export function verifyManual(markdown: string, repoRoot: string, packet?: string): VerifyResult {
  const refs = collectReferences(markdown)
  const violations: Violation[] = []

  const packetRefs = packet
    ? new Set(collectReferences(packet).map(r => `${r.file}:${r.line}`))
    : null
  // 封包的原始碼區塊標了 `file:start-end`，手冊引用區間內任一行都算合法
  const packetRanges = packet
    ? [...packet.matchAll(REFERENCE)]
        .filter(m => m[3])
        .map(m => ({ file: m[1]!, start: Number(m[2]), end: Number(m[3]) }))
    : []

  const covered = declaredCoverLocations(markdown)
  const lineCounts = new Map<string, number>()

  for (const ref of refs) {
    const abs = path.join(repoRoot, ref.file)
    if (!fs.existsSync(abs)) {
      violations.push({ kind: 'MISSING_FILE', reference: ref.raw, detail: `檔案不存在：${ref.file}` })
      continue
    }
    let count = lineCounts.get(ref.file)
    if (count == null) {
      count = fs.readFileSync(abs, 'utf8').split('\n').length
      lineCounts.set(ref.file, count)
    }
    if (ref.line < 1 || ref.line > count) {
      violations.push({
        kind: 'LINE_OUT_OF_RANGE',
        reference: ref.raw,
        detail: `${ref.file} 只有 ${count} 行`
      })
      continue
    }
    if (packetRefs) {
      const key = `${ref.file}:${ref.line}`
      const exact = packetRefs.has(key) || covered.has(key)
      const inRange = packetRanges.some(r => r.file === ref.file && ref.line >= r.start && ref.line <= r.end)
      if (!exact && !inRange) {
        violations.push({
          kind: 'NOT_IN_PACKET',
          reference: ref.raw,
          detail: '此位置不在封包提供的範圍內，可能是臆測'
        })
      }
    }
  }

  // 過期檢查：封包裡嵌的原始碼就是分析當時的快照，拿它跟現在的檔案比。
  //
  // 這是最重要的一層。行號合法但內容已位移的引用會通過前兩層檢查，卻在描述
  // 完全不同的程式碼——實測目標 repo 換了分支後，29 個引用只有 1 個被抓到，
  // 其餘 28 個「合法地」指向了無關的行。那比明顯壞掉的引用更危險，因為看起來可信。
  if (packet) {
    for (const m of packet.matchAll(PACKET_EXCERPT)) {
      const [, name, file, startStr, endStr, snapshot] = m
      const abs = path.join(repoRoot, file!)
      if (!fs.existsSync(abs)) continue // 上面已回報 MISSING_FILE
      const current = fs.readFileSync(abs, 'utf8').split('\n').slice(Number(startStr) - 1, Number(endStr)).join('\n')
      if (current !== snapshot) {
        violations.push({
          kind: 'STALE_SOURCE',
          reference: `\`${file}:${startStr}-${endStr}\``,
          detail: `\`${name}\` 的程式碼已與分析當時不同，手冊引用的行號可能已位移`
        })
      }
    }
  }

  // 反向檢查：封包裡的寫入型副作用，手冊必須都提到。
  // 只驗「多寫」不驗「漏寫」的話，一份悄悄漏掉某支寫入 API 的手冊會全綠通過——
  // 而那正是最危險的一種錯誤：讀者會以為那個副作用不存在。
  if (packet) {
    const cited = new Set(refs.map(r => `${r.file}:${r.line}`))
    for (const m of packet.matchAll(MUTATING_EFFECT)) {
      const key = `${m[2]}:${m[3]}`
      if (!cited.has(key)) {
        violations.push({
          kind: 'UNCITED_EFFECT',
          reference: `\`${key}\``,
          detail: `封包標為寫入的副作用「${m[1]!.trim()}」未在手冊中提及`
        })
      }
    }
  }

  return { references: refs.length, violations }
}
