# flow-doc

從 TypeScript / Vue 程式碼庫追蹤業務流程的執行路徑，產出以「系統流程」為主軸的手冊。

不同於元件相依性文件回答「這個模組是什麼」，這個工具回答**「使用者做了 X，系統依序發生了什麼」**。
核心能力是 call chain tracing，不是 dependency graph。

目標專案是 [mPHR_Frontend](file:///C:/project/mPHR_Frontend)（Vue 3 + TS + Pinia）。
設計決策與其理由記在 [DECISIONS.md](DECISIONS.md)，分析看不到的東西記在 [LIMITATIONS.md](LIMITATIONS.md)。

## 管線

```bash
pnpm dev trace C:/project/mPHR_Frontend    # 分析 → flow-chains.json
```

```bash
pnpm dev site --manuals manuals --title "業務流程手冊"    # → site/
```

五個指令，前四個是確定性的、可單元測試；只有手冊敘述那一步用 LLM。

| 指令 | 做什麼 |
|---|---|
| `entries` | 掃 entry point 候選（UI 事件、生命週期、路由） |
| `trace` | 從 entry 出發 DFS 追呼叫鏈，解析副作用與跨元件連結 |
| `pack` | 把每條鏈序列化成自足的 Markdown 封包，供 LLM 撰寫敘述 |
| `site` | 產生 VitePress 站台 |
| `verify` | 檢查生成的敘述沒有幻覺 |

撰寫敘述用 `.claude/skills/flow-manual`：讀 `packets/*.md`，寫進 `manuals/<entryId slug>.md`。

## 預覽站台

站台目錄自帶依賴，與分析器完全分離（vitepress 綁 vite 5、vitest 需要 vite 6+，
裝在同一個 package 會打架）：

```bash
cd site && pnpm install && pnpm dev
```

## 目前規模

對 mPHR_Frontend（753 SFC / 371 TS / 196k 行）：

- **902 條業務流程**：寫入型 339、查詢型 563
- **510 支後端端點**，可反查每支被哪些流程使用
- **5 條全域前置**：axios 攔截器與路由守衛管線
- 全 repo 分析約 14 秒

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
