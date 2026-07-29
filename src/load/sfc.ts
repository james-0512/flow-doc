import { parse } from '@vue/compiler-sfc'
import type { SFCDescriptor, SFCScriptBlock } from '@vue/compiler-sfc'

export interface ParsedSfc {
  /** repo 相對路徑（原始 `.vue`） */
  rel: string
  descriptor: SFCDescriptor
  /**
   * 行號與原始 `.vue` **完全對齊**的虛擬 TS；沒有 script 區塊則為 null。
   *
   * 對齊方式是用空行把 script 內容墊到它在 `.vue` 裡的原始行號，
   * 於是「虛擬檔第 N 行 === 原始檔第 N 行」，整個 sourcemap 問題直接消失。
   * plan.md 要求每一步都能附上可驗證的 file:line，這是最便宜的達成方式。
   */
  virtualTs: string | null
  lang: 'ts' | 'js'
  errors: string[]
}

/** import / export 語句才做 `.vue` → `.vue.ts` 改寫，避免誤傷一般字串。 */
const IMPORT_LINE = /^\s*(?:import|export)\b/
const VUE_SPECIFIER = /(['"])([^'"]+)\.vue\1/g

/**
 * 把 import 指向虛擬檔。
 *
 * 不改寫的話，`import X from '@/components/X.vue'` 會被 `shims-vue.d.ts` 裡的
 * `declare module '*.vue'` 攔截成不透明的 `DefineComponent`，Type Checker 就
 * 追不進元件——那正是 ts-morph 在 Vue 專案的死穴。逐行改寫可保持行數不變。
 */
function rewriteVueImports(code: string): string {
  return code
    .split('\n')
    .map(line =>
      IMPORT_LINE.test(line) || line.includes('import(') ? line.replace(VUE_SPECIFIER, '$1$2.vue.ts$1') : line
    )
    .join('\n')
}

function buildVirtualTs(source: string, descriptor: SFCDescriptor): string | null {
  const blocks = [descriptor.script, descriptor.scriptSetup].filter((b): b is SFCScriptBlock => b != null)
  if (blocks.length === 0) return null

  const out = new Array<string>(source.split('\n').length).fill('')
  for (const block of blocks) {
    // block.loc.start 指到開標籤之後，故 content 通常以 \n 開頭、
    // 第 0 行落在 `<script>` 那一行（空字串），第 1 行才是真正的程式碼。
    const lines = block.content.split('\n')
    const startLine = block.loc.start.line
    for (let i = 0; i < lines.length; i++) {
      const target = startLine - 1 + i
      if (target >= 0 && target < out.length) out[target] = lines[i]!
    }
  }
  return rewriteVueImports(out.join('\n'))
}

export function parseSfc(rel: string, source: string): ParsedSfc {
  const { descriptor, errors } = parse(source, { filename: rel, sourceMap: false })
  const lang = descriptor.scriptSetup?.lang ?? descriptor.script?.lang ?? 'js'
  return {
    rel,
    descriptor,
    virtualTs: buildVirtualTs(source, descriptor),
    lang: lang === 'ts' || lang === 'tsx' ? 'ts' : 'js',
    errors: errors.map(e => e.message)
  }
}

/** 虛擬 TS 檔的路徑：`Foo.vue` → `Foo.vue.ts`（放在原檔旁邊，相對 import 才解析得到）。 */
export function virtualPathFor(vueRel: string): string {
  return `${vueRel}.ts`
}
