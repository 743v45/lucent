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
RUN npm ci --omit=dev && npm cache clean --force

# 构建产物 + 后端源码（tsx 运行时编译 TS）
COPY --from=builder /app/dist ./dist
COPY server ./server
COPY bin ./bin
COPY shared ./shared

# config.json + logs/ 持久化
VOLUME ["/data"]

EXPOSE 7048 7049

# 直接调 tsx binary（PID 1 = node，SIGTERM 直达 server/index.ts 的 graceful handler）
# 纯 docker run 建议加 --init；docker compose 已配 init: true
CMD ["./node_modules/.bin/tsx", "server/index.ts"]
