import fs from 'node:fs'
import path from 'node:path'
import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget } from 'ts-morph'
import { virtualPathFor } from '../load/sfc.js'
import type { Workspace } from '../workspace.js'

export interface AnalysisProgram {
  project: Project
  /** repo 相對路徑（`.vue` 或 `.ts`）→ ts-morph 內的絕對路徑 */
  sourcePathOf: (rel: string) => string
  elapsedMs: number
}

/**
 * 建立帶 Type Checker 的 ts-morph Project。
 *
 * 兩個必要設定：
 * - `allowImportingTsExtensions`：虛擬檔的 import 寫成 `'./Foo.vue.ts'`，帶副檔名
 * - `paths`：由 config.aliases 轉出，`@/` → `src/`
 *
 * 刻意不用目標專案的 tsconfig：它的 include 會把 swaggerApi.ts（94,926 行）
 * 與 electron / 測試檔全部拉進來，而我們只要業務層。
 */
export function createAnalysisProgram(ws: Workspace): AnalysisProgram {
  const started = Date.now()
  const { repoRoot, aliases } = ws.config

  const paths: Record<string, string[]> = {}
  for (const [prefix, target] of Object.entries(aliases)) paths[`${prefix}*`] = [`${target}*`]

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      baseUrl: repoRoot,
      paths,
      allowJs: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
      strict: false
    }
  })

  for (const rel of ws.tsFiles) {
    project.addSourceFileAtPathIfExists(path.join(repoRoot, rel))
  }
  for (const [rel, sfc] of ws.sfcs) {
    if (!sfc.virtualTs) continue
    project.createSourceFile(path.join(repoRoot, virtualPathFor(rel)), sfc.virtualTs, { overwrite: true })
  }

  const sourcePathOf = (rel: string): string =>
    path.join(repoRoot, rel.endsWith('.vue') ? virtualPathFor(rel) : rel)

  return { project, sourcePathOf, elapsedMs: Date.now() - started }
}

/** 讀取並索引 generated swagger client（若存在）。 */
export function readSwaggerSource(repoRoot: string): string | null {
  const p = path.join(repoRoot, 'src/plugins/swaggerTypescriptApi/swaggerApi.ts')
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
}
