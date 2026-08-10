# flow-doc

從 TypeScript / Vue 程式碼庫追蹤業務流程的執行路徑，產出以「系統流程」為主軸的手冊。

不同於元件相依性文件回答「這個模組是什麼」，這個工具回答**「使用者做了 X，系統依序發生了什麼」**。
核心能力是 call chain tracing，不是 dependency graph。

**這裡只有工具。** 每個目標 repo 的設定、分析產出與手冊敘述住在該目標的手冊 repo
（`flow-manuals/<目標名>/`）——分析器改版與手冊內容改版是兩件事，版本歷史混在一起的話，
「這章敘述為什麼變了」會分不出是程式行為變了還是分析規則變了。
第一個目標是 mPHR_Frontend，資料在 `C:\project\flow-manuals\mPHR_Frontend`。

設計決策與其理由記在 [DECISIONS.md](DECISIONS.md)，閉環（手冊自動跟著 main 更新）的
閉環設計與現況記在 [LOOP.md](LOOP.md)（已實作）。新目標從 [templates/](templates/) 起步。

## 管線

一次性：`pnpm build && pnpm link --global`（若 pnpm 沒設過全域 bin 目錄，先跑一次
`pnpm setup`——它會改你的 PATH）。之後在手冊 repo 的目標目錄下裸命令即可：

```bash
cd C:/project/flow-manuals/mPHR_Frontend && flow-doc trace && flow-doc pack
```

不必給目標 repo 路徑：`flow-doc.config.json` 的 `target` 欄位指出去（相對設定檔目錄解析，
所以手冊 repo 整個搬家不用改設定）。優先序是**命令列參數 > `FLOW_DOC_TARGET` 環境變數 >
設定檔 `target`**；環境變數是留給 CI 的——checkout 路徑每次不同，但不該汙染版控中的設定檔。

五個指令，前四個是確定性的、可單元測試；只有手冊敘述那一步用 LLM。

| 指令 | 做什麼 |
|---|---|
| `entries` | 掃 entry point 候選（UI 事件、生命週期、路由） |
| `trace` | 從 entry 出發 DFS 追呼叫鏈，解析副作用與跨元件連結 |
| `pack` | 把每條鏈序列化成自足的 Markdown 封包，供 LLM 撰寫敘述 |
| `diff` | 比對 baseline 與本次分析，分成五類並算出要做的事 |
| `reanchor` | 把只有位置變動的敘述機械改寫到新位置（0 token） |
| `narrate` | 用 API 產出結構或主體變了的章節，verify 當驗收關 |
| `site` | 產生 VitePress 站台 |
| `verify` | 檢查生成的敘述沒有幻覺 |
| `loop` | 閉環一圈：早退比對 → trace → diff 分流 → 改寫 → verify → commit／PR |

`diff` 與 `reanchor` 是閉環的骨架（見 [LOOP.md](LOOP.md)）：多數 commit 只讓行號漂移，
那些章節不需要 LLM 重寫，機械改寫即可。`loop` 把整圈串起來——沒憑證也能跑
（該寫的章節進 `pending.json` 待補佇列），排程與容器見 LOOP.md〈容器化〉與
`docker-compose.yml`——兩個 repo 都由容器自己 clone，`.env` 只給 git URL。

撰寫敘述用 `.claude/skills/flow-manual`：讀 `packets/*.md`，寫進 `manuals/<entryId slug>.md`。
這份 skill 是「源」，各手冊 repo 的 `.claude/skills/` 有一份複本；改規則只改這裡，
再依 [LOOP.md](LOOP.md) 的升版圈同步過去。

`narrate` 是同一件事的無人值守版本——**system prompt 就是這份 SKILL.md**，
所以互動式與自動化用的是同一套硬規則，不會各自漂移。它需要 API 憑證
（`ANTHROPIC_API_KEY`，或 `ant auth login` 後的 profile）：

```bash
flow-doc narrate <baseline.json> --dry-run
```

先用 `--dry-run` 看要寫幾章、輸入約多少 token，再拿掉它實際跑；`--limit` 可限制單次章數。

## 預覽站台

站台目錄自帶依賴，與分析器完全分離（vitepress 綁 vite 5、vitest 需要 vite 6+，
裝在同一個 package 會打架）：

```bash
cd site && pnpm install && pnpm dev
```

**圖表點一下可放大**：複雜模組的序列圖寬到超出內文欄寬，mermaid 會等比縮進來，
字就看不清了（實測 2916px 寬的流程圖在內文只有 23%，標籤 6.5px）。點任一張圖開
全螢幕檢視——滾輪縮放、拖曳平移、雙指縮放、`0` 全景、`1` 原始大小、`Esc` 關閉。
這一層由 `site` 一併產出 `.vitepress/theme/`（內容見 `src/site-theme.ts`），
與 `site/` 其他檔案一樣是產生物，不要手改。

**全站骨架圖不是工具產的**，是 flow-manual skill 寫的：`overviews/00-全站.md` 裡的一張
Mermaid flowchart（路由切換 → 全域前置守衛 → 業務域操作 → API 攔截器 → 後端），
由 `site` 渲染成 `/overview`。`narrate` 不碰 `overviews/`，那一步刻意留給人跑 skill。
工具做過一版互動圖，比不上這個——理由與三次撞牆的過程記在 [DECISIONS.md](DECISIONS.md) D17。

## 規模參考

對 mPHR_Frontend（753 SFC / 371 TS / 196k 行）：901 條業務流程、503 支後端端點
（可反查每支被哪些流程使用）、16 條全域前置，全 repo 分析約 13 秒。
最新數字以該手冊 repo 的 README 為準——這裡的只是量級參考。

## 為什麼可信

手冊裡每一步都附 `file:line`，而 `verify` 做兩層檢查：

1. 引用的位置必須真實存在且行號在範圍內
2. 引用必須出現在該流程的封包內——擋掉「檔案存在、行號合法，但那一行不在這條流程上」
3. 反向檢查：封包裡標為寫入的副作用，敘述必須都提到

第三條是最容易被忽略的。只驗「多寫」不驗「漏寫」的話，一份悄悄少掉某支寫入 API 的手冊
會全綠通過，而讀者會據此以為那個副作用不存在。

## 開發

```bash
pnpm test && pnpm typecheck
```

`fixtures/mini-vue` 是端到端回歸基準——真實 repo 驗「有沒有用」，fixture 驗「有沒有壞」。
