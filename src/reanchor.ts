import fs from 'node:fs'
import path from 'node:path'
import { applyRenames, type DiffResult } from './diff.js'
import { manualFileFor, type ManualIndex } from './manuals.js'
import { structureSignature } from './signature.js'
import type { ChainNode, FlowChain, TraceResult } from './types.js'

/** 一段可對應的區間：舊檔案的 `[start, end]` 行 → 新檔案的起始行。 */
interface Span {
  oldFile: string
  oldStart: number
  oldEnd: number
  newFile: string
  newStart: number
}

export interface LineMap {
  spans: Span[]
}

function walkPairs(oldNode: ChainNode, newNode: ChainNode, spans: Span[]): void {
  spans.push({
    oldFile: oldNode.loc.file,
    oldStart: oldNode.loc.line,
    oldEnd: oldNode.endLine ?? oldNode.loc.line,
    newFile: newNode.loc.file,
    newStart: newNode.loc.line
  })
  // 副作用的位置未必落在節點主體的行範圍內（例如 store action 的定義在別的檔案），
  // 所以要各自建一筆單行對應
  const n = Math.min(oldNode.effects.length, newNode.effects.length)
  for (let i = 0; i < n; i++) {
    const o = oldNode.effects[i]!.loc
    const t = newNode.effects[i]!.loc
    spans.push({ oldFile: o.file, oldStart: o.line, oldEnd: o.line, newFile: t.file, newStart: t.line })
  }

  const oldLinks = oldNode.asyncLinks ?? []
  const newLinks = newNode.asyncLinks ?? []
  for (let i = 0; i < Math.min(oldLinks.length, newLinks.length); i++) {
    const o = oldLinks[i]!
    const t = newLinks[i]!
    spans.push({ oldFile: o.to.file, oldStart: o.to.line, oldEnd: o.to.line, newFile: t.to.file, newStart: t.to.line })
    if (o.chain && t.chain) walkPairs(o.chain, t.chain, spans)
  }
  for (let i = 0; i < Math.min(oldNode.children.length, newNode.children.length); i++) {
    walkPairs(oldNode.children[i]!, newNode.children[i]!, spans)
  }
}

/**
 * 由「結構相同的兩條鏈」建立位置對照表。
 *
 * 前提是 diff 已把這條流程判為 moved——結構與原始碼都相同，只有位置變了，
 * 所以兩棵樹可以逐節點平行走訪。結構不同的鏈不可以用這個函式：
 * 對錯位置比不改還糟，敘述會指向無關的程式碼。
 */
export function buildLineMap(oldChain: FlowChain, newChain: FlowChain): LineMap {
  const spans: Span[] = [
    {
      oldFile: oldChain.entryLoc.file,
      oldStart: oldChain.entryLoc.line,
      oldEnd: oldChain.entryLoc.line,
      newFile: newChain.entryLoc.file,
      newStart: newChain.entryLoc.line
    }
  ]
  if (oldChain.root && newChain.root) walkPairs(oldChain.root, newChain.root, spans)
  return { spans }
}

export function mergeLineMaps(maps: LineMap[]): LineMap {
  return { spans: maps.flatMap(m => m.spans) }
}

/**
 * 查一個舊位置的新位置。
 *
 * 敘述常引用函式主體中間的某一行（例如「這裡呼叫 API」指向 `:110`，而函式是
 * `100-119`），所以要用**函式內位移**換算，不能只對應起始行。
 * 優先取最小的涵蓋區間——巢狀節點時內層才是正確的參考框架。
 */
function lookup(map: LineMap, file: string, line: number): { file: string; line: number } | null {
  let best: Span | null = null
  for (const s of map.spans) {
    if (s.oldFile !== file || line < s.oldStart || line > s.oldEnd) continue
    if (!best || s.oldEnd - s.oldStart < best.oldEnd - best.oldStart) best = s
  }
  if (!best) return null
  return { file: best.newFile, line: best.newStart + (line - best.oldStart) }
}

export interface ReanchorResult {
  text: string
  /** 改寫成功的引用數 */
  rewritten: number
  /** 對照不到、原樣保留的引用 */
  unmapped: string[]
}

/** 手冊裡的位置引用一律是行內程式碼：`` `src/x.vue:100` `` 或 `` `src/x.vue:100-119` ``。 */
const REFERENCE = /`([\w./-]+\.(?:vue|ts|js|tsx|jsx)):(\d+)(?:-(\d+))?`/g

/**
 * 把敘述裡的 `file:line` 引用改寫到新位置。
 *
 * 這是 moved 分類的 0-token 路徑：結構與行為都沒變，只有位置移了，
 * 沒有理由叫 LLM 重寫一整章。
 *
 * 對照不到的引用**原樣保留並回報**，不猜。留著舊行號會被 verify 抓出來，
 * 那是刻意的——寧可讓它紅燈進待人工佇列，也不要偷偷寫一個看起來合理的錯位置。
 */
