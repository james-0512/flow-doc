# flow-doc 閉環的 runner 映像。
#
# 工具**烤進映像檔**，不在 runtime 拉取：映像 tag ＝ analyzer 版本。
# runtime 拉會讓表示法每晚可能靜默改變，把「升版圈」變成天天意外發生（LOOP.md〈容器化〉）。
#
# 同一個映像跑兩種模式（見 scripts/container-entrypoint.sh）：
#   loop     跑一圈（預設）——需要掛載目標 repo（:ro）與 flow-manuals（rw）
#   publish  site build 後原子換版到共用 volume——只需要 flow-manuals 與 volume

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.6 --activate
COPY package.json pnpm-lock.yaml tsconfig.json ./
# --no-optional 跳過 claude-agent-sdk 的平台 binary（267 MB 的 Claude Code 執行檔）。
# 型別檔在主套件裡，tsc 照樣過；容器走 API key，那條訂閱路徑本來就用不到（D16）
RUN pnpm install --frozen-lockfile --no-optional
COPY src ./src
RUN pnpm build

FROM node:22-slim
# git：baseline 比對、rename 偵測、commit／push；gh：PR 模式；pnpm：publish 模式的 site build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gnupg \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.6 --activate
# 遠端模式會在目標 repo 裡跑 pnpm。目標若用 packageManager 釘了別的版本，corepack
# 會去下載——互動式確認在無 tty 的批次裡等於卡死，關掉它讓 corepack 直接下載。
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# 訂閱模式（WITH_SUBSCRIPTION=1）才裝 claude-agent-sdk 的平台 binary——267 MB 的
# Claude Code 執行檔。預設 0：走 API key 的 image 用不到它，不該扛著跑。
# 憑證用 CLAUDE_CODE_OAUTH_TOKEN 帶進來（claude setup-token 產生），
# 不掛 host 的 ~/.claude——那會把 D15 拆掉的 host 耦合又裝回來。
ARG WITH_SUBSCRIPTION=0
RUN if [ "$WITH_SUBSCRIPTION" = "1" ]; then \
      pnpm install --frozen-lockfile --prod && \
      # pnpm 會把 glibc 與 musl 兩種變體都裝進來，各 267 MB。這個 base image 是
      # Debian（glibc），musl 那份永遠不會被選中
      rm -rf /app/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*-musl@*; \
    else \
      pnpm install --frozen-lockfile --prod --no-optional; \
    fi \
    # pnpm 的 store 是硬連結的來源，node_modules 裡已經有實體檔了，留著等於整包
    # 存兩份（實測 617 MB）。必須跟 install 同一層刪，不同層只會多疊一層。
    # pnpm 自己在 /usr/local/bin（corepack），不受影響——publish 的站台建置照跑
 && rm -rf /root/.local/share/pnpm/store
COPY --from=build /app/dist ./dist
COPY templates ./templates
# narrate 的規則檔 fallback：手冊 repo 沒帶 skill 時用工具自帶的這份（D13：規則只有一份）
COPY .claude/skills/flow-manual ./.claude/skills/flow-manual
COPY scripts/container-entrypoint.sh /usr/local/bin/flow-doc-entrypoint
RUN chmod +x /usr/local/bin/flow-doc-entrypoint

ENTRYPOINT ["flow-doc-entrypoint"]
CMD ["loop"]
