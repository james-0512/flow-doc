import fs from 'node:fs'
import path from 'node:path'
import type { BoundaryKind } from './types.js'
import { matchesAny } from './paths.js'

export interface AnalyzerConfig {
  repoRoot: string
  /** 原始碼根目錄（repo 相對） */
  srcDir: string
  /** 白名單：這些前綴底下的檔案會被展開追蹤（FOLLOW） */
  follow: string[]
  /** 記錄「有用到」但不展開內部實作（SINK/不透明） */
  opaque: string[]
  /** 完全略過，連記錄都不留（STOP） */
  stop: string[]
  /** 逐檔覆寫成 FOLLOW，優先權高於 opaque / stop */
  followOverrides: string[]
  /** unplugin-vue-components 產生的全域元件宣告檔（repo 相對），null 代表沒有 */
  globalComponentsDts: string | null
  /** 路由定義所在目錄 */
  routerDir: string
  /** import 路徑別名，前綴替換。取自目標專案 tsconfig 的 paths。 */
  aliases: Record<string, string>
  /**
   * 橫切邏輯的入口。每條業務流程都會經過這些，但不該在每條流程裡重複展開。
   *
   * - `file` 可以是單檔或目錄
   * - `symbol` 指定單一函式；`symbolPattern` 用正則比對目錄下的匯出函式
   * - 兩者都省略時，自動尋找該檔的 axios interceptor 註冊
   * - `unwrapReturn`：追「被 return 出來的函式」而非工廠本身。路由守衛是
   *   `createXxxGuard(deps)` 回傳閉包的形狀，閉包由 vue-router 稍後呼叫，
   *   不追進去的話整條守衛邏輯都是空的
   */
  crosscut: {
    file: string
    symbol?: string
    symbolPattern?: string
    unwrapReturn?: boolean
    label: string
  }[]
  /** 掃描時排除的 glob（相對 repo 根） */
  exclude: string[]
}

/**
 * Vue 專案的預設設定，直接編碼 grill 階段定案的四個決策：
 *
 * 1. 只追業務層目錄（views / components / layouts / stores / composables / api / router）
 * 2. `components/Utils/` 與 `utils/functions/` 記錄但不展開——手冊不需要描述 formatDate
 * 3. generated code 以「路徑」判定為 STOP。plan.md 原本只擋 node_modules，
 *    但 swaggerApi.ts 有 9.5 萬行且位於 src/ 內，不擋會讓 DFS 直接爆掉
 * 4. 純函式模組中具業務語意者（權限判斷）逐檔覆寫回 FOLLOW——
 *    checkPermissions 會改變流程走向，那是業務邏輯不是工具函式
 */
export function defaultVueConfig(repoRoot: string): AnalyzerConfig {
  return {
    repoRoot,
    srcDir: 'src',
    follow: [
      'src/views/',
      'src/components/',
      'src/layouts/',
      'src/stores/',
      'src/utils/composables/',
      'src/utils/service/',
      'src/api/',
      'src/router/',
      'src/directives/'
    ],
    opaque: ['src/components/Utils/', 'src/utils/functions/', 'src/utils/data/', 'src/i18n/'],
    stop: ['src/plugins/swaggerTypescriptApi/', 'src/types/', 'src/assets/', 'src/data/'],
    followOverrides: ['src/utils/functions/execute.ts'],
    globalComponentsDts: 'src/components.d.ts',
    routerDir: 'src/router',
    aliases: { '@/': 'src/', '@config/': '' },
    crosscut: [
      {
        file: 'src/router/guards',
        symbolPattern: '^create[A-Za-z]+Guard$',
        unwrapReturn: true,
        label: '路由守衛'
      },
      { file: 'src/utils/service/api.service.ts', label: 'API 請求／回應攔截器' }
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage-report/**',
      '**/build-report/**',
      '**/playwright-report/**',
      '**/copilot-demo/**',
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/*.d.ts'
    ]
  }
}

/** 讀取 repo 根的 flow-doc.config.json（若存在）並覆蓋預設值。 */
export function loadConfig(repoRoot: string, configPath?: string): AnalyzerConfig {
  const base = defaultVueConfig(repoRoot)
  const file = configPath ?? path.join(repoRoot, 'flow-doc.config.json')
  if (!fs.existsSync(file)) return base
  const overrides = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AnalyzerConfig>
  return { ...base, ...overrides, repoRoot }
}

/**
 * 判定一個檔案的邊界類別。
 * 順序很重要：followOverrides 優先於 stop 與 opaque，否則單檔例外會被目錄規則吃掉。
 */
export function classifyPath(config: AnalyzerConfig, rel: string): BoundaryKind {
  if (matchesAny(rel, config.followOverrides)) return 'FOLLOW'
  if (matchesAny(rel, config.stop)) return 'STOP'
  if (matchesAny(rel, config.opaque)) return 'SINK'
  if (matchesAny(rel, config.follow)) return 'FOLLOW'
  return 'STOP'
}

/** 這個檔案能不能被展開分析（決定 template 上的元件事件算 entry 還是算 edge）。 */
export function isAnalyzable(config: AnalyzerConfig, rel: string): boolean {
  return classifyPath(config, rel) === 'FOLLOW'
}
