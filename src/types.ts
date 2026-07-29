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

// ── 階段二：call chain 追蹤 ────────────────────────────────────────────────

export type SinkKind =
  | 'HTTP_API'
  | 'STORAGE'
  | 'ROUTER_NAV'
  | 'EMIT'
  | 'SIGNALR'
  | 'BROADCAST'
  /** 動到 Pinia store */
  | 'STORE'
  /** 呼叫了白名單外、不展開的共用層 */
  | 'OPAQUE'

export interface SideEffect {
  kind: SinkKind
  /** 例如 `POST /api/v1/case/create`、事件名、storage key */
  detail: string
  /** 寫入型副作用。D3 的流程判準：整條鏈至少要有一個 mutating 才算一條業務流程 */
  mutating: boolean
  loc: SourceLoc
  /**
   * 位於 try 保護範圍內，**含上游**——深層拋出的錯誤會被祖先的 try 接住，
   * 所以這個旗標沿著鏈往下傳遞。階段四的「異常與補償」需要這個訊號。
   */
  guarded?: boolean
  /** 補充說明，例如 swagger 端點的中文 summary */
  note?: string
}

export type StopReason = 'MAX_DEPTH' | 'CYCLE' | 'BUDGET' | 'BOUNDARY' | 'UNRESOLVED'

/**
 * 非同步／跨元件的控制流連結。
 *
 * 在這個 repo，最大宗的斷點不是後端那種全域 event bus，而是子元件 `emit` 到
 * parent template 的 `@listener`——ts-morph 完全看不到這條邊，因為它跨越了
 * template。join key 是「子元件檔案 + 事件名」。
 */
export interface AsyncLink {
  kind: 'EMIT' | 'SIGNALR' | 'BROADCAST'
  event: string
  /** 發送點（子元件內的 emit） */
  from: SourceLoc
  /** 接收點（parent template 上的 @listener） */
  to: SourceLoc
  /** parent 的 handler 表達式 */
  handlerExpr: string
  /** 接住之後展開的子鏈；handler 解析不到時為 null */
  chain: ChainNode | null
}

export interface ChainNode {
  name: string
  loc: SourceLoc
  /** 函式主體的結束行。讓 pack 能直接從 JSON 取原始碼，不必重跑整個分析 */
  endLine?: number
  effects: SideEffect[]
  children: ChainNode[]
  /** 本節點的 emit 接到哪些 parent handler。一個事件可能有多個 parent，全部列出不硬選 */
  asyncLinks?: AsyncLink[]
  /**
   * 呼叫解析出多個候選定義（interface 多實作、多載）時全部列出，**不硬選**。
   * plan.md §3 的原則：交由 LLM 於生成時說明「依注入／設定決定」。
   */
  candidates?: SourceLoc[]
  stoppedBy?: StopReason
}

export interface FlowChain {
  entryId: string
  domain: string
  label: string
  entryLoc: SourceLoc
  root: ChainNode | null
  /** 整條鏈的副作用彙總（去重後） */
  effects: SideEffect[]
  nodeCount: number
  maxDepth: number
  /** 是否穿越了寫入型邊界——決定它進不進手冊目錄 */
  isFlow: boolean
  unresolvedCalls: number
}

export interface TraceStats {
  entriesTraced: number
  entriesUnresolvedHandler: number
  flows: number
  programMs: number
  traceMs: number
  swaggerEndpoints: number
  /** 解析不到定義的呼叫，依名稱彙總。缺口要看得見，不能靜默 */
  unresolvedTop: { name: string; count: number }[]
  /** 無法起鏈的 handler 表達式，依名稱彙總 */
  unresolvedHandlerTop: { name: string; count: number }[]
  /** 成功接起來的 emit → parent handler 連結數 */
  asyncLinksJoined: number
  /** 找不到任何 parent listener 的 emit——真缺口 */
  emitsUnjoined: number
  /**
   * `emit('update:x')` 且父層以 `v-model` 綁定的 writeback。
   * 另一端只是 ref 賦值、沒有 handler 可接，屬 D4 明確排除的 reactive 類別，
   * 不是缺口。分開計數以免把非缺口報成缺口。
   */
  emitsModelBinding: number
  /** 接不到的 emit 出處，依「檔案 @事件」彙總，供判斷是真缺口還是設計使然 */
  unjoinedEmitTop: { name: string; count: number }[]
  /** 因為接上 parent 才成為流程的 entry 數——這是階段三的實際貢獻 */
  flowsGainedByJoin: number
}

export interface TraceResult {
  repoRoot: string
  generatedAt: string
  chains: FlowChain[]
  stats: TraceStats
}
