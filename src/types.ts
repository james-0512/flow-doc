/**
 * 分析器的中間資料模型。
 *
 * 這份型別是 analyzer（確定性、可測試）與 generator（LLM）之間的契約：
 * analyzer 只吐這些結構，generator 只讀這些結構。任何 LLM 生成的內容都必須
 * 能對回這裡的 SourceLoc，否則視為幻覺。
 */

/** 原始碼位置。永遠指回使用者看得到的檔案（`.vue` 而非 virtual `.vue.ts`）。 */
export interface SourceLoc {
  /** 相對於 repo 根的 POSIX 路徑 */
  file: string
  /** 1-based */
  line: number
  column?: number
}

/**
 * 邊界三分法。plan.md 原本把「停止點」與「副作用記錄點」混為一談，這裡拆開：
 * - STOP   停止追蹤，且不記錄（node_modules、generated code、純格式化函式）
 * - SINK   停止追蹤，但記錄為副作用（API 呼叫、storage、router 導航、emit）
 * - FOLLOW 繼續往下追，同時記錄副作用（Pinia store action）
 */
export type BoundaryKind = 'STOP' | 'SINK' | 'FOLLOW'

export type EntryKind =
  /** template 上的使用者互動事件 */
  | 'UI_EVENT'
  /** onMounted / onActivated 等進入頁面自動觸發 */
  | 'LIFECYCLE'
  /** 路由定義本身（進入某頁） */
  | 'ROUTE'

/** entry point 候選。
 *
 * 注意「候選」二字：依 grill 結論，一條流程要成立必須在階段二追出至少一個
 * 穿越邊界的 SINK。真正的手冊目錄要等階段二收斂後才定案。
 */
export interface EntryCandidate {
  id: string
  kind: EntryKind
  /** 業務域。取自 src/{views,components,layouts}/<Domain>/，無法歸類則 'shared' */
  domain: string
  /** 人看的標籤，例如 `AppointmentForm.vue <button @click>` */
  label: string
  loc: SourceLoc
  /** 事件名（UI_EVENT）、鉤子名（LIFECYCLE）、路由 path（ROUTE） */
  trigger: string
  /** template 上綁定的原始表達式，例如 `handleSubmit` 或 `onSave(row)` */
  handlerExpr?: string
  /** 從表達式抽出的符號名，供階段二解析呼叫目標用 */
  handlerName?: string
  /** 觸發點所在的檔案（repo 相對路徑） */
  file: string
  /** 承載事件的標籤，例如 `button` 或 `UtilTable` */
  tag?: string
  /** UI_EVENT 專用：此事件掛在原生 DOM 元素還是不可分析的元件上 */
  origin?: 'native' | 'opaque-component'
  /** ROUTE 專用：該路由指向的元件檔 */
  routeComponent?: string
  /** ROUTE 專用：路由 name */
  routeName?: string
}

/**
 * 子元件 `emit` → parent `@listener` 的連結。
 *
 * 這是這個 repo 裡量體最大的跨檔控制流（1018 處），也是 ts-morph 完全看不到的部分。
 * 階段三會用 (toComponent, event) 反查子元件內的 `emit('event')` 位置完成接合。
 */
export interface ListenerEdge {
  /** 掛 listener 的 parent 檔案 */
  from: string
  /** 子元件標籤（正規化為 PascalCase） */
  tag: string
  /** 解析到的子元件檔案；解析不到代表是第三方或動態元件 */
  toComponent?: string
  /** 事件名 */
  event: string
  handlerExpr: string
  handlerName?: string
  loc: SourceLoc
}

export interface ScanStats {
  sfcFiles: number
  sfcWithScript: number
  tsFiles: number
  routeFiles: number
  globalComponents: number
  /** 因動態事件名（`@[evt]`）而無法靜態判定的綁定數 */
  dynamicEventBindings: number
  /** 標籤解析不到檔案的 listener 數 */
  unresolvedComponentTags: number
  elapsedMs: number
}

export interface EntryScanResult {
  repoRoot: string
  generatedAt: string
  entries: EntryCandidate[]
  listeners: ListenerEdge[]
  stats: ScanStats
}
