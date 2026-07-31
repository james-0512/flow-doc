# 閉環設計

> 狀態：**設計定形、尚未實作**（2026-07-31 討論定案）。
> 對 [plan.md](plan.md) M5 的修正：不做「檔案 hash 快取、增量重分析」——全量分析只要 14 秒，
> 快取解錯了問題。貴的是 LLM token，**增量該放在敘述層**：全量分析、增量生成。

目標：目標 repo 的 main 前進後，手冊自動跟上並重新部署，每一圈可稽核、可回滾，
LLM token 只花在真正改變行為的 commit 上。

## 一圈的形狀

```mermaid
flowchart TD
    T["main 前進（目標 repo）<br>nightly 排程喚醒，比對 baseline"] --> A["trace＋pack 全量重分析<br>確定性 · 約 14 秒"]
    A --> D["diff：新舊 chains 以語意 ID 配對<br>五類三路＋熔斷判定"]
    D --> M["只有行號漂移<br>reanchor 機械改引用 · 0 token"]
    D --> C["鏈結構變／新增<br>LLM 重寫該章 · 花 token"]
    D --> R["流程消失<br>手冊歸檔下架"]
    M --> V["verify：全庫三層驗證<br>部署前唯一關卡"]
    C --> V
    R --> V
    V -.->|"個別 fail（重試 2 次仍紅）"| Q["待人工佇列<br>該章降級「分析已更新、敘述待補」"]
    V --> B["commit manuals＋baseline<br>→ push branch → 開 PR"]
    B --> H{"有 LLM 產出？"}
    H -->|"否（純 moved）"| MG["自動合併"]
    H -->|"是"| PR["人審 PR<br>擋 verify 擋不住的語意寫歪"]
    PR --> MG
    MG --> S["merge 後：site build<br>原子換版到共用 volume"]
    MG -.->|"新 baseline 生效"| T
```

## diff 五分類——調度核心

「鏈結構」= 節點序列＋副作用清單＋跨元件接合，**不含行號**。

| 分類 | 判定（語意 ID 配對後比較） | 動作 | 成本 |
|---|---|---|---|
| unchanged | 鏈結構同、行號同 | 不動 | 0 |
| moved | 鏈結構同、只有行號漂 | `reanchor` 機械改寫敘述裡的 `:N` 引用 | 0 |
| changed | 副作用／步驟／emit 接合變了 | LLM 重寫該章 → verify | token |
| added | 新 entry 成為流程 | LLM 新寫 → verify | token |
| removed | entry 消失 | 歸檔下架、列入變更頁 | 0 |

moved 佔日常 commit 的絕大多數——這是平常一圈幾乎不花 token 的原因。

**總覽的二層連動**：域內任何 changed / added / removed → 該域篇章總覽重寫；
任一域總覽變了 → 全站總覽重寫。token 成本止於此。

## 語意 ID——整個閉環的地基（**已實作**，見 DECISIONS D10）

entry id 為 `檔案#標籤.事件@handler`，不含行號；行號降級為 payload。
crosscut 用 label（守衛名／攔截器階段）、ROUTE 用 path。完全撞名者以文件順序加 `~2`
（實測 mPHR 9.1% 需要）。`flow-chains.json` 另記 `analyzer.representation`
與目標 repo 的 commit／dirty，供早退比對與升版圈判斷。

135 份手冊已遷移完畢（含 67 個 `covers:` 條目），零孤兒。

仍待處理：**檔案搬移**——diff 前先跑 git rename 偵測重映射路徑，
避免單純搬檔被誤判成大量 removed＋added。

## 防呆三件

1. **verify 個別 fail 不擋整輪。** 重寫後驗證不過的章節，把違規餵回重試至多 2 次，
   仍紅就降級為「分析已更新、敘述待補」（site 本來就容忍此狀態）並進待人工佇列。
   寧可少一章敘述，**絕不部署驗證不過的內容**。
