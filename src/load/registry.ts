import path from 'node:path'

/** `    UtilTable: typeof import('./components/Utils/UtilTable.vue')['default']` */
const GLOBAL_COMPONENT = /^\s*([A-Za-z][\w]*)\s*:\s*typeof import\(['"]([^'"]+)['"]\)/

/**
 * 解析 unplugin-vue-components 產生的 `components.d.ts`。
 *
 * 這個檔是 Vue 專案裡少數的意外之喜：自動註冊的元件在 template 裡出現時
 * 沒有 import 語句，靠 import 反查會整片漏掉；而這個檔剛好就是完整的
 * 「標籤名 → 檔案路徑」對照表。
 *
 * @returns 元件名（PascalCase）→ repo 相對路徑
 */
export function parseGlobalComponents(source: string, dtsRel: string): Map<string, string> {
  const dir = path.posix.dirname(dtsRel)
  const map = new Map<string, string>()
  for (const line of source.split('\n')) {
    const m = GLOBAL_COMPONENT.exec(line)
    if (!m) continue
    const [, name, spec] = m
    map.set(name!, path.posix.normalize(path.posix.join(dir, spec!)))
  }
  return map
}

/** `util-table` / `utilTable` / `UtilTable` 一律正規化成 PascalCase 以供查表。 */
export function normalizeTag(tag: string): string {
  const camel = tag.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}
