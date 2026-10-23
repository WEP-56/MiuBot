# syntax=docker/dockerfile:1

# Miubot 生产镜像。
#
# 两段式：构建阶段装依赖、生成模型目录、构建工作台；运行阶段只带源码 + 生产依赖。
# 服务端直接跑 `.ts`（Node ≥ 22.19 原生类型擦除 + `--conditions=source` 解析
# workspace 包源码），所以运行时不需要 tsc，也没有「构建产物与源码不一致」的问题。

# ── 构建阶段 ────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# 先只拷 workspace 清单：改代码不会让 `npm ci` 这层缓存失效。
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/agent/package.json packages/agent/
COPY packages/context/package.json packages/context/
COPY packages/mcp/package.json packages/mcp/
COPY packages/plugin/package.json packages/plugin/
COPY packages/provider/package.json packages/provider/
COPY packages/session/package.json packages/session/
COPY packages/shared/package.json packages/shared/
COPY packages/telemetry/package.json packages/telemetry/
RUN npm ci --ignore-scripts

COPY . .

# 工作台产物由服务端直接托管（模型目录已随仓库提交，不需要联网生成）。
# `npm prune` 去掉 tsc / vitest / biome 这类只在构建期需要的东西。
RUN npm run build --workspace=@miubot/web \
 && npm prune --omit=dev --ignore-scripts

# ── 运行阶段 ────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

LABEL org.opencontainers.image.title="Miubot" \
      org.opencontainers.image.description="QQ bot workspace (admin API + web UI + QQ Gateway)" \
      org.opencontainers.image.source="https://github.com/WEP-56/MiuBot"

# 版本号：CI 打 tag 时用 `--build-arg MIUBOT_VERSION=v0.2.0` 注入，
# 工作台的「当前版本」与更新检查都读它；为空时回落到仓库里的 package.json。
ARG MIUBOT_VERSION=""

ENV NODE_ENV=production \
    MIUBOT_HOST=0.0.0.0 \
    MIUBOT_PORT=8787 \
    MIUBOT_DATA_DIR=/var/lib/miubot \
    MIUBOT_VERSION=${MIUBOT_VERSION}

WORKDIR /app

# 非 root 运行：插件是**进程内任意 Node 代码**，跑在哪个用户下就等于把那个用户交出去。
# 数据目录预先建好并交给该用户，Docker 具名卷首次挂载时会继承这个属主，因此无需 entrypoint chown。
# tzdata 是给 `TZ` 用的：debian-slim 默认没有时区库，缺了它「静默时段」会按 UTC 判断。
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 miubot \
 && useradd --uid 10001 --gid miubot --no-create-home --shell /usr/sbin/nologin miubot \
 && mkdir -p /var/lib/miubot \
 && chown miubot:miubot /var/lib/miubot

COPY --from=build --chown=miubot:miubot /app /app

USER miubot
WORKDIR /app/apps/server

EXPOSE 8787

# 用 node 自带 fetch 探活，避免往镜像里塞 curl。
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.MIUBOT_PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# 应用自己处理 SIGTERM：断开 QQ Gateway → 关 HTTP 端口 → 落盘会话。
STOPSIGNAL SIGTERM

CMD ["node", "--conditions=source", "--enable-source-maps", "src/index.ts"]
