import path from 'node:path'

/**
 * 把 import specifier 轉成 repo 相對路徑（不含副檔名補全）。
 * 第三方套件回傳 null——它們是邊界，不需要解析。
 */
export function resolveSpecifier(
  aliases: Record<string, string>,
  fromRel: string,
  spec: string
): string | null {
  let rel: string
  if (spec.startsWith('./') || spec.startsWith('../')) {
    rel = path.posix.join(path.posix.dirname(fromRel), spec)
  } else {
    const hit = Object.entries(aliases).find(([prefix]) => spec.startsWith(prefix))
    if (!hit) return null
    rel = hit[1] + spec.slice(hit[0].length)
  }
  rel = path.posix.normalize(rel)
  // 虛擬檔的 `.vue.ts` 要還原成使用者看得到的 `.vue`
  return rel.endsWith('.vue.ts') ? rel.slice(0, -3) : rel
}

/** 補全副檔名。files 是已知存在的檔案集合（repo 相對路徑）。 */
export function resolveToFile(files: ReadonlySet<string>, rel: string): string | null {
  const candidates = [rel, `${rel}.ts`, `${rel}.vue`, `${rel}/index.ts`, `${rel}/index.vue`]
  return candidates.find(c => files.has(c)) ?? null
}
