# 交接：閉環 wiring 已完成，剩憑證、runner 與推送

CI／容器 wiring **做完並在本機驗證過**（設計見 [LOOP.md](LOOP.md)，決策理由見
[DECISIONS.md](DECISIONS.md) D14）。這份只記文件裡沒有的「現場狀態」。

## 現在到哪了

| 元件 | 狀態 |
|---|---|
| `trace`／`pack`／`site`／`verify`／`diff`／`reanchor`／`narrate` | 可用（前一輪交接的狀態不變） |
| `flow-doc loop`（狀態機＋佇列＋PR 模式） | **可用**；e2e 驗證：早退 0.93s、一圈 18s、佇列重試、PR 分支推送 |
| `Dockerfile`＋compose（loop／publish／web） | 可用；publish→nginx 全路徑**已在 clone 模式下重跑並驗證**（968 頁、原子換版、中文路徑 200、換版後 nginx 免重啟跟上、releases 只留 3 版） |
| repo 由容器 clone（D15，唯一模式） | entrypoint 的 git／install 邏輯本機實測過；**未對真實遠端 repo 跑過完整一圈** |
| GH Actions workflows（flow-manuals repo） | **已寫好、未在 GitHub 上跑過**（需要 runner 與 secrets） |
| narrate 線上實測 | 生成路徑**已通**——沒有 API key 時自動走 Claude Code 訂閱（D16）。**容器內**（`WITH_SUBSCRIPTION=1` image）煙霧測試通過：4.9s、內容正確、`stop_reason: end_turn`。但**還沒真的寫過一章手冊** |

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
- **相對 bind mount 遇上 GitOps 部署會靜默失效**（`./scripts/nginx.conf` 已改成烤進
  `scripts/Dockerfile.web`）。Portainer 之類的工具把 repo clone 到**自己容器內**的
  `/data/compose/<id>`，而 bind 來源是 **host 上的 daemon** 解析的——除非 `/data`
  剛好 bind 在 host 同名路徑（使用者的是 named volume，即壞的那側），daemon 找不到
  來源時會**建一個空目錄頂上去而不報錯**，nginx 於是服務預設歡迎頁。
  鑑別診斷：`/overview`（無副檔名）若 404、`/` 若是歡迎頁，就是設定檔沒讀到。
- **compose project name 決定 volume 前綴，而 GitOps 工具取的是 stack 名稱**——
  同一份 compose 兩邊部署會各自建一顆，publish 寫一顆、web 讀另一顆，站台永遠空的
  且不報錯。三顆 volume 的名字因此都已釘死（`flow-doc_*`），與 project 無關。
  跨 project 驅動 publish 時 compose 只多印一行警告，仍正常掛上（實測）。
- **`depends_on` 不會自動啟用 profile**（實測）——指到 `profiles: [batch]` 裡的服務時，
  那個服務會被**整個跳過且不報錯**，`required: false` 讓它連警告都沒有。所以 publish
  必須留在 profile 外，web 才等得到它。`loop` 則刻意留在 profile 裡：`up -d` 碰不到它。
- **`required: false` 是站台可用性的保險，不能拿掉**。少了它，publish 失敗會讓 web
  起不來——本來只是內容沒更新，變成整個站掛掉。原子換版本來就是為了解耦這兩件事。
- **訂閱路徑每次呼叫固定扛約 17.6k token 的 harness 系統提示**（實測 `cacheWrite: 17604`，
  而 user prompt 只有 2 token）。`allowedTools: []` 與 `settingSources: []` 都設了也一樣——
  那是 Agent SDK 自己的 harness prompt，不是我們的。訂閱模式下花的是額度不是錢，但
  估算一輪要燒多少額度時要把它算進去（每章一次）。改走 API 計費時這筆會變成實際費用。
- **Git Bash 會把 URL 裡的中文轉成 Big5 再送出**（access log 看到 `%A5%FE%B0%EC`
  而非 UTF-8 的 `%E5%85%A8`），在 host 上用 curl 測中文路徑會**假性 404**。
  要測就從容器內發（`docker run --network flow-doc_default … curl http://web/…`），
  檔名直接取自 volume，不讓 host 的編碼介入。
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

# 容器：全新機器只要填好 .env，這一行就到位
docker compose up -d          # build → bootstrap（開 PR，已有 baseline 就跳過）
                              # → publish（建站＋原子換版）→ web 開站
                              # 之後只剩「合併 bootstrap 那個 PR」需要人

