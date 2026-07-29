# 設計決策紀錄

grill 階段定案的六個決策，以及它們對 [plan.md](plan.md) 的修正。plan.md 保留原樣不動，
兩份文件衝突時以本檔為準。

## D1 — 目標 repo 是 Vue 前端

`C:\project\mPHR_Frontend`：Vue 3.5 + TS 6.0 + Pinia 2 + vue-router 4 + axios + SignalR + Electron。
`src` 下 753 SFC / 371 TS / 196,470 行（不含 generated）。

**對 plan.md 的修正**：plan.md §3 階段一列的 entry 特徵（`app.post()`、`@EventPattern`、`@Cron`）
是後端 Nest/Express 形態，本專案一個都不適用。

## D2 — SFC 用 `@vue/compiler-sfc` 拆檔 + 行號對齊的 virtual `.vue.ts`

`src/shims-vue.d.ts` 把 `*.vue` 宣告成不透明的 `DefineComponent`，ts-morph 的 Type Checker
追不進任何元件。做法是拆出 script 區塊、用空行墊到原始行號，產生「虛擬檔第 N 行 === `.vue` 第 N 行」
的對齊檔，並把 `.vue` import 改寫成 `.vue.ts` 繞過 shim。

不採用 Volar（`@vue/language-core`）：綁 vue-tsc 內部 API、虛擬碼含 `__VLS_` 雜訊、需 sourcemap
還原行號。本專案已有 TS 7 升級被 vue-tsc 卡死的前例，風險是具體的。

**對 plan.md 的修正**：plan.md §1.3 說「tree-sitter 保留給 fallback 情境（非 TS 檔案）」——
在 Vue 專案，那個「fallback 情境」是主體。目前完全不需要 tree-sitter。

## D3 — 一條流程 = 「穿越邊界的使用者動作」

判準：從 UI 事件或 route 進入後，call chain 中至少出現一次 mutating API 呼叫或 store 寫入。
以 `src/views|components|layouts/<Domain>/` 的第一層目錄分成業務域，做兩層目錄（域 → 動作）。

若以 `@click` 為單位會產出 2,176 條「流程」，其中絕大多數是開 modal、切 tab、toggle。

**對 plan.md 的修正**：M1 交付的是 **entry 候選清單**，不是手冊目錄。要先追完階段二才知道
哪些候選穿越了邊界，目錄要等那時才定案。plan.md §7 的 M1 定義（「列出完整 entry point 清單＝手冊目錄」）
據此調整。

## D4 — 非呼叫式控制流只接有語法 join key 的三種

| 機制 | 出現次數 | 處置 |
|---|---|---|
| 元件 `emit` → parent `@listener` | 1018 | **接**（標籤 + 事件名） |
| SignalR server push | 63 | **接**（hub method 名） |
| `BroadcastChannel` | 6 | **接**（channel 名字串） |
| `watch` / `watchEffect` | 239 | 標記「此處有連動，未追蹤」 |
| `defineExpose` + `ref.method()` | 43 | 標記 |
| 全域 eventBus | **0** | 不存在 |

`watch` 沒有 join key，要接就得做 data-flow 分析——成本高一個量級且誤判會產生**假步驟**，
比缺步驟更傷手冊信任度。沿用 plan.md §3 階段三對動態事件名的務實原則。

**對 plan.md 的修正**：plan.md §3 階段三整章的 `eventBus.emit("X")` ↔ `@OnEvent("X")` 字串 join
在本專案零命中，替換為上表。

### D4 補充（階段三實作後）

實作 emit join 時浮現三件當初沒想到的事，一併定案：

1. **事件名要 camelize 才能 join。** Vue 讓 `emit('updateParams')` 與 template 的 `@update-params`
   互通，兩種寫法在這個 repo 都大量出現。不正規化的話同一條連結會被當成兩個名字——
   實測修正後接合數從 248 跳到 470。
2. **`emit('update:x')` 的 writeback 不是缺口。** 全 repo 有 417 個（41%）的 emit 屬於這一類，
   而 template 有 940 個 `v-model=`。v-model 的另一端只是父層的 ref 賦值、沒有 handler 可接，
   正是 D4 排除的 reactive 類別。統計上必須與真缺口分開，否則會把非缺口報成缺口。
