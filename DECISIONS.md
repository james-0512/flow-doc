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

## D9 — 工具與資料分家：每個目標一個手冊 repo

flow-doc 是工具，不綁定單一目標；`C:\project` 下有二十幾個前端 repo，mPHR 只是第一個。
分析產出與 manuals 原本放在工具 repo 根目錄，那是單目標時期的便宜行事——多目標會互相
覆蓋，而且手冊的版本歷史會跟工具的版本歷史攪在一起，「這章敘述為什麼變了」分不出是
程式行為變了還是分析規則變了。

- **flow-doc**：`src/`、`fixtures/`、`templates/`、flow-manual skill（源）、plan／DECISIONS／LOOP
- **`flow-manuals/<目標名>/`**：`flow-doc.config.json`、baseline `flow-chains.json`、
  `packets/`、`manuals/`、`LIMITATIONS.md`、生成的 `site/`

配套三件：

1. **`defaultVueConfig` 只留 Vue 慣例**，mPHR 專屬的四項（swagger STOP、Utils/functions
   opaque、`utils/service` follow、`@config/` alias、兩條 crosscut）全搬進其設定檔。
   留在預設值裡的話，下一個目標會默默繼承上一個目標的假設——**錯了不會報錯，
   只會讓手冊沉默地漏或錯**。fixture 同理，改用自己的 `flow-doc.config.json`
   （順帶讓測試真的走過設定檔路徑）。
2. **設定解析改成 CWD 優先**：設定檔 `--config` > CWD > 目標 repo 根；目標 repo
   命令列 > `FLOW_DOC_TARGET` > 設定檔 `target`（相對設定檔目錄，手冊 repo 可整個搬家）。
   `[repo]` 參數變 optional。
3. **設定檔支援底線註解鍵**（`"_stop": "generated code 要放這裡…"`），讀取時剝除。
   JSON 沒有註解，而這份設定每個欄位都需要解釋「為什麼是這些路徑」。

驗證方式：拆前用舊程式碼產 baseline，拆後從新家跑 trace，兩份 `flow-chains.json`
逐條比對——1894 條鏈、901 條流程、16 條橫切**完全相同，零差異**。分析器的確定性
在這裡直接變成重構的安全網。

順帶發現：README 與 LIMITATIONS 的數字（902 流程／339 寫入／5 條全域前置）**早已過時**，
舊程式碼跑出來就是 901／305／16。實例數字放在工具 repo 裡沒人會去對，這正是分家的另一個理由。

## D10 — 語意錨點 ID 取代 file:line 身份（閉環地基）

手冊檔名就是 entry ID 的 slug，而舊 ID 是 `檔案:行號:標籤:事件`——上游隨便一個 commit
讓行號漂移，同一顆按鈕就變成「新流程」：舊敘述成孤兒、閉環每晚重寫整本手冊。
新 ID 是 `檔案#標籤.事件@handler`，行號降級為 payload。

- **handler 名要進 ID**：同標籤同事件在同檔出現多次時，綁不同 handler 就是不同的
  業務動作（一顆存檔一顆刪除）。少了它只能靠序數，而序數會隨程式碼調整位移。
- **完全撞名者以文件順序加 `~2`**：實測 mPHR 9.1%（174/1910）需要，其餘 90.9% 是
  純語意錨定。這是唯一可用的 tiebreaker，代價是中間插入會讓後面位移。
- **crosscut 用 label 不用 index**：`crosscut:檔案#路由守衛 — AuthGate`，
  index 會隨檔案內宣告順序漂移。
- **ROUTE 用 path**：路由的語意身份就是它的 path。
- **表示法版本**：`REPRESENTATION_VERSION` 常數（非 package 版本、非 git hash）——
  前者會忘記 bump，後者每個 commit 都變、改錯字也觸發全量重生。它是刻意的人為宣告：
  **它變了就代表舊 baseline 不能拿來 diff**。連同目標 repo 的 commit hash 與 dirty
  旗標一起寫進 `flow-chains.json`，供閉環早退比對與升版圈判斷。

### 順帶修掉一個會靜默出錯的既存 bug

`slugify` 截斷在 100 字元，長 ID 會共用同一個檔名。**舊規則下 mPHR 有 15 組碰撞**，
其中一組實際發生了：`PsychiatricEmergencyResponseSystem/.../Response/IndexView.vue`
的 5 條流程共用同一個截斷檔名，站台把同一份手冊顯示給 5 條流程——
其中 3 條（`showAddFormModal`、`closeFormHandler`、`visitationProgressCompletedHandler`）
是完全不同的動作。語意 ID 更長，碰撞會惡化到 114 組。