# 個別動作（up 不會碰 loop——它在 profiles: [batch] 裡，開 PR 燒額度是排程器的事）
docker compose run --rm loop --dry-run          # 預演一圈
docker compose run --rm loop --pr               # 真跑（容器裡一律用 --pr）
docker compose run --rm loop bootstrap --force  # 手動重建 baseline（換分析環境時）
docker compose run --rm publish                 # 只重建站台
docker compose up -d --no-deps web              # 只重啟站台，不觸發整條鏈
```

容器裡不帶 `--pr` 的話 loop 只會在 volume 裡 commit，沒有人看得到。

上面這些都有對應的 npm script（`pnpm docker:bootstrap`、`docker:loop`、`docker:publish`
…完整清單見 `package.json`）。另有 `docker:shell`（跳過 entrypoint 進容器翻 volume）
與 `docker:reset`（`down -v`，砍掉三顆 volume 重來——clone 與 install 都要重跑）。

exit code：0 完成或早退 · 1 錯誤 · 2 需人工（升版圈／熔斷）· 3 這輪沒跑（鎖／dirty／缺 generated 檔）。

## TODO：兩個 scheduler 服務（已定案，未實作）

`up -d` 解決的是**啟用**，不是**日常觸發**。日常那兩件事現在還沒有人做：

| 要觸發什麼 | 何時 | 現況 |
|---|---|---|
| `loop` 跑一圈 | 每晚 | 無 |
| `publish` 重建站台 | 手冊 repo main 前進之後 | 無 |

第二項的缺口在 2026-08-07 實地出現過：07:23 publish 跑完；07:50 一輪 loop 推出 PR #6
「機械改寫 2 章」；**07:51 它自動合併**（純 moved 輪次，`autoMergeEligible`），main 前進；
publish 不知道，站台就這樣悄悄過期。**人完全沒介入也會發生**——所以不能靠「合併時順手跑」。

**定案做法：兩個服務，都用 `restart: always`。** 節奏與 volume 都不同，分開才不會互相拖累。

- `scheduler-loop`：每晚 `LOOP_AT`（預設 03:00）跑 `flow-doc-entrypoint loop --pr`。
  掛 `workspace` volume。**要包 `timeout`**——一輪卡住就再也不會有下一輪。
- `scheduler-publish`：每 `PUBLISH_POLL_SECONDS`（預設 300）比對一次
  `git ls-remote <manuals> refs/heads/main` 與**上次成功發布的 SHA**，不同才跑 publish。
  掛 `publish-workspace` ＋ `site-dist`。

實作放 `scripts/scheduler.sh` 烤進映像（不要塞進 compose 的 command 字串，會難維護）。

三個已驗證的前提與一個坑：

- `git ls-remote` 在容器裡 **0.94s、不需要 clone**，poll 幾乎零成本。
- 覆蓋自動合併與人審合併**同一個機制**——不管 main 怎麼前進，poll 都看得到。
- 走 pull 不走 webhook：不必開對外埠、不必保管「誰拿到誰就能觸發部署」的 URL，
  而且與 LOOP.md〈觸發機制：排程喚醒＋baseline 比對〉同構。Portainer stack webhook
  是可行的替代（實測重複 `up -d` 不會重建 web、站台零中斷），但要 GitHub 連得進來。
- **⚠ 比對對象必須是「上次成功發布的 SHA」，不能用工作區 HEAD。** entrypoint 是先
  fetch＋快轉、才 vitepress build；build 失敗時 clone 已經前進，用 HEAD 比對會誤判成
  「已發布」，站台永遠停在舊版直到下次有人合併。stamp 只在 publish 成功後才寫。

另一個可選項（沒做，要先問過使用者）：`BOOTSTRAP_PUSH_TO_MAIN=1` 讓 bootstrap 直接推
main 而不開 PR。那樣全新機器就真的零人工，但拿掉的是一個上千封包 commit 的審查閘。

## 已知待處理（不阻塞）

- 9 份 Form 域手冊 verify 不過（既有內容問題）；loop 只在動到它們時才會標進佇列。
- `tmep` commit 訊息錯字，使用者明確表示不動。
- LOOP.md 尚未定案兩項：redirect 路由、334 個 ROUTE entry 未被使用。
- **站台目前落後 main**（差 PR #6 那兩章）——跑一次 `docker compose run --rm publish` 即可。

## 下個 session 可能用得到的 skill

- `claude-api` — 只要碰 `src/llm.ts` 或 narrate 的 API 參數就**必須**先載入（這輪沒碰）。
- `update-config` — 若要把 Windows 工作排程器接成本機 nightly。
