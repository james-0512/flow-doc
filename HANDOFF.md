# 交接：閉環 wiring 已完成，剩憑證、runner 與推送

CI／容器 wiring **做完並在本機驗證過**（設計見 [LOOP.md](LOOP.md)，決策理由見
[DECISIONS.md](DECISIONS.md) D14）。這份只記文件裡沒有的「現場狀態」。

## 現在到哪了

| 元件 | 狀態 |
|---|---|
| `trace`／`pack`／`site`／`verify`／`diff`／`reanchor`／`narrate` | 可用（前一輪交接的狀態不變） |
| `flow-doc loop`（狀態機＋佇列＋PR 模式） | **可用**；e2e 驗證：早退 0.93s、一圈 18s、佇列重試、PR 分支推送 |
| `Dockerfile`＋compose（loop／publish／web） | **可用**；publish→nginx 全路徑驗證過（950 頁、原子換版、中文路徑 200） |
| GH Actions workflows（flow-manuals repo） | **已寫好、未在 GitHub 上跑過**（需要 runner 與 secrets） |
| narrate 線上實測 | **仍未做**——這台機器依舊沒有任何 Anthropic 憑證 |

flow-doc 領先 origin 數個 commit、flow-manuals 領先 1 個（CI wiring）。
**兩邊都沒推——推送要先問過使用者。**

## 啟用閉環還缺的三件事（都在使用者手上）

1. **Anthropic 憑證**。設好後先照舊測 narrate（不要直接寫真實 manuals，先 `--dry-run`）；
   loop 那條路即使沒憑證也會收尾，欠的章節在 `pending.json`，補上憑證後下一輪自動補寫。
2. **Linux self-hosted runner**（label：`self-hosted, linux, flow-doc`）＋ repo 設定：
   變數 `TARGET_REPO_PATH`（runner 上目標 repo 的 mirror clone 路徑）、
   secrets `ANTHROPIC_API_KEY`、`FLOW_DOC_PAT`（PAT，別用 GITHUB_TOKEN——它合併的 PR
   不觸發 publish workflow）。runner 上 `docker build -t flow-doc:latest <flow-doc>` 一次。
3. **推送兩個 repo**，nightly 就會開始跑。

## 這輪學到的坑（新增的，舊坑見 git 歷史裡上一版 HANDOFF）

- **Windows host 掛目標 repo 進 Linux 容器會滿江紅**：pnpm junction 斷鏈 → pinia 型別
  解析全失效 → 941/1894 條鏈樹形改變。熔斷器正確擋下（它的第一次真實出動）。
  結論：baseline 必須與分析環境同源；Windows 機跑閉環用原生 node，容器只跑 publish／web。
  細節與對策（platform metadata＋警告）見 D14。
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

# 容器（Windows 上只用 publish／web；loop 要 Linux host）
docker compose run --rm publish && docker compose up -d web   # http://localhost:8080
```

exit code：0 完成或早退 · 1 錯誤 · 2 需人工（升版圈／熔斷）· 3 這輪沒跑（鎖／dirty／缺 generated 檔）。

## 已知待處理（不阻塞）

- 9 份 Form 域手冊 verify 不過（既有內容問題）；loop 只在動到它們時才會標進佇列。
- `tmep` commit 訊息錯字，使用者明確表示不動。
- LOOP.md 尚未定案兩項：redirect 路由、334 個 ROUTE entry 未被使用。

## 下個 session 可能用得到的 skill

- `claude-api` — 只要碰 `src/llm.ts` 或 narrate 的 API 參數就**必須**先載入（這輪沒碰）。
- `update-config` — 若要把 Windows 工作排程器接成本機 nightly。
