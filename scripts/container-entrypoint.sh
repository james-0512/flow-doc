#!/usr/bin/env bash
# 容器進入點：loop（跑一圈）或 publish（site build → 原子換版到共用 volume）。
# 環境變數契約見 docker-compose.yml；第一個參數後的東西全部轉交給底下的指令。
set -euo pipefail

MODE="${1:-loop}"
[ "$#" -gt 0 ] && shift

: "${FLOW_MANUALS_DIR:?需要 FLOW_MANUALS_DIR（flow-manuals 的掛載路徑）}"
: "${FLOW_DOC_TARGET_NAME:?需要 FLOW_DOC_TARGET_NAME（手冊 repo 內的目標目錄名，例如 mPHR_Frontend）}"
cd "$FLOW_MANUALS_DIR/$FLOW_DOC_TARGET_NAME"

# 掛載進來的 repo 擁有者與容器內的 uid 不同，git 會拒絕操作
git config --global --add safe.directory '*'

case "$MODE" in
  loop)
    : "${FLOW_DOC_TARGET:?需要 FLOW_DOC_TARGET（目標 repo 的掛載路徑，:ro）——不要動版控裡的 target 欄位}"
    # commit 那一組憑證：身份寫在容器的 global config（不汙染掛載 repo 的 .git/config）
    [ -n "${GIT_USER_NAME:-}" ] && git config --global user.name "$GIT_USER_NAME"
    [ -n "${GIT_USER_EMAIL:-}" ] && git config --global user.email "$GIT_USER_EMAIL"
    # PR 模式的 push 憑證：gh 讀 GH_TOKEN，setup-git 讓 git push 走同一個 token
    if [ -n "${GH_TOKEN:-}" ]; then gh auth setup-git 2>/dev/null || true; fi
    exec node /app/dist/cli.js loop "$@"
    ;;
  publish)
    : "${SITE_VOLUME:?需要 SITE_VOLUME（共用 volume 的掛載點）}"
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
    echo "未知模式：$MODE（可用：loop、publish）" >&2
    exit 1
    ;;
esac
