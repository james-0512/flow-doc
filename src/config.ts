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
 * 設定檔（`flow-doc.config.json`）的形狀：AnalyzerConfig 的部分覆寫，外加 `target`。
 *
 * 陣列欄位是**整段取代**而非合併——設定檔寫了 `follow` 就要列完整清單。
 * 合併語意會讓「移除一條預設規則」變得不可能表達。
 */
export interface FlowDocConfigFile extends Partial<Omit<AnalyzerConfig, 'repoRoot'>> {
  /** 目標 repo 路徑，**相對於本設定檔所在目錄**解析（也可給絕對路徑） */
  target?: string
}

export const CONFIG_FILE_NAME = 'flow-doc.config.json'

/**
 * 讀設定檔並剝掉底線開頭的鍵。JSON 沒有註解，而這份設定的每個欄位都需要解釋
 * 「為什麼是這些路徑」——`"_stop": "generated code 要放這裡，否則 DFS 會爆"`
 * 這種就地說明比另開一份文件有用得多。
 */
function readConfigFile(file: string): FlowDocConfigFile {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  const entries = Object.entries(raw).filter(([key]) => !key.startsWith('_'))
  return Object.fromEntries(entries) as FlowDocConfigFile
}

/**
 * 通用 Vue 3 專案預設值——只放**慣例**，不放任何單一專案的實情。
 *
 * 每個目標專屬的部分（哪些目錄不展開、generated code 在哪、有哪些橫切邏輯、
 * 額外的 alias）一律寫在該目標手冊 repo 的 `flow-doc.config.json`。
 * 混在這裡的話，下一個目標會默默繼承上一個目標的假設——錯了也不會報錯，
 * 只會讓手冊沉默地漏或錯。範本見 `templates/flow-doc.config.example.json`。
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
      'src/composables/',
      'src/utils/composables/',
      'src/api/',
      'src/router/'
    ],
    opaque: [],
    stop: ['src/types/', 'src/assets/'],
    followOverrides: [],
    globalComponentsDts: 'src/components.d.ts',
    routerDir: 'src/router',
    aliases: { '@/': 'src/' },
    crosscut: [],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/*.d.ts'
    ]
  }
}

/** 讀取 repo 根的 flow-doc.config.json（若存在）並覆蓋預設值。 */
export function loadConfig(repoRoot: string, configPath?: string): AnalyzerConfig {
  const base = defaultVueConfig(repoRoot)
  const file = configPath ?? path.join(repoRoot, CONFIG_FILE_NAME)
  if (!fs.existsSync(file)) return base
  const { target: _target, ...overrides } = readConfigFile(file)
  return { ...base, ...overrides, repoRoot }
}

export interface ResolvedConfig {
  config: AnalyzerConfig
  /** 實際採用的設定檔，null 代表全用預設值 */
  configFile: string | null
  /** 目標 repo 的來源，回報給使用者看，出錯時才知道該改哪裡 */
  targetSource: 'argument' | 'env' | 'config'
}

/**
 * 決定「分析哪個 repo、用哪份設定」。
 *
 * 手冊與工具分家後，日常操作是 `cd <手冊 repo>/<目標>` 然後裸命令跑 CLI——
 * 設定檔就在 CWD，目標 repo 由設定檔的 `target` 指出去。所以：
 *
 * - **設定檔**：`--config` > CWD > 目標 repo 根（單一 repo 時期的舊佈局，仍支援）
 * - **目標 repo**：命令列參數 > `FLOW_DOC_TARGET` 環境變數 > 設定檔的 `target`
 *
 * `target` 相對於設定檔目錄而非 CWD，手冊 repo 才能整個搬家不用改設定；
 * 環境變數則是給 CI 用的——checkout 路徑每次都不同，但不該汙染版控中的設定檔。
 */
export function resolveConfig(opts: {
  repoArg?: string
  configPath?: string
  cwd?: string
}): ResolvedConfig {
  const cwd = opts.cwd ?? process.cwd()

  let configFile: string | null = null
  if (opts.configPath) {
    configFile = path.resolve(cwd, opts.configPath)
    if (!fs.existsSync(configFile)) throw new Error(`找不到設定檔：${configFile}`)
  } else {
    const atCwd = path.join(cwd, CONFIG_FILE_NAME)
    if (fs.existsSync(atCwd)) configFile = atCwd
    else if (opts.repoArg) {
      const atRepo = path.join(path.resolve(cwd, opts.repoArg), CONFIG_FILE_NAME)
      if (fs.existsSync(atRepo)) configFile = atRepo
    }
  }

  const file: FlowDocConfigFile = configFile ? readConfigFile(configFile) : {}

  const envTarget = process.env.FLOW_DOC_TARGET?.trim()
  let repoRoot: string
  let targetSource: ResolvedConfig['targetSource']
  if (opts.repoArg) {
    repoRoot = path.resolve(cwd, opts.repoArg)
    targetSource = 'argument'
  } else if (envTarget) {
    repoRoot = path.resolve(cwd, envTarget)
    targetSource = 'env'
  } else if (file.target && configFile) {
    repoRoot = path.resolve(path.dirname(configFile), file.target)
    targetSource = 'config'
  } else {
    throw new Error(
      `不知道要分析哪個 repo。三選一：\n` +
        `  1. 命令列給路徑：flow-doc trace <repo>\n` +
        `  2. 在手冊 repo 的目標目錄下執行，且其 ${CONFIG_FILE_NAME} 有 "target" 欄位\n` +
        `  3. 設環境變數 FLOW_DOC_TARGET（CI 用）`
    )
  }

  if (!fs.existsSync(repoRoot)) {
    throw new Error(`找不到目標 repo：${repoRoot}（來源：${targetSource}）`)
  }

  const { target: _target, ...overrides } = file
  return {
    config: { ...defaultVueConfig(repoRoot), ...overrides, repoRoot },
    configFile,
    targetSource
  }
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