export function reanchorManual(markdown: string, map: LineMap): ReanchorResult {
  const unmapped: string[] = []
  let rewritten = 0
  const text = markdown.replace(REFERENCE, (whole, file: string, startRaw: string, endRaw?: string) => {
    const start = lookup(map, file, Number(startRaw))
    if (!start) {
      unmapped.push(`${file}:${startRaw}${endRaw ? `-${endRaw}` : ''}`)
      return whole
    }
    if (endRaw === undefined) {
      rewritten++
      return `\`${start.file}:${start.line}\``
    }
    const end = lookup(map, file, Number(endRaw))
    rewritten++
    // 結束行對照不到時，用起始行的位移推算——同一個函式內位移一致
    const endLine = end && end.file === start.file ? end.line : start.line + (Number(endRaw) - Number(startRaw))
    return `\`${start.file}:${start.line}-${endLine}\``
  })
  return { text, rewritten, unmapped }
}

export interface ReanchorRunSummary {
  /** 實際被改寫的敘述檔（相對 manualsDir） */
  manualsChanged: string[]
  refsRewritten: number
  /** `檔案 → 引用` 形式的未對照清單 */
  unmapped: string[]
  /** moved 且有敘述的流程數 */
  movedWithManual: number
}

/**
 * 對 diff 判為 moved 的所有敘述做機械改寫。`reanchor` 指令與閉環的 `loop` 共用。
 *
 * 一份敘述涵蓋的不只一條鏈：`covers:` 宣告的、以及共用同一個 handler 的其他觸發點
 * （pack 就是依 handler 合併封包的，敘述的觸發表會列出各觸發點的位置）。
 * 只從 moved 的那幾條建表的話，其餘鏈的引用會查不到而被誤報成「對照不到」——
 * 它們其實只是不需要改。所以以檔案為單位收齊所有相關的鏈。
 */
export function reanchorAll(
  baseline: TraceResult,
  current: TraceResult,
  diff: DiffResult,
  index: ManualIndex,
  manualsDir: string,
  renames: Map<string, string>,
  options: { dryRun?: boolean } = {}
): ReanchorRunSummary {
  // baseline 側套用改名後才與現況同一個鍵空間，跟 diff 的配對方式一致
  const oldById = new Map(
    [...baseline.chains, ...baseline.crosscut].map(c => [applyRenames(c.entryId, renames), c])
  )
  const newById = new Map([...current.chains, ...current.crosscut].map(c => [c.entryId, c]))

  const fileOfChain = new Map<string, string>()
  const handlerFile = new Map<string, string>()
  for (const c of newById.values()) {
    const file = manualFileFor(index, c.entryId)
    if (!file) continue
    fileOfChain.set(c.entryId, file)
    if (c.root) handlerFile.set(`${c.root.loc.file}:${c.root.loc.line}`, file)
  }
  for (const c of newById.values()) {
    if (fileOfChain.has(c.entryId) || !c.root) continue
    const file = handlerFile.get(`${c.root.loc.file}:${c.root.loc.line}`)
    if (file) fileOfChain.set(c.entryId, file)
  }

  const needsWork = new Set(diff.work.reanchor.map(id => fileOfChain.get(id)).filter(Boolean) as string[])
  const mapsByFile = new Map<string, LineMap[]>()
  for (const [entryId, file] of fileOfChain) {
    if (!needsWork.has(file)) continue
    const next = newById.get(entryId)
    const prev = oldById.get(entryId)
    // 結構不同的鏈不可以拿來建對照表：對錯位置比不改更糟
    if (!next || !prev || structureSignature(prev) !== structureSignature(next)) continue
    mapsByFile.set(file, [...(mapsByFile.get(file) ?? []), buildLineMap(prev, next)])
  }

  const manualsChanged: string[] = []
  let refsRewritten = 0
  const unmapped: string[] = []
  for (const [file, maps] of mapsByFile) {
    const abs = path.join(manualsDir, file)
    if (!fs.existsSync(abs)) continue
    const before = fs.readFileSync(abs, 'utf8')
    const out = reanchorManual(before, mergeLineMaps(maps))
    refsRewritten += out.rewritten
    for (const u of out.unmapped) unmapped.push(`${file} → ${u}`)
    if (out.text === before) continue
    manualsChanged.push(file)
    if (!options.dryRun) fs.writeFileSync(abs, out.text, 'utf8')
  }

  return { manualsChanged, refsRewritten, unmapped, movedWithManual: diff.work.reanchor.length }
}