改成「超長時補完整 ID 的短雜湊」而非純截斷，碰撞歸零（1910/1910 唯一）。
所以「已撰寫敘述」從 229 降為 226——**226 才是對的，229 是碰撞灌水的**。

同批修掉 `pack` 不清輸出目錄的問題：流程消失或改名會留下孤兒封包，
永遠不再更新卻仍被 diff 與 PR 審查看到。

### 遷移

新舊 ID 由同一次 trace 同時吐出（`legacyEntryId`），對照精確一對一，不靠重建猜測。
135 份手冊全部改名、23 份的 67 個 `covers:` 條目全部改寫，零孤兒、零失效引用。
`legacyEntryId` 是過渡欄位，遷移提交後即移除。

## D11 — diff 五分類：結構、主體、行號三段判定

`flow-doc diff` 依序比三件事，順序有意義：

1. **結構簽章**（呼叫了誰、什麼副作用、接到哪些 parent handler，**不含行號**）不同 → `changed`
2. 結構相同但 **`sourceHash`** 不同 → 仍是 `changed`
3. 都相同、只有 **行號簽章** 不同 → `moved`，走 0-token 機械改寫

**`sourceHash` 是必要的，不是保險。** 函式主體改了但呼叫結構沒變（例如把判斷條件反過來），
結構簽章完全相同，但封包附的原始碼變了、敘述可能失真。實測一個真實的四 commit 區間，
三條 `changed` **全部**是這一類——純結構比對會把它們全判成 moved、只機械改行號，
留下描述舊邏輯的手冊。它必須在 trace 當下計算並存進 JSON：diff 只有兩份 JSON，
拿不到 baseline 那個 commit 的原始碼。

結構簽章刻意**不收 `unresolvedCalls`**：它會隨目標有沒有裝 node_modules 而變，
收進來會讓環境差異偽裝成程式變更。

實測經濟性（mPHR 四個 commit）：79 條行號漂移、3 條主體變更 → **33 章機械改寫、
1 章需 LLM**。多數輪次不花 token 這個假設成立。

### 決定性是閉環的前提

實作 diff 時發現同一份程式碼連跑兩次會有 1 條鏈被判成變更：同一個 `emit` 的兩個
parent listener 順序會翻轉。根因是 `glob()` 不保證回傳順序，一路影響 listener 的排序——
而排序不只決定封包的呈現順序，更決定超過 `maxListeners` 時**哪幾個**被展開。

不修的話那一章會每晚被重寫、永遠燒 token。兩處都排序（檔案清單、listener 依文件順序），
並加了「同一份程式碼跑兩次結果必須完全相同」的回歸測試。

### 乾淨 checkout 缺 generated 檔會讓分析結果不可比

`src/components.d.ts` 由 unplugin-vue-components 產生且不進版控，所以
CI／容器／`git worktree` 的乾淨 checkout 不會有它。少了它，全域註冊元件的標籤
全部解析不到檔案——實測同一個 commit 的流程數從 901 變成 940，**而且完全無聲**。

分析器現在會對此發出警告。閉環的容器必須先跑目標的 codegen，或確保 checkout
含 generated 檔，否則第一輪 diff 會滿江紅。

### diff 比的是 chains，不是 manuals

901 條流程只有 226 條寫了敘述。拿 manuals 當基準的話，675 條從沒寫過的會全被判成
`added`，第一輪就想寫 675 章。閉環的職責是**維護已經寫過的敘述**，不主動補寫沒寫過的。

唯一例外：`added` 若落在**已經有人維護的業務域**（該域已有敘述）就該補上，
否則那個域的手冊會缺一塊。

## D12 — reanchor 與檔案改名：moved 的 0-token 路徑

### 改名對照

entry ID 含檔案路徑，所以搬一個資料夾會讓底下每條流程變成 removed＋added——
實際上它們只是換了位置。`detectRenames` 用 `git diff --name-status -M` 取得對照，
diff 先把 baseline 的 ID 換成新路徑再配對，於是落在 moved。

**只換 ID，不換內部節點的 loc**：那些路徑差異正是要讓行號簽章反映出來的東西，
敘述裡引用的舊路徑得靠 reanchor 改寫。取不到對照（非 git、淺層 clone）就回空表，
退回 removed＋added 的保守行為——比猜錯安全。

配套把 `sourceHash` 的檔案路徑拿掉（表示法 v4）：含路徑的話純改名會被判成
「主體改了」而去燒 token，但實際上只要機械改寫引用就好。

### reanchor

由「結構相同的兩條鏈」平行走訪建位置對照表，把敘述裡的 `file:line` 改寫到新位置。
三個要點：

- **用函式內位移換算**，不是只改起始行。敘述常引用函式主體中間某一行
  （函式 `100-119`、引用 `:110`），只對應起始行會全部歪掉。
