import fs from 'node:fs'
import path from 'node:path'

/**
 * 檔案內容快取。
 *
 * 一條鏈平均八個節點，而多條鏈常落在同一個檔案——不快取的話 pack 與 trace
 * 會把同一個 SFC 重讀上百次。
 */
const cache = new Map<string, string[] | null>()

function linesOf(repoRoot: string, file: string): string[] | null {
  const abs = path.join(repoRoot, file)
  const hit = cache.get(abs)
  if (hit !== undefined) return hit
  const lines = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split('\n') : null
  cache.set(abs, lines)
  return lines
}

/** 取出 `[start, end]` 行（1-based、含首尾）；檔案不存在時回 null。 */
export function readLines(repoRoot: string, file: string, start: number, end: number): string | null {
  const lines = linesOf(repoRoot, file)
  return lines === null ? null : lines.slice(start - 1, end).join('\n')
}

export function clearSourceCache(): void {
  cache.clear()
}