3. **`components/Utils/*` 的 emit 接不到是設計使然。** 依 D5，父層綁在 Utils 元件上的事件
   已記成 entry（因為觸發點在我們不掃描的元件內部），所以流程從父層那側就捕捉到了，
   不需要也不應該再從 Utils 內部往回接。

殘餘無法接合的 121 處中，最大宗是 `<component :is="...">` 上的 listener（動態元件，
標籤解析不到檔案）——這與 plan.md §5 的「interface 多型無法靜態決定」同類，屬已知極限。

## D5 — 邊界改成三分法，白名單制控制雜訊

plan.md §3 的邊界表把「停止點」與「副作用記錄點」混為一談，拆成：

| 類別 | 行為 | 前端對應 |
|---|---|---|
| `STOP` | 停，不記錄 | node_modules、`swaggerApi.ts`、i18n、`src/types` |
| `SINK` | 停，記錄為副作用 | API 呼叫、localStorage、`router.push`、`emit`、SignalR |
| `FOLLOW` | 繼續追，同時記錄副作用 | Pinia store action |

`src/plugins/swaggerTypescriptApi/swaggerApi.ts` 是 **94,926 行的 generated 檔**且位於 `src/` 內。
plan.md 只擋 `node_modules` 的規則不夠，必須以路徑判定 STOP，否則 DFS 直接爆掉。

雜訊控制採白名單：只追 `views/`、`components/`（除 `Utils/`）、`layouts/`、`stores/`、
`utils/composables/`、`api/`、`router/`。`utils/functions/` 與 `components/Utils/` 記錄但不展開，
單檔可覆寫回 FOLLOW（如 `execute.ts` 的 `checkPermissions`——權限判斷會改變流程走向）。

## D6 — 兩件式交付：分析器 CLI + Claude Code Skill

- **analyzer**（本專案）：Node CLI，確定性、可單元測試，吐 JSON
- **generator**：Claude Code skill，讀 JSON 產手冊

M1–M3 完全不碰 LLM、不需 API key。JSON 契約穩定後再補 `--llm=api` 模式供 CI 使用。

**對 plan.md 的修正**：§6 技術選型移除 LangGraph——生成階段是一次性 transform，沒有
state machine 可管，引入它等於多養一個 runtime。

## D7 — 流程判準改為「跨越 HTTP 邊界」，並分寫入／查詢兩類

D3 原本的判準是「至少一次寫入」。靜態站輸出前的技術審視發現這條線切錯了地方：

- 339 條流程中**只有 4 條由頁面載入觸發**，手冊對「進入這頁會發生什麼」幾乎空白
- 563 條鏈確實打了後端 API 但只讀，被整批排除——包含搜尋、篩選、檢視明細

關鍵觀察是：改成「至少一次 HTTP API 呼叫」後，仍有 987 條完全沒碰後端的鏈被擋掉，
**D3 原本要擋的 UI 開關一條都沒漏進來**。也就是說寫入與否從來不是那條線的本質，
跨不跨後端才是。

結果：902 條流程（寫入型 339 · 查詢型 563），頁面載入流程 4 → 13 條。

## D8 — 橫切邏輯獨立成章

axios 攔截器（請求／回應 × 成功／錯誤四個回呼）與 `buildGuards()` 組出的路由守衛
管線各自成鏈，歸在「全域前置」域，手冊寫成獨立一章，各流程連結引用。

不在每條流程展開的理由：那會讓 902 條流程每一條都重複描述一次 token 注入、
語言標頭、載入狀態、MFA challenge 與 token 續期，把真正的業務內容淹沒。

---

## 尚未定案

- **redirect 路由**（61 條無 component 的中繼節點）目前只記錄不處理。
- **334 個 ROUTE entry** 目前只存在 JSON 中未被使用。對靜態站有價值——
  `URL → 流程`的導覽結構、以及「這一頁上有哪些動作」的分組依據。