2. **熔斷器。** diff 顯示需重寫章數超過門檻（預設 30，可調）——典型是資料夾改名、大重構——
   整輪停下、出報告、等人工核可再燒 token。
3. **狀態存在 git。** 每圈結束把 manuals＋chains.json commit 回該目標的手冊 repo（見下節）：
   回滾＝revert，歷史可稽核。**採 PR 模式**——每圈開 PR、人審後 merge 才部署站台；
   純 moved 的輪次（0 token、無 LLM 產出）自動合併。細節見〈容器化〉。

## 多目標與資料存放：工具與資料分離（**已實作**，見 DECISIONS D9）

flow-doc 是工具，不綁定單一目標；`C:\project` 下有二十幾個前端 repo。
單目標時期把分析輸出與 manuals 放在工具 repo 根目錄，多目標會互相覆蓋，而且手冊的
版本歷史會跟工具的版本歷史攪在一起。

**一個 monorepo 裝所有目標的手冊**（`C:\project\flow-manuals`），flow-doc 回歸純工具：

| 放哪 | 內容 |
|---|---|
| flow-doc（工具 repo） | `src/`、`fixtures/`、`templates/`、flow-manual skill（源）、plan／DECISIONS／LOOP |
| `flow-manuals/<目標名>/` | `flow-doc.config.json`、baseline `flow-chains.json`、`packets/`、`manuals/`、`LIMITATIONS.md`（目標實例數字屬於該專案，不屬於分析器）、生成的 `site/` |
| `flow-manuals/.claude/skills/` | flow-manual 的複本，所有目標共用一份 |

手冊 repo 內的版控判準是**再生成本與確定性**：

- `manuals/`（含 overviews）——**必須 commit**。整條管線唯一「貴且不可確定性再生」的產物
  （LLM token＋人審），也是閉環的狀態本體：diff baseline、PR 模式、稽核、revert 全靠它。
- baseline `flow-chains.json`——commit（metadata 待補 analyzer 版本＋目標 commit hash）。
- `packets/`——commit：14 秒可再生，但 PR 審查時 packet diff 是人讀得懂的變更依據。
- `site/`、`flow-entries.json`、log——不 commit，純 build artifact。900 頁生成 md
  進版控會淹沒 PR diff，人審該看的是 manuals 的變更。

CLI 已支援：設定檔 `--config` > CWD > 目標 repo 根；目標 repo 命令列 > `FLOW_DOC_TARGET`
> 設定檔 `target`（相對設定檔目錄解析，手冊 repo 可整個搬家）。日常操作是
`cd flow-manuals/<目標> && flow-doc trace`；**CI 與容器用 `FLOW_DOC_TARGET` 覆寫**——
checkout 路徑與掛載佈局每次都可能不同，但不該汙染版控中的設定檔。

**不做 pnpm workspace**：`site/` 是 gitignore 的生成目錄，workspace glob 指向生成物很脆弱；
各 site 獨立 `pnpm install` 即可。

閉環的 baseline／lockfile／排程逐目標實例化，一個目標一條 pipeline。

邊界註記：analyzer 的 entry 偵測與 SFC 處理是 **Vue 3＋TS 專用**。其他 Vue 前端專案
覆寫 config（follow 白名單、crosscut、aliases）即可上；React 或後端 repo 需要新的
entry 偵測器——plan.md 原本的後端 entry 特徵到那時才用得上。

## 兩種觸發：日常圈與升版圈

| 觸發源 | 性質 | 走法 |
|---|---|---|
| 目標 repo（mPHR_Frontend）的 main | 程式行為變了 | 日常增量圈（上圖） |
| flow-doc 自己的 main | **表示法**變了（analyzer／SKILL 硬規則／verify 規則） | 升版圈 |

