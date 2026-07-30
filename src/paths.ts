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

/**
 * 流程識別碼 → 檔名／URL 安全的 slug。
 *
 * `pack` 與 `site` **必須**共用這一份：封包檔名與手冊檔名若用不同規則，
 * 寫好的敘述會接不回流程頁，而且錯得很安靜——站台只會顯示「尚未撰寫」。
 */
export function slugify(value: string): string {
  return value
    .replace(/[^\w.\-一-鿿]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100)
}
