import { createHash } from 'node:crypto'
import path from 'node:path'

/** 轉成相對 repo 根的 POSIX 路徑。整個系統對外只用這種路徑，避免 Windows 分隔符外洩到 JSON。 */
export function toRel(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join('/')
}

export function toAbs(repoRoot: string, relPath: string): string {
  return path.resolve(repoRoot, relPath)
}

/** 前綴比對。prefix 以 `/` 結尾代表目錄，否則需完全相等（單檔覆寫用）。 */
export function matchesPrefix(rel: string, prefix: string): boolean {
  return prefix.endsWith('/') ? rel.startsWith(prefix) : rel === prefix
}

export function matchesAny(rel: string, prefixes: readonly string[]): boolean {
  return prefixes.some(p => matchesPrefix(rel, p))
}

/** 檔名長度上限。Windows 單一路徑元件上限 255，這裡留足空間給目錄前綴與副檔名。 */
const MAX_SLUG = 100

/**
 * 流程識別碼 → 檔名／URL 安全的 slug。
 *
 * `pack` 與 `site` **必須**共用這一份：封包檔名與手冊檔名若用不同規則，
 * 寫好的敘述會接不回流程頁，而且錯得很安靜——站台只會顯示「尚未撰寫」。
 *
 * 超長時補上完整識別碼的短雜湊，而不是直接截斷。純截斷會讓前 100 字元相同的
 * 識別碼共用同一個檔名——實測 mPHR 有 114 組這種碰撞（深層目錄下同標籤同事件、
 * 只有 handler 名尾巴不同的按鈕），後寫入的敘述會覆蓋前一份，**而且完全無聲**。
 * 雜湊取自語意識別碼本身，所以只要流程身份不變，檔名就不變。
 */
export function slugify(value: string): string {
  const clean = value
    .replace(/[^\w.\-一-鿿]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (clean.length <= MAX_SLUG) return clean
  const hash = createHash('sha1').update(value).digest('hex').slice(0, 8)
  return `${clean.slice(0, MAX_SLUG - hash.length - 1)}-${hash}`
}
