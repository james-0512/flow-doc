/**
 * 分析器的中間資料模型。
 *
 * 這份型別是 analyzer（確定性、可測試）與 generator（LLM）之間的契約：
 * analyzer 只吐這些結構，generator 只讀這些結構。任何 LLM 生成的內容都必須
 * 能對回這裡的 SourceLoc，否則視為幻覺。
 */
import type { TargetRevision } from './version.js'

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
  /**
   * 語意錨點識別碼，**不含行號**：`檔案#標籤.事件@handler`。
   *
   * 手冊檔名就是這個 ID 的 slug，所以它一變，敘述就對不回流程。用行號當身份的話，
   * 上游隨便一個 commit 讓行號漂移，同一顆按鈕就會變成「新流程」——舊敘述成孤兒、
   * 閉環每晚重寫整本手冊。行號改放 `loc`，那是 payload 不是身份。
   *
   * 同檔內完全同名的觸發點（同標籤同事件同 handler）以文件順序加 `~2`、`~3` 區分；
   * 那是唯一可用的 tiebreaker，代價是中間插入一個會讓後面的序數位移。
   */
  id: string
  /**
   * 舊版 `檔案:行號:標籤:事件` 識別碼，**僅供一次性遷移**。
   *
   * 遷移腳本用它把既有手冊檔名與 `covers:` 條目換成新 ID。遷移完成並提交後，
   * 這個欄位連同產生它的程式碼一起移除。
   */
  legacyId?: string
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

export type StopReason =
  | 'MAX_DEPTH'
  | 'CYCLE'
  | 'BUDGET'
  | 'BOUNDARY'
  | 'UNRESOLVED'
  /** 同一個函式已在本條鏈的別處完整展開過，這裡只放參照，不重複整棵子樹 */
  | 'DUPLICATE'

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
  /** 因為超過上限而沒有展開的 parent listener 數。上限必須看得見，不能靜默截斷 */
  omittedListeners?: number
  /**
   * 呼叫解析出多個候選定義（interface 多實作、多載）時全部列出，**不硬選**。
   * plan.md §3 的原則：交由 LLM 於生成時說明「依注入／設定決定」。
   */
  candidates?: SourceLoc[]
  stoppedBy?: StopReason
}

export interface FlowChain {
  /** 語意錨點識別碼，不含行號。見 EntryCandidate.id */
  entryId: string
  /** 舊版含行號的識別碼，僅供一次性遷移。見 EntryCandidate.legacyId */
  legacyEntryId?: string
  domain: string
  label: string
  /** 觸發方式：事件名、生命週期鉤子名，或橫切邏輯的階段 */
  trigger: string
  /** 承載事件的標籤（UI_EVENT 才有） */
  tag?: string
  entryKind: EntryKind | 'CROSSCUT'
  entryLoc: SourceLoc
  root: ChainNode | null
  /** 整條鏈的副作用彙總（去重後） */
  effects: SideEffect[]
  nodeCount: number
  maxDepth: number
  /**
   * 流程分類。判準是「鏈中有沒有跨越 HTTP 邊界」：
   * - `write` 有寫入型 API 或 storage 寫入
   * - `read`  只讀，但確實打了後端（搜尋、篩選、檢視明細、頁面載入）
   * - `none`  完全沒碰後端，是純 UI 開關（開 modal、切 tab、toggle）
   *
   * 原本只收 write，導致 339 條流程裡只有 4 條是頁面載入，手冊對「進入這頁會
   * 發生什麼」幾乎空白。改用 HTTP 邊界後仍有 942 條純 UI 鏈被擋掉，
   * 原本的過濾目的不受影響。
   */
  flowKind: 'write' | 'read' | 'none'
  /** `flowKind !== 'none'` */
  isFlow: boolean
  unresolvedCalls: number
  /**
   * 鏈上所有節點原始碼的簽章，於 trace 當下計算。
   *
   * diff 只拿得到兩份 JSON，拿不到 baseline 那個 commit 的原始碼，所以這個值
   * 必須在分析時就算好存起來。它捕捉「呼叫結構沒變但函式主體改了」的情形——
   * 少了它，手冊會安靜地與程式碼脫節。
   */
  sourceHash: string
}

export interface TraceStats {
  entriesTraced: number
  entriesUnresolvedHandler: number
  /** 寫入型流程 */
  flows: number
  /** 查詢型流程 */
  readFlows: number
  /** 因超過 maxCandidates 而未展開的多實作候選數 */
  candidatesTruncated: number
  /** 因超過 maxListeners 而未展開的 parent listener 數 */
  listenersTruncated: number
  /** 因已在鏈中別處展開過而以參照取代的節點數 */
  duplicateNodes: number
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
  /**
   * 產生這份分析的分析器身分。閉環 diff 起手先比 `representation`：
   * 相同走日常圈，不同走升版圈（表示法變了，舊 baseline 不能拿來 diff）。
   */
  analyzer: {
    representation: number
    /** package.json 的版本，資訊用；判斷依據是 representation */
    version: string
  }
  /**
   * 目標 repo 的 commit 與髒污狀態。閉環醒來後先比 commit，沒動就直接退出——
   * 連 trace 都不必跑。
   */
  target: TargetRevision
  chains: FlowChain[]
  /**
   * 橫切邏輯的鏈：axios 攔截器與路由守衛。
   *
   * 每條業務流程都會經過它們，但若在每條流程裡展開一次，手冊會被重複的
   * token 注入、載入狀態、MFA challenge 淹沒。改成獨立一章、各流程連結引用。
   */
  crosscut: FlowChain[]
  stats: TraceStats
}
