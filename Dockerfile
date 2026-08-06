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
RUN pnpm install --frozen-lockfile --prod --no-optional
COPY --from=build /app/dist ./dist
COPY templates ./templates
# narrate 的規則檔 fallback：手冊 repo 沒帶 skill 時用工具自帶的這份（D13：規則只有一份）
COPY .claude/skills/flow-manual ./.claude/skills/flow-manual
COPY scripts/container-entrypoint.sh /usr/local/bin/flow-doc-entrypoint
RUN chmod +x /usr/local/bin/flow-doc-entrypoint

ENTRYPOINT ["flow-doc-entrypoint"]
CMD ["loop"]
