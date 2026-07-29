import { ts } from 'ts-morph'

export interface RawRoute {
  path: string
  name?: string
  /** `() => import('@/views/X/IndexView.vue')` 裡的 specifier，或具名 import 的 specifier */
  componentSpec?: string
  line: number
}

function stringOf(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined
}

/** 抓 `() => import('...')` 或 `defineAsyncComponent(() => import('...'))` 裡的 specifier。 */
function dynamicImportSpec(node: ts.Node): string | undefined {
  let found: string | undefined
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found = stringOf(n.arguments[0])
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/**
 * 從路由模組抽出 route 記錄。
 *
 * 只做語法比對——凡是帶字串 `path` 屬性的物件字面量就算一筆路由。
 * 這對 vue-router 的巢狀 `children` 也自然成立，因為遞迴會走進去。
 */
export function extractRoutes(fileName: string, code: string): RawRoute[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  // 元件來源有三種寫法，都要收：
  //   1. import Foo from '...'                      具名 import
  //   2. const Foo = () => import('...')            懶載入常數（vue-router 最常見）
  //   3. component: () => import('...')             inline
  const componentSources = new Map<string, string>()
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.importClause?.name) {
      componentSources.set(stmt.importClause.name.text, stmt.moduleSpecifier.text)
      continue
    }
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      const spec = dynamicImportSpec(decl.initializer)
      if (spec) componentSources.set(decl.name.text, spec)
    }
  }

  const routes: RawRoute[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map<string, ts.Expression>()
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          props.set(p.name.text, p.initializer)
        }
      }
      const path = stringOf(props.get('path'))
      if (path !== undefined) {
        const componentNode = props.get('component') ?? props.get('components')
        let componentSpec: string | undefined
        if (componentNode) {
          componentSpec =
            dynamicImportSpec(componentNode) ??
            (ts.isIdentifier(componentNode) ? componentSources.get(componentNode.text) : undefined)
        }
        routes.push({
          path,
          name: stringOf(props.get('name')),
          componentSpec,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return routes
}
