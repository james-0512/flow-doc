import fs from 'node:fs'
import path from 'node:path'
import { slugify } from './paths.js'

export interface ManualIndex {
  /** 檔名 slug → 敘述內容（已剝掉 frontmatter） */
  bySlug: Map<string, string>
  /** `covers:` 宣告的 entryId → 敘述內容 */
  byCovers: Map<string, string>
  /** 篇章總覽：`overviews/<域 slug>.md` */
  overviews: Map<string, string>
}

/** 取出 `covers:` 清單。一份敘述可明確宣告它涵蓋哪些流程（篩選、分頁、查詢鈕常是同一件事）。 */
export function parseCovers(markdown: string): string[] {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown)
  if (!frontmatter) return []
  const block = /(?:^|\n)covers:\s*\n((?:\s*-\s*.+\n?)+)/.exec(frontmatter[1]!)
  if (!block) return []
  return [...block[1]!.matchAll(/^\s*-\s*(.+?)\s*$/gm)].map(m => m[1]!)
}

/** frontmatter 只給 covers 解析用，注入頁面時要剝掉，不然會渲染成內文。 */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n*/, '')
}

/**
 * 讀取手冊目錄。
 *
 * `site` 與 `diff` **必須**共用這一份：兩邊若各自認定「哪條流程有敘述」，
 * 閉環會把已經寫過的章節當成沒寫過（或反之），而且錯得很安靜。
 */
export function readManualIndex(dir: string): ManualIndex {
  const index: ManualIndex = { bySlug: new Map(), byCovers: new Map(), overviews: new Map() }
  if (!fs.existsSync(dir)) return index

  const overviewDir = path.join(dir, 'overviews')
  if (fs.existsSync(overviewDir)) {
    for (const f of fs.readdirSync(overviewDir)) {
      if (!f.endsWith('.md')) continue
      index.overviews.set(f.replace(/\.md$/, ''), fs.readFileSync(path.join(overviewDir, f), 'utf8'))
    }
  }

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    const md = fs.readFileSync(path.join(dir, f), 'utf8')
    const body = stripFrontmatter(md)
    index.bySlug.set(f.replace(/\.md$/, ''), body)
    for (const id of parseCovers(md)) index.byCovers.set(id, body)
  }
  return index
}

/** 這條流程有沒有敘述（檔名直接對應，或被別份敘述的 `covers:` 涵蓋）。 */
export function hasManual(index: ManualIndex, entryId: string): boolean {
  return index.bySlug.has(slugify(entryId)) || index.byCovers.has(entryId)
}
