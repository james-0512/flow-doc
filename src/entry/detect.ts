import { ElementTypes, NodeTypes } from '@vue/compiler-core'
import type { ElementNode, RootNode, TemplateChildNode } from '@vue/compiler-core'
import type { AnalyzerConfig } from '../config.js'
import { isAnalyzable } from '../config.js'
import { normalizeTag } from '../load/registry.js'
import { resolveSpecifier, resolveToFile } from '../load/resolve.js'
import type { ParsedSfc } from '../load/sfc.js'
import type { ScriptFacts } from '../load/script.js'
import type { EntryCandidate, ListenerEdge } from '../types.js'

export interface DetectContext {
  config: AnalyzerConfig
  /** 全域自動註冊元件：PascalCase 名 → repo 相對路徑 */
  globalComponents: ReadonlyMap<string, string>
  /** repo 內所有已知檔案，供副檔名補全 */
  files: ReadonlySet<string>
}

export interface SfcScan {
  entries: EntryCandidate[]
  listeners: ListenerEdge[]
  dynamicEventBindings: number
  unresolvedComponentTags: number
}

/** 業務域：src/{views,components,layouts}/<Domain>/ 的第一層目錄。 */
export function domainOf(rel: string): string {
  const m = /^src\/(?:views|components|layouts)\/([^/]+)/.exec(rel)
  if (m) return m[1]!
  if (rel.startsWith('src/stores/')) return 'stores'
  if (rel.startsWith('src/router/')) return 'router'
  return 'shared'
}

const ARROW_PREFIX = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/
/** 剝掉不影響呼叫目標的前綴關鍵字，`async () => await save()` 才能命中 save */
const NOISE_PREFIX = /^(?:await|return|void)\s+/
const CALLABLE = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\(|$)/

/**
 * 從 template 的 handler 表達式抽出符號名，供階段二解析呼叫目標。
 * `handleSubmit` / `onSave(row)` / `() => doThing()` / `store.load()` 都要能命中。
 */
export function extractHandlerName(expr: string): string | undefined {
  let e = expr.trim()
  const arrow = ARROW_PREFIX.exec(e)
  if (arrow) e = e.slice(arrow[0].length).trim()
  if (e.startsWith('{')) e = e.slice(1).trim()
  for (let m = NOISE_PREFIX.exec(e); m; m = NOISE_PREFIX.exec(e)) e = e.slice(m[0].length).trim()
  return CALLABLE.exec(e)?.[1]
}

function walkElements(node: RootNode | TemplateChildNode, visit: (el: ElementNode) => void): void {
  if (node.type === NodeTypes.ELEMENT) visit(node)
  if (node.type === NodeTypes.IF) {
    for (const branch of node.branches) walkElements(branch as unknown as TemplateChildNode, visit)
    return
  }
  const children = (node as { children?: unknown }).children
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child && typeof child === 'object' && 'type' in child) walkElements(child as TemplateChildNode, visit)
    }
  }
}

function resolveTag(ctx: DetectContext, sfcRel: string, facts: ScriptFacts, tag: string): string | undefined {
  const pascal = normalizeTag(tag)
  const spec = facts.componentImports.get(pascal) ?? facts.componentImports.get(tag)
  if (spec) {
    const rel = resolveSpecifier(ctx.config.aliases, sfcRel, spec)
    const file = rel ? resolveToFile(ctx.files, rel) : null
    if (file) return file
  }
  return ctx.globalComponents.get(pascal)
}

/**
 * 掃一個 SFC 的 entry 候選。
 *
 * 判斷「什麼算 entry」的規則（grill 定案）：
 * - 原生 DOM 元素上的事件 → 一定是 entry，那是真正的使用者互動
 * - 元件上的事件 → 通常只是 emit 連結的下游（真正的觸發點在子元件內部），
 *   記成 ListenerEdge 而非 entry，避免同一個使用者動作被重複計為兩條流程
 * - **但**若子元件不可分析（第三方、或落在 opaque 白名單外如 components/Utils/），
 *   我們永遠掃不到它內部的觸發點，此時這個 listener 就是最上游 → 算 entry
 */
export function scanSfc(ctx: DetectContext, sfc: ParsedSfc, facts: ScriptFacts): SfcScan {
  const scan: SfcScan = { entries: [], listeners: [], dynamicEventBindings: 0, unresolvedComponentTags: 0 }
  const domain = domainOf(sfc.rel)

  for (const hook of facts.lifecycle) {
    scan.entries.push({
      id: `${sfc.rel}:${hook.line}:${hook.hook}`,
      kind: 'LIFECYCLE',
      domain,
      label: `${sfc.rel} ${hook.hook}()`,
      loc: { file: sfc.rel, line: hook.line },
      trigger: hook.hook,
      file: sfc.rel
    })
  }

  const ast = sfc.descriptor.template?.ast
  if (!ast) return scan

  walkElements(ast, el => {
    for (const prop of el.props) {
      if (prop.type !== NodeTypes.DIRECTIVE || prop.name !== 'on') continue
      const arg = prop.arg
      // `v-on="obj"`（無 arg）與 `@[evt]`（動態 arg）都無法靜態判定事件名
      if (!arg || arg.type !== NodeTypes.SIMPLE_EXPRESSION || !arg.isStatic) {
        scan.dynamicEventBindings++
        continue
      }
      const event = arg.content
      const handlerExpr = prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION ? prop.exp.content.trim() : undefined
      const line = prop.loc.start.line
      const handlerName = handlerExpr ? extractHandlerName(handlerExpr) : undefined

      if (el.tagType === ElementTypes.ELEMENT) {
        scan.entries.push({
          id: `${sfc.rel}:${line}:${el.tag}:${event}`,
          kind: 'UI_EVENT',
          domain,
          label: `${sfc.rel} <${el.tag} @${event}>`,
          loc: { file: sfc.rel, line },
          trigger: event,
          handlerExpr,
          handlerName,
          file: sfc.rel,
          tag: el.tag,
          origin: 'native'
        })
        continue
      }
      if (el.tagType !== ElementTypes.COMPONENT) continue

      const target = resolveTag(ctx, sfc.rel, facts, el.tag)
      if (!target) scan.unresolvedComponentTags++

      if (target && isAnalyzable(ctx.config, target)) {
        scan.listeners.push({
          from: sfc.rel,
          tag: normalizeTag(el.tag),
          toComponent: target,
          event,
          handlerExpr: handlerExpr ?? '',
          handlerName,
          loc: { file: sfc.rel, line }
        })
        continue
      }
      scan.entries.push({
        id: `${sfc.rel}:${line}:${el.tag}:${event}`,
        kind: 'UI_EVENT',
        domain,
        label: `${sfc.rel} <${el.tag} @${event}>`,
        loc: { file: sfc.rel, line },
        trigger: event,
        handlerExpr,
        handlerName,
        file: sfc.rel,
        tag: normalizeTag(el.tag),
        origin: 'opaque-component'
      })
    }
  })

  return scan
}