- **取最小涵蓋區間**：巢狀節點時內層才是正確的參考框架。
- **對照不到就原樣保留並回報，不猜。** 留著舊行號會被 verify 抓出來——那是刻意的，
  寧可紅燈進待人工佇列，也不要偷偷寫一個看起來合理的錯位置。

一份敘述涵蓋的不只一條鏈（`covers:` 宣告的、共用同一個 handler 的其他觸發點），
所以對照表要**以檔案為單位收齊所有相關的鏈**。只從 moved 那幾條建表的話，
其餘鏈的引用會查不到而被誤報成「對照不到」——實測誤報 80 處，收齊後歸零。

### 端到端驗證方式

把現有手冊反向 reanchor 到四個 commit 前的位置，再用該 commit 的封包跑 verify：

| | 通過 | 失敗 |
|---|---|---|
| 未改寫（對照組） | 90 | 44 |
| reanchor 後 | 109 | 25 |
| 真實環境（現況手冊 vs 現況封包） | 109 | 25 |

reanchor 後的失敗集合與真實環境**完全一致**——修好 19 份、零新增失敗。
剩下的 25 份是既有的手冊問題，與 reanchor 無關。

### 順帶修掉語意 ID 造成的回歸

那 25 份失敗中有 16 份的根因是：封包在「副作用相同的其他觸發點」區塊只列 entryId。
舊 ID 含行號，撰寫者能從 ID 讀到位置；**語意 ID 拿掉行號後那個資訊就消失了**，
但敘述的「觸發」一節仍需列出各控件的位置，於是只能自己編——編出來的行號被
verify 判為臆測。封包改成明列每個 peer 的 `file:line` 後，25 → 9。

剩下 9 份全在 Form 域，引用了封包從未提供的位置（多為 `src/api/form.ts` 的
函式定義行），屬既有的內容問題，正是 verify 該抓的東西。

## D13 — narrate：唯一花 token 的一步，verify 當驗收關

`flow-doc narrate` 讀 diff 的 `work.rewrite`，逐章呼叫 API 產出敘述，通過 verify 才寫入。

**規則只有一份。** system prompt 直接讀 `flow-manual` 的 `SKILL.md`（剝掉 frontmatter，
加一段無人值守的輸出約定），不另寫一份 API 版硬規則——兩邊各寫一份的話，手冊會依
「誰寫的」而有不同可信度標準，而且沒人會發現。找不到時退回工具自帶的那份，
新手冊 repo 不必先複製 skill 就能跑。

**重試把違規原文餵回去**，而不是泛泛地說「再寫一次」——verify 已經指名哪個引用有問題。
每種違規的修法不同，prompt 要分開講：`UNCITED_EFFECT` 是**漏寫要補**，
`NOT_IN_PACKET` 是**多寫要改或刪**——講反了會越修越糟。

**兩種情形不重試**：`max_tokens` 截斷與安全分類器擋下。同樣的 prompt 再送一次結果一樣，
只是白花錢；直接把 `stopReason` 往外拋，讓人看得到真正的原因。

**重試用完仍不過就不寫入**，降級成「分析已更新、敘述待補」（site 本來就容忍此狀態）。
寧可少一章，也不要讓引用造假的敘述進手冊——整個專案的可信度就靠這一關。

**既有 frontmatter 原樣保留**：`covers:` 是作者對「這份敘述涵蓋哪些流程」的宣告，
可稽核且刻意不靠猜，不該由模型重新產生。

API 側的選擇：`claude-opus-5`（這是管線裡唯一需要判斷力的一步，不為省成本降級）、
串流（單章輸出加思考容易撞 HTTP timeout）、`cache_control` 快取 system（硬規則每章都一樣）、
`fallbacks: 'default'`（手冊裡有登入、權限、帳號鎖定這類字眼，分類器偶爾誤擋）。
`max_tokens` 是**思考與輸出共用**的預算，預設 32K 留餘裕——給太少的症狀是章節寫到一半斷掉。

`--dry-run` 用 count_tokens 先報輸入量、`--limit` 限制單次章數且**明說略過了幾章**
（靜默截斷會讓人以為全寫完了）。

### 順帶清掉語意 ID 遺留的死碼

`verify` 有段「covers: 宣告的觸發位置算合法引用」的例外，其正則要求舊式 ID 的
`:行號:` 格式——D10 之後 `covers:` 不含行號，這段**永遠不會命中**。實際需求已由
D12 的「封包明列 peer 位置」滿足，移除後 125/134 通過數一條未變，確認是死碼。

## D14 — loop：一圈的狀態機與 CI／容器 wiring

