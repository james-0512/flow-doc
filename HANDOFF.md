# 交接：下一步是 CI／容器 wiring

閉環的**指令全部做完了**，只剩把它們串成自動化。設計不必重想——
[LOOP.md](LOOP.md) 的〈容器化：兩個服務，PR 模式〉已經定案到可以照做的程度，
各決策的理由在 [DECISIONS.md](DECISIONS.md) D9–D13。這份只記那兩份文件裡沒有的、
屬於「現場狀態」的東西。

## 現在到哪了

| 元件 | 狀態 |
|---|---|
| `trace` / `pack` / `site` / `verify` | 可用 |
| `diff`（五分類＋熔斷＋版本比對＋git rename） | 可用，真實 commit 區間驗證過 |
| `reanchor`（moved 的 0-token 路徑） | 可用，端到端驗證過 |
| `narrate`（唯一花 token 的一步） | **程式完成、線上未實測**（見下方「唯一的缺口」） |
| CI／容器 wiring | **未做——這是下一步** |

`flow-doc` 領先 origin **4 個 commit**，`flow-manuals` 領先 **3 個**。
兩邊都沒推——推送要先問過使用者。

## 唯一的缺口：narrate 沒有線上實測過

這台機器沒有任何 Anthropic 憑證（無 `ANTHROPIC_API_KEY`、無 `ant` CLI、無 profile），
所以 `narrate` 只驗到 API 邊界為止：diff 正確挑出章節、找到封包、建好 prompt，
然後在憑證處停下。重試／驗證迴圈本身有 14 個離線測試覆蓋。

設好憑證後這樣測（**不要**直接寫進真實 manuals，先導到副本）：

```bash
cd C:/project/flow-manuals/mPHR_Frontend && flow-doc narrate <baseline.json> --dry-run
```

沒有真實 commit 差異時，可以自己造一個「主體改了但結構沒變」的 baseline：
複製 `flow-chains.json`，把某條**有敘述**的流程的 `sourceHash` 改掉、`target.commit`
改成別的值，diff 就會把它列為 changed。

## 環境上的坑（都踩過了，別再踩一次）

- **CLI 還沒 link**：`pnpm setup` 會改使用者 PATH，所以沒做。目前一律用
  `node <flow-doc>/dist/cli.js …` 呼叫。要 link 是使用者自己的決定。
- **改完 `src/` 一定要 `pnpm build`**：手冊 repo 跑的是 `dist/`，忘了 build 會用到舊行為。
- **拿舊 commit 做測試要用 `git worktree`**，不要 checkout 使用者的工作目錄。
  而且 worktree 需要補兩樣東西，否則分析結果不可比：
  `node_modules`（用 junction 連過去）與 `src/components.d.ts`（generated、不進版控，
  少了它同一個 commit 的流程數會從 901 變 940）。
- **`flow-doc/site/` 是個刪不掉的空目錄**（被某個程序佔用）。已 gitignore，無害。

## 已知待處理（不阻塞 wiring）

- **9 份手冊 verify 不過**，全在 Form 域，引用了封包從未提供的位置
  （多為 `src/api/form.ts` 的函式定義行）。屬既有內容問題，不是這輪造成的；
  第一次真實輪次會被標記待人工。
- `tmep` 那個 commit 訊息打錯字，使用者明確表示不動。
- LOOP.md 尚未定案的兩項：redirect 路由、334 個 ROUTE entry 未被使用。

## 下一步建議的順序

照 LOOP.md〈一圈的實際順序〉實作，但**先做不花錢的那半**：

1. 先寫 loop 腳本的骨架（lockfile、baseline commit 比對早退、trace→pack→diff），
   在本機用真實 repo 跑一輪 dry-run——這段完全不需要憑證與容器
2. 再加 reanchor 分支（0 token，可以放心自動跑）
3. 最後才是 narrate 分支、PR 模式、compose 雙服務

**動工前先確認一件事**：目標 repo 的 codegen（產 `components.d.ts` 的那個指令）
在容器裡要怎麼跑。這是 LOOP.md 標為「會讓第一輪滿江紅」的前置，
但實際指令是什麼還沒查過。

## 下個 session 可能用得到的 skill

- `update-config` — 若要把 nightly 排程接成 hook 或設定 env
- `tdd` — loop 腳本的狀態機（早退、熔斷、降級）適合先寫測試
- `claude-api` — 只要再碰 `src/llm.ts` 或 narrate 的 API 參數就**必須**先載入，
  不要憑印象改（model id、thinking、effort、fallbacks 的形狀近期都變過）
