#!/usr/bin/env bash
# 容器進入點三個模式：
#   loop       跑一圈（預設）
#   bootstrap  產生第一份 baseline（啟用閉環的第一步，只做一次）
#   publish    site build → 原子換版到共用 volume
# 環境變數契約見 docker-compose.yml；第一個參數後的東西全部轉交給底下的指令。
#
# repo 一律由這支腳本 clone／fetch 到常駐 volume（D15）。host 不需要先備好任何東西，
# 目標的 node_modules 也在容器內裝——分析環境因此不受 host 平台影響。
set -euo pipefail

# 第一個參數是模式，但只有在它不是旗標時才算——否則 `compose run --rm loop --pr`
# 會把 --pr 當成模式名而報「未知模式」。開頭是 - 的一律視為要轉交給底下指令的旗標。
MODE=loop
if [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then
  MODE="$1"
  shift
fi
# compose 把服務名之後的東西原封不動往容器傳，包括 `--` 本身；而 commander 把 `--`
# 當成「選項結束」標記，於是 `run --rm loop -- --pr` 會讓 --pr 掉進位置參數，
# 報「找不到目標 repo：…/--pr」。這裡把開頭的 `--` 吃掉，兩種寫法都能用。
if [ "${1:-}" = "--" ]; then shift; fi

# URL 在這裡擋而不在 compose 的 ${VAR:?} 擋：compose 是載入時檢查，擋了會連
# `docker compose up -d web`（根本用不到 URL）都跑不起來
: "${FLOW_MANUALS_DIR:?需要 FLOW_MANUALS_DIR（flow-manuals 的 clone 目的地）}"
: "${FLOW_DOC_TARGET_NAME:?需要 FLOW_DOC_TARGET_NAME（手冊 repo 內的目標目錄名，例如 mPHR_Frontend）}"
: "${MANUALS_REPO_URL:?需要 MANUALS_REPO_URL（flow-manuals 的 git URL）——填在 .env}"

# volume 裡的 repo 擁有者與容器內的 uid 不同時 git 會拒絕操作
git config --global --add safe.directory '*'
# 身份寫在容器的 global config（不汙染 clone 出來的 .git/config）
if [ -n "${GIT_USER_NAME:-}" ]; then git config --global user.name "$GIT_USER_NAME"; fi
if [ -n "${GIT_USER_EMAIL:-}" ]; then git config --global user.email "$GIT_USER_EMAIL"; fi
# 憑證：gh 讀 GH_TOKEN，setup-git 讓 git 走同一個 token。
# 位置在最前面是因為私有 repo 的 clone／fetch 也要它
if [ -n "${GH_TOKEN:-}" ]; then gh auth setup-git 2>/dev/null || true; fi

# ---------------------------------------------------------------------------
# 把 repo 準備到指定目錄。第一次 clone，之後 fetch＋快轉。
#
# 刻意**不做淺 clone**：diff 的改名偵測要 baseline..HEAD 的歷史（detectRenames），
# 歷史不夠時它回空表，改名會退化成 removed＋added——不報錯，只是多花 LLM 的錢。
#
# 快轉用 --ff-only 而非 reset --hard：loop 在非 PR 模式會在手冊 repo 留下本地
# commit 且不推，這時本地領先遠端，ff-only 是 no-op，不會把那些 commit 洗掉；
# 真的分岔了就停下來喊人，不自作主張。
# ---------------------------------------------------------------------------
prepare_repo() {
  local url="$1" ref="$2" dir="$3" label="$4"
  if [ ! -d "$dir/.git" ]; then
    echo "[prepare] clone $label：$url（$ref）→ $dir"
    mkdir -p "$dir"
    git clone --branch "$ref" "$url" "$dir"
    return
  fi
  echo "[prepare] fetch $label：$ref"
  git -C "$dir" fetch --prune origin
  git -C "$dir" checkout --quiet "$ref"
  if ! git -C "$dir" merge --ff-only "origin/$ref" >/dev/null; then
    echo "[prepare] $label 的 $ref 與 origin/$ref 分岔，無法快轉——需要人工處理" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# 目標 repo 的分析環境：依賴與 generated 檔。
#
# 這一步不能省。分析靠 node_modules 解析型別，少了它 pinia 這類「靠 node_modules
# 型別」的鏈全部走樣、熔斷器會擋下整輪（D14）；generated 檔缺了 loop 自己有閘擋
# （exit 3）。容器自己 clone 的價值也在這裡——install 在**容器內**做，node_modules
# 必然與分析環境同源，不會有 host 佈局漏進來的問題。
#
# 兩個指令都可用環境變數覆寫，設成空字串代表不做（用 ${VAR-default} 而非
# ${VAR:-default}：明確給空值時要真的當成「不做」）。
#
# ⚠ codegen 與 install 的產物必須被目標的 .gitignore 蓋住。「沒 commit」不夠——
#   untracked 檔在 `git status --porcelain` 裡也是一行，loop 會判定目標 dirty 而拒跑
#   （exit 3，訊息是「目標 repo 有未提交變動」）。mPHR 的 node_modules 與
#   src/components.d.ts 都在 .gitignore 裡，沒這問題；換目標時要確認這件事。
# ---------------------------------------------------------------------------
prepare_target_env() {
  local dir="$1"
  # stamp 放在 repo 外：放進去會變成 untracked 檔，git status --porcelain 看得到，
  # loop 會判定目標 dirty 而拒跑
  local stamp; stamp="$(dirname "$dir")/.flow-doc-install.stamp"
  local install="${TARGET_INSTALL_CMD-pnpm install --frozen-lockfile}"
  local codegen="${TARGET_CODEGEN_CMD-pnpm generate:components-dts}"

  if [ -n "$install" ]; then
    local key=""
    if [ -f "$dir/pnpm-lock.yaml" ]; then key="$(sha1sum "$dir/pnpm-lock.yaml" | cut -d' ' -f1)"; fi
    local prev=""
    if [ -f "$stamp" ]; then prev="$(cat "$stamp")"; fi
    if [ ! -d "$dir/node_modules" ] || [ "$prev" != "$key" ]; then
      echo "[prepare] 安裝目標依賴：$install"
      ( cd "$dir" && eval "$install" )
      printf '%s' "$key" > "$stamp"
    else
      echo "[prepare] lockfile 未變且 node_modules 在，跳過安裝"
    fi
  fi

  if [ -n "$codegen" ]; then
    echo "[prepare] 產生 generated 檔：$codegen"
    ( cd "$dir" && eval "$codegen" )
  fi
}

# 手冊 repo 兩種模式都要（loop 寫它、publish 讀它）
prepare_repo "$MANUALS_REPO_URL" "${MANUALS_REPO_REF:-main}" "$FLOW_MANUALS_DIR" flow-manuals

case "$MODE" in
  loop)
    : "${FLOW_DOC_TARGET:?需要 FLOW_DOC_TARGET（目標 repo 的 clone 目的地）——不要動版控裡的 target 欄位}"
    : "${TARGET_REPO_URL:?需要 TARGET_REPO_URL（目標 repo 的 git URL）——填在 .env}"
    prepare_repo "$TARGET_REPO_URL" "${TARGET_REPO_REF:-main}" "$FLOW_DOC_TARGET" "目標 repo"
    prepare_target_env "$FLOW_DOC_TARGET"
    cd "$FLOW_MANUALS_DIR/$FLOW_DOC_TARGET_NAME"
    exec node /app/dist/cli.js loop "$@"
    ;;
  # 產生第一份 baseline。loop 刻意不自我初始化（沒有 baseline 就 exit 2），而分析
  # 環境現在只存在於容器內——沒有這個模式，啟用閉環的第一步就無路可走。
  #
  # 產物走 PR 而不是直接推 main：這份 commit 動輒上千個封包，跟 loop 的 PR 模式
  # 用同一條路徑比較不會出意外。
  bootstrap)
    FORCE=no
    for arg in "$@"; do
      if [ "$arg" = "--force" ]; then FORCE=yes; fi
    done

    # ⚠ 這兩個檢查刻意放在 clone 目標 repo **之前**。
    #
    # compose 的依賴鏈讓 `up -d` 每次都會跑到 bootstrap，而絕大多數時候它無事可做。
    # 檢查若放在 clone＋install 之後，等於每次部署都要付一次完整 clone 與 pnpm
    # install 的代價，才發現沒事可做。放在前面的話已 bootstrap 過的機器 2 秒就退出。
    # （手冊 repo 在 case 之前就已經 clone 好了，所以這裡讀得到 flow-chains.json。）
    #
    # BOOTSTRAP_AUTO=1 是給 compose 依賴鏈用的：exit 0 安靜跳過，而不是 exit 1。
    # 手動跑時不設它——那時「已經有 baseline」是使用者該知道的事，要大聲講。
    if [ -f "$FLOW_MANUALS_DIR/$FLOW_DOC_TARGET_NAME/flow-chains.json" ] && [ "$FORCE" = no ]; then
      if [ "${BOOTSTRAP_AUTO:-0}" = "1" ]; then
        echo "[bootstrap] 已有 baseline，跳過（自動模式）"
        exit 0
      fi
      # 已經有 baseline 還重建，會讓下一輪的 diff 以新環境為準——若兩者環境不同，
      # 那就是一次「整本手冊重寫」的規模。要做可以，但必須是明確的決定
      echo "已經有 baseline（flow-chains.json）。重建請確認你真的要換分析環境，然後加 --force" >&2
      exit 1
    fi
    if [ -z "${TARGET_REPO_URL:-}" ] && [ "${BOOTSTRAP_AUTO:-0}" = "1" ]; then
      echo "[bootstrap] 沒有 TARGET_REPO_URL，跳過（自動模式）——只想跑站台的話這是正常的"
      exit 0
    fi

    : "${FLOW_DOC_TARGET:?需要 FLOW_DOC_TARGET（目標 repo 的 clone 目的地）}"
    : "${TARGET_REPO_URL:?需要 TARGET_REPO_URL（目標 repo 的 git URL）——填在 .env}"
    prepare_repo "$TARGET_REPO_URL" "${TARGET_REPO_REF:-main}" "$FLOW_DOC_TARGET" "目標 repo"
    prepare_target_env "$FLOW_DOC_TARGET"
    cd "$FLOW_MANUALS_DIR/$FLOW_DOC_TARGET_NAME"

    STAMP="$(date +%Y%m%d%H%M%S)"
    BRANCH="bootstrap/$FLOW_DOC_TARGET_NAME/$STAMP"
    git checkout -b "$BRANCH"
    node /app/dist/cli.js trace
    node /app/dist/cli.js pack
    git add -A -- flow-chains.json packets
    if git diff --cached --quiet; then
      echo "分析結果與現況完全相同，沒有東西要 commit"
      exit 0
    fi
    TARGET_SHA="$(git -C "$FLOW_DOC_TARGET" rev-parse --short HEAD)"
    git commit -m "baseline：$FLOW_DOC_TARGET_NAME 於容器環境重建（目標 $TARGET_SHA）"
    if [ -n "${GH_TOKEN:-}" ]; then
      git push -u origin "$BRANCH"
      gh pr create --title "baseline：$FLOW_DOC_TARGET_NAME 於容器環境重建（目標 $TARGET_SHA）" \
        --body "由 \`flow-doc bootstrap\` 在 loop 容器內產生，作為閉環的比對基準。合併後 loop 才會開始跑。" \
        || echo "（gh 開 PR 失敗；分支已推上去，手動開 PR 即可）"
    else
      echo "⚠ 沒有 GH_TOKEN，只做了本地 commit——它在容器的 volume 裡，容器一刪就沒了。"
      echo "  設好 GH_TOKEN 重跑（加 --force），或自行從 volume 取出 $BRANCH。"
    fi
    ;;
  publish)
    : "${SITE_VOLUME:?需要 SITE_VOLUME（共用 volume 的掛載點）}"
    cd "$FLOW_MANUALS_DIR/$FLOW_DOC_TARGET_NAME"
    # -m manuals 不能少：少了它敘述與總覽全都不會注入，站台只剩分析骨架
    if [ -n "${FLOW_DOC_SITE_TITLE:-}" ]; then
      node /app/dist/cli.js site -m manuals --title "$FLOW_DOC_SITE_TITLE" "$@"
    else
      node /app/dist/cli.js site -m manuals "$@"
    fi
    cd site
    pnpm install --silent
    pnpm build
    # 原子換版：build 到 releases/<時戳>，symlink 一步切過去。
    # 不可以邊 build 邊服務同一個目錄，否則使用者會讀到半套站
    STAMP="$(date +%Y%m%d%H%M%S)"
    mkdir -p "$SITE_VOLUME/releases"
    cp -r .vitepress/dist "$SITE_VOLUME/releases/$STAMP"
    ln -sfn "releases/$STAMP" "$SITE_VOLUME/.current.tmp"
    mv -Tf "$SITE_VOLUME/.current.tmp" "$SITE_VOLUME/current"
    # 保留最近 3 版供回滾，其餘清掉
    ls -1dt "$SITE_VOLUME"/releases/* | tail -n +4 | xargs -r rm -rf
    echo "已換版：releases/$STAMP"
    ;;
  *)
    echo "未知模式：$MODE（可用：loop、bootstrap、publish）" >&2
    exit 1
    ;;
esac
