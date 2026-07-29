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