analyzer 規則一改，diff 會把幾百條流程誤報成 changed——行為沒變、表示法變了。
所以 **baseline 的 chains.json metadata 要記 analyzer 版本**，diff 起手先比版本：
相同 → 日常圈；不同 → 不走 diff 分流，全量重生＋人工核可
（或確認表示法變更不影響敘述後只做 reanchor），完成後恢復日常圈。
多目標時，升版圈要逐手冊 repo 各跑一遍。

## 觸發機制：排程喚醒＋baseline 比對（pull 式）

不用 push 事件：每天 N 圈各燒一次 token；nightly 把一整天 commit 壓縮成一次 diff，
中間狀態不用寫敘述；白天跑到一半的 feature 不會被寫成半成品手冊部署。
不用常駐 session 自我循環（`/loop` 類）：要求 session 整天掛著等一天一次的事件，
重啟即斷、無 CI 級稽核紀錄。

- chains.json 記 baseline commit hash；醒來 `git fetch` 比對，沒動 1 秒退出
  （連 trace 都不跑），動了才跑圈。
- lockfile 防重入——重複喚醒也安全，整圈冪等。
- `workflow_dispatch` 型手動觸發要保留：release 前立即刷新、升版圈都不等 nightly。

| 階段 | 觸發 | LLM 那一步 |
|---|---|---|
| 現在就能跑 | Windows 工作排程器 nightly | `claude -p` headless 跑 flow-manual skill（skill 與 verify 都現成） |
| 目標形態 | CI `schedule:` cron＋手動觸發（self-hosted runner，程式碼不出境） | `narrate --llm=api`，verify 驗收，產出開 PR |

選 CI 的理由不是觸發能力（與本機排程等價），是周邊白送：執行歷史、secrets、
失敗通知、artifacts、PR 整合。設計刻意不耦合平台——GitHub Actions／Azure DevOps／
GitLab 的 scheduled pipeline 同構。

## 容器化：兩個服務，PR 模式

批次與服務是**兩個生命週期完全不同的東西**，不能塞進同一個容器：

| 服務 | 生命週期 | 做什麼 |
|---|---|---|
| `loop`（批次） | `restart: no`，跑完退出 | 分析 → diff → 產敘述 → 開 PR |
| `web`（長駐） | `restart: always` | nginx 服務靜態站，24h 開著 |

兩者用**具名 volume** 交換站台產物。不可以邊 build 邊服務同一個目錄——
build 到暫存目錄再原子換版，否則使用者會讀到半套站。

**compose 不排程。** 它只定義服務；排程是外部的——host 排程器呼叫
`docker compose run --rm loop`，或 CI 排程、compose 只提供 runner 映像。

### 三個掛載，權限不同

| 對象 | 做法 | 為什麼 |
|---|---|---|
| flow-doc（工具） | **烤進映像檔**，不 runtime 拉取 | 映像檔 tag ＝ analyzer 版本。runtime 拉會讓表示法每晚可能靜默改變，把「升版圈」變成天天意外發生 |
| 目標 repo | 掛載 **read-only**（`:ro`） | 分析器只讀不寫，這是能被強制執行的安全性質 |
| flow-manuals | read-write（或容器內 clone + push） | 唯一需要寫入的東西 |

**路徑用 `FLOW_DOC_TARGET` 覆寫**，不要動版控裡的 `target` 欄位——設定檔的相對路徑
是照 host 佈局寫的，容器掛載佈局不同就會指錯。忘了設會直接報
「找不到目標 repo：…（來源：config）」，不會靜默分析錯東西。

**兩組憑證進 secret**：git identity＋push 憑證（commit 那步）、LLM API key（narrate 那步）。
這是容器化真正新增的複雜度。

**node_modules 要一致。** 分析器不需要目標的依賴（`createAnalysisProgram` 刻意不用目標
tsconfig，模組解析靠 `baseUrl`＋alias；`fixtures/mini-vue` 完全沒有 node_modules 也能追完整條鏈）。
但**有裝與沒裝，「解析不到定義」的計數會不同**，那個數字寫在封包標頭裡，會造成
packet diff → 觸發不必要的重寫。流程分類不受影響，但 diff 會有雜訊。
現有 baseline 是在有 node_modules 的環境產生的，容器直接掛整個目標 repo 最省事；
若改走乾淨 checkout，記得重新產一次 baseline 當新起點。