`flow-doc loop` 把整圈串起來：鎖 → 早退比對 → trace → diff 分流 →（歸檔／reanchor／narrate）
→ verify → commit（可選 PR）。狀態機（`src/loop.ts`）只做決策，所有碰檔案系統、git、API 的
動作經由 `LoopSteps` 注入——早退、熔斷、降級、佇列收斂全部可用假步驟測（32 個測試）。
`pack`／`reanchor`／`narrate` 的編排邏輯從 CLI action 抽成可重用函式，兩邊共用同一份
（pack 抽出後與既有 677 份封包逐位元相同）。

### 待人工佇列必須進版控（pending.json）

baseline 前進之後，下一輪 diff 把上輪的 changed 看成 unchanged——「這章還沒寫完」這個事實
**只剩佇列記得**。不落地的話，降級的章節會永遠停在舊敘述，而且沒有任何地方看得出來。
所以佇列是 commit 進手冊 repo 的檔案，narrate 每輪的目標＝本輪 `work.rewrite` ∪ 佇列裡欠的；
寫成即清出、流程消失即清出、重複略過不重設 since（「掛多久」是人排優先序的依據）。
配套規則：**commit 沒前進的輪次不重寫 baseline 與封包**（純補佇列，避免雜訊 diff）；
早退條件多一條「佇列沒有可重試的欠帳」。

### verify 在機械路徑是佇列、不是 gate

narrate 自帶驗收（不過就不寫入），但 reanchor 對「對照不到」的引用刻意原樣保留——
那些紅燈屬於待人工，不該擋整輪（防呆一）。loop 的 verify 範圍是「本輪動過的檔案 ∪
佇列中先前驗證不過的檔案」：後者讓人修好的章節自動清出佇列，也讓 Form 域那 9 份
既有問題只在被動到時進佇列，不會每晚擋路。

### 自動合併從嚴

`autoMergeEligible` ＝ 無 LLM 產出 且 無歸檔 且 verify 全綠 且 沒有新欠帳。
歸檔雖然 0 token，但「流程消失」是業務語意上值得人看一眼的事。放行錯一次，
人就不會再信任這條管線——從嚴的成本只是多審幾個本來就該看的 PR。

### exit code 是 CI 的 gate

0 完成或早退 · 1 執行錯誤 · 2 需人工（升版圈、熔斷、無 baseline）· 3 這輪沒跑
（鎖被占、dirty、缺 generated 檔）。PR 模式在 gh 失敗時的語意：分支已推、工作不丟、
main 乾淨、重跑冪等——回到原分支收尾放在 finally。

### codegen 的答案（HANDOFF 的前置問題）

`pnpm generate:components-dts` ＝ 用 middleware mode 起一個 vite dev server 再關掉，
借 unplugin-vue-components 的掃描產出 `src/components.d.ts`——**需要目標完整的 node_modules**。
容器掛 host 的 repo（已有 dts）就免跑；CI 乾淨 checkout 必須先 `pnpm install` 再 codegen，
workflow 已內建這步。

### 跨環境的模組解析差異——熔斷器的第一次真實出動

把 Windows host 的目標 repo 掛進 Linux 容器跑一圈：diff 報 **949 條 changed**，熔斷器擋下、
一個檔案都沒寫。根因不是程式變更：mPHR 的 node_modules 是 pnpm junction 結構，junction 的
絕對路徑目標（`C:\…`）在 Linux 容器裡是斷鏈，pinia 這類「靠 node_modules 型別」的解析全部
失效——941/1894 條鏈的樹形改變（實測 `loadingStore.addLoadingKey` 這類 store 方法全部
解析不到）。結論寫進設計：

- **baseline 必須與分析環境同源**。生產的 loop 容器要跑在 Linux runner，目標 checkout 與
  `pnpm install` 原生完成，baseline 也由容器產生；Windows 開發機直接跑原生 node。
- `flow-chains.json` 的 analyzer metadata 加記 `platform`（選填、不 bump 表示法），
  loop 在跨平台 diff 前明白警告「先懷疑環境而不是程式」。

### 端到端驗證（scratch clone，未動真實 manuals）

早退 0.93 秒（連 trace 都不跑）；合成 baseline 一圈 18 秒——diff 在 1910 條鏈中精準抓出
1 moved＋1 changed（零噪音）、reanchor 改寫 7 處引用（+3 位移全對）、無憑證時 narrate
降級進佇列且輪次照樣收尾；佇列重試輪不動 baseline 只補欠帳；PR 模式分支推送與現場還原
驗證通過；publish 容器 build 950 頁站台原子換版，nginx 服務中文路徑全綠。

---

## 尚未定案

- **redirect 路由**（61 條無 component 的中繼節點）目前只記錄不處理。
- **334 個 ROUTE entry** 目前只存在 JSON 中未被使用。對靜態站有價值——
  `URL → 流程`的導覽結構、以及「這一頁上有哪些動作」的分組依據。
