# syntax=docker/dockerfile:1
#
# Lucent — AI Agent 代理服务器镜像
#
# 构建: docker build -t lucent .
# 运行: docker run -d --init -p 7048:7048 -p 7049:7049 -v lucent-data:/data lucent
#   或: docker compose up -d
#
# 端口: 7048=代理(AI 工具配置 BASE_URL 指向这里)  7049=Web UI
# 持久化: /data 含 config.json + logs/（LUCENT_CONFIG_DIR=/data）

# ==================== Builder: 前端构建 ====================
FROM node:20-alpine AS builder
WORKDIR /app

# 先复制依赖清单，利用 layer 缓存
COPY package.json package-lock.json ./
# better-sqlite3 是原生模块：node:20-alpine(musl) 无 prebuild，需源码编译，装构建工具
RUN apk add --no-cache python3 make g++
RUN npm ci

# 复制源码并构建前端（vite build → dist/）
COPY . .
RUN npm run build

# ==================== Runner: 生产运行 ====================
FROM node:20-alpine AS runner
WORKDIR /app

# 容器内必须监听 0.0.0.0；config/logs 落 /data（持久化）
ENV LUCENT_HOST=0.0.0.0 \
    LUCENT_CONFIG_DIR=/data \
    NODE_ENV=production

# 只装生产依赖（tsx 在 dependencies，用于运行 server/*.ts——后端无编译步骤，tsconfig noEmit）
COPY package.json package-lock.json ./
# better-sqlite3 原生模块：node:20-alpine(musl) 无 prebuild，需源码编译。
# libstdc++ 运行时保留（.node 链接它）；python3/make/g++ 编完即删以瘦身。
RUN apk add --no-cache libstdc++ && \
    apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm ci --omit=dev && npm cache clean --force && \
    apk del .build-deps

# 构建产物 + 后端源码（tsx 运行时编译 TS）
COPY --from=builder /app/dist ./dist
COPY server ./server
COPY bin ./bin
COPY shared ./shared

# /data 持久化目录：以 root 创建并交给 node 用户（uid 1000，node:20-alpine 自带）。
# 命名卷首次挂载时 Docker 从镜像内 /data 复制并保留属主 → 非 root 进程可写。
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

# 非 root 运行：根文件系统由 compose 设只读，仅 /data（卷）+ /tmp（compose tmpfs）可写
USER node

EXPOSE 7048 7049

# 健康检查：复用 GET /api/health（返回 200 {status:'ok'}）。alpine 自带 busybox wget，无需装 curl。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7049/api/health || exit 1

# 直接调 tsx binary（PID 1 = node，SIGTERM 直达 server/index.ts 的 graceful handler）
# 纯 docker run 建议加 --init；docker compose 已配 init: true
CMD ["./node_modules/.bin/tsx", "server/index.ts"]