### 一圈的實際順序

```
排程觸發（host 排程器 / CI）
  └─ docker compose run --rm loop        ← 先取 lockfile，防重入
       1. fetch 目標 repo（:ro）、clone flow-manuals（要完整歷史，之後要 commit）
       2. 比對 baseline commit hash ── 沒動 → 直接退出，連 trace 都不跑
       3. flow-doc trace + pack            ← diff 的前提：先有新分析結果才能比
       4. flow-doc diff：五分類 + 熔斷 + analyzer 版本比對
            moved   → reanchor（0 token）
            changed → LLM 重寫 → verify（重試 2 次，仍紅則降級待人工）
            added   → LLM 新寫 → verify
            removed → 歸檔
       5. commit manuals + 新 baseline → push branch → 開 PR
                                          ← 缺這步閉環就斷：下一輪沒有 baseline，
                                            全部流程會被判成 added，每晚重寫整本手冊
  ── 人審 PR ──
  └─ merge 後觸發：flow-doc site → vitepress build → 原子換版到共用 volume
```

### PR 模式（定案）

**站台部署掛在 merge 之後，不掛在批次結束。** 理由是 verify 擋得住引用造假與漏寫
副作用，**擋不住「引用全對但語意寫歪」**——醫療業務手冊被當成事實依據使用，
這個殘餘風險要用人審補，這也是本閉環與全自動 wiki 在可信度上的分界線。

折衷讓日常不卡人：**純 moved 的輪次自動合併**（0 token、只機械改行號、無 LLM 產出，
verify 全綠即可放行），**有 LLM 產出的輪次才走人審**。多數輪次因此仍是全自動，
只有真的動到敘述時才叫人。跑順之後再逐步放寬。

PR 描述直接用「本次變更頁」的內容（見下節），審查者一眼看到這一版動了哪些業務流程。

## 副產品：本次變更頁

diff 結果直接產出站上「本次變更」頁：這一版動了哪些業務流程、哪幾章待補。
等於**從程式碼自動生成的業務層 release notes**，QA 拿這頁對版本驗收。

## 待建元件與順序

現成：`trace`／`pack`／`site`／`verify`（含 exit code，天生 CI gate）、CLI 的 `bin`
與設定解析、每個目標自帶設定的手冊 repo（D9）、**語意 ID 與 baseline metadata（D10）**。
缺四件，依序：

1. `flow-doc diff`——五分類＋熔斷判定＋analyzer 版本比對＋git rename 偵測。
   **必須比「新 chains vs 舊 baseline chains」，不可比「chains vs manuals」**：
   901 條流程只有 226 條寫了敘述，拿 manuals 當基準會把 675 條沒寫過的判成 added，
   第一輪就想寫 675 章、直接撞熔斷。閉環的職責是**維護已寫的敘述，不主動補寫沒寫的**——
   補寫是獨立的人為工作。
2. `flow-doc reanchor`——moved 章節的行號機械改寫
3. `flow-doc narrate --llm=api`——SKILL.md 硬規則轉 API prompt，verify 當驗收關
4. CI／容器 wiring——loop 與 web 兩個服務、lockfile、PR 模式與自動合併判定
   （每個目標一條 pipeline 實例）

## 成本輪廓與殘餘風險

- 平常一圈：多數分類是 moved，0 token；動行為的 commit 才花，
  且集中在 changed／added 的章節與其連動總覽。
- 殘餘風險要誠實面對：verify 擋得住引用造假與漏寫副作用，
  **擋不住「引用全對但語意寫歪」**——這是保留 PR 人審／定期抽查的理由，
  也是本閉環與全自動 wiki 在可信度上的分界線。
