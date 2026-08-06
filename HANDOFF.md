# 交接：閉環 wiring 已完成，剩憑證、runner 與推送

CI／容器 wiring **做完並在本機驗證過**（設計見 [LOOP.md](LOOP.md)，決策理由見
[DECISIONS.md](DECISIONS.md) D14）。這份只記文件裡沒有的「現場狀態」。

## 現在到哪了

| 元件 | 狀態 |
|---|---|
| `trace`／`pack`／`site`／`verify`／`diff`／`reanchor`／`narrate` | 可用（前一輪交接的狀態不變） |
| `flow-doc loop`（狀態機＋佇列＋PR 模式） | **可用**；e2e 驗證：早退 0.93s、一圈 18s、佇列重試、PR 分支推送 |
| `Dockerfile`＋compose（loop／publish／web） | 可用；但 publish→nginx 那次全路徑驗證（950 頁、原子換版、中文路徑 200）是**掛載模式**跑的，該模式已移除（D15），clone 模式下**還沒重跑** |
| repo 由容器 clone（D15，唯一模式） | entrypoint 的 git／install 邏輯本機實測過；**未對真實遠端 repo 跑過完整一圈** |
| GH Actions workflows（flow-manuals repo） | **已寫好、未在 GitHub 上跑過**（需要 runner 與 secrets） |
| narrate 線上實測 | 生成路徑**已通**——沒有 API key 時自動走 Claude Code 訂閱（D16），本機實測回得了內容；但**還沒真的寫過一章手冊** |

flow-doc 領先 origin 數個 commit、flow-manuals 領先 1 個（CI wiring）。
**兩邊都沒推——推送要先問過使用者。**

## 啟用閉環還缺的四件事（都在使用者手上）

1. **Anthropic 憑證**。設好後先照舊測 narrate（不要直接寫真實 manuals，先 `--dry-run`）；
   loop 那條路即使沒憑證也會收尾，欠的章節在 `pending.json`，補上憑證後下一輪自動補寫。
   **本機原生**沒 API key 也能跑——自動退回這台機器的 Claude Code 訂閱（D16）。
   **容器**預設要 `ANTHROPIC_API_KEY`（image 不裝那個 267 MB 的 binary，425 MB）。
   本機容器也想走訂閱的話：`claude setup-token` ＋ `.env` 設
   `WITH_SUBSCRIPTION=1` 與 `CLAUDE_CODE_OAUTH_TOKEN`，重建 image（702 MB）。
   ⚠ 訂閱那條路只限自己的機器、自己的登入、自己用——共用 CI 或給同事跑不行。
2. **一台跑得動 Docker 的機器**（Windows 也行了——D15 之後 node_modules 在容器內裝，
   不再有 junction 斷鏈問題）＋ `.env` 填 `TARGET_REPO_URL`、`MANUALS_REPO_URL`、`GH_TOKEN`。
   走 GH Actions 的話仍需 self-hosted runner（label：`self-hosted, linux, flow-doc`）與
   secrets `ANTHROPIC_API_KEY`、`FLOW_DOC_PAT`（PAT，別用 GITHUB_TOKEN——它合併的 PR
   不觸發 publish workflow）；runner 上 `docker build -t flow-doc:latest <flow-doc>` 一次。
   ⚠ flow-manuals repo 裡的兩個 workflow 還寫著已移除的 `TARGET_REPO_PATH` 掛載模式，
   **要改**（那兩個檔在**另一個 repo**，這輪沒動）。
3. **在容器內重做一次 baseline**：`docker compose run --rm loop bootstrap`
   （既有 baseline 是別的環境產的，要加 `--force`）。它會 trace＋pack、開一個
   `bootstrap/<目標>/<時戳>` 分支並開 PR，**合併之後** loop 才有比對基準。
   跳過這步的話第一輪必定被熔斷器擋下——那是設計，不是 bug，見 D15。
4. **推送兩個 repo**，nightly 就會開始跑。

## 這輪學到的坑（新增的，舊坑見 git 歷史裡上一版 HANDOFF）

- **Windows host 掛目標 repo 進 Linux 容器會滿江紅**：pnpm junction 斷鏈 → pinia 型別
  解析全失效 → 941/1894 條鏈樹形改變。熔斷器正確擋下（它的第一次真實出動）。
  結論：baseline 必須與分析環境同源（細節與 platform metadata 見 D14）。
  **D15 之後這條坑消失了**——clone 與 install 都在容器內，host 平台不再影響分析環境。
- **`flow-doc site` 沒帶 `-m manuals` 會產出沒有敘述的骨架站**，而且很安靜——
  entrypoint 的 publish 模式已寫死這個參數，手動跑 site 時別忘。
- e2e 測試要 clone 手冊 repo 到**短路徑**（如 `%TEMP%\fdle`）：語意 ID 檔名很長，
  scratchpad 深路徑會撞 Windows 260 字元上限。
- e2e clone 的 origin 指向使用者真實的 flow-manuals——測 `--pr` 前**必須**先
  `git remote set-url origin <臨時 bare repo>`，否則測試分支會推進真 repo。

## 快速指令

```bash
# 本機跑一圈（在 flow-manuals/mPHR_Frontend 下；Windows 用原生 node）
node <flow-doc>/dist/cli.js loop --dry-run     # 預演
node <flow-doc>/dist/cli.js loop               # 真跑（本地 commit，不推）
node <flow-doc>/dist/cli.js loop --pr          # PR 模式（要 push 權限與 gh）

# 容器（.env 填好 *_REPO_URL 之後；Windows 也能跑 loop 了）
docker compose run --rm loop bootstrap                         # 只做一次：建 baseline
docker compose run --rm loop --dry-run                         # 預演一圈
docker compose run --rm loop --pr                              # 真跑（容器裡一律用 --pr）
docker compose run --rm publish && docker compose up -d web    # http://localhost:8080
```

容器裡不帶 `--pr` 的話 loop 只會在 volume 裡 commit，沒有人看得到。

上面這些都有對應的 npm script（`pnpm docker:bootstrap`、`docker:loop`、`docker:publish`
…完整清單見 `package.json`）。另有 `docker:shell`（跳過 entrypoint 進容器翻 volume）
與 `docker:reset`（`down -v`，砍掉三顆 volume 重來——clone 與 install 都要重跑）。

exit code：0 完成或早退 · 1 錯誤 · 2 需人工（升版圈／熔斷）· 3 這輪沒跑（鎖／dirty／缺 generated 檔）。

## 已知待處理（不阻塞）

- 9 份 Form 域手冊 verify 不過（既有內容問題）；loop 只在動到它們時才會標進佇列。
- `tmep` commit 訊息錯字，使用者明確表示不動。
- LOOP.md 尚未定案兩項：redirect 路由、334 個 ROUTE entry 未被使用。

## 下個 session 可能用得到的 skill

- `claude-api` — 只要碰 `src/llm.ts` 或 narrate 的 API 參數就**必須**先載入（這輪沒碰）。
- `update-config` — 若要把 Windows 工作排程器接成本機 nightly。
