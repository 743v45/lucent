#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────
# opencode-run.sh — 通过 AgentProxy (7048) 调用 OpenCode CLI
# ──────────────────────────────────────────────────────────────────
#
# 用途：给 AgentProxy 项目本身做测试，请求经代理转发并记录到日志，
#       可在 Web UI (7049) 上查看完整的请求/响应数据。
#
# 用法：
#   # 非交互（最常用）
#   PROMPT="帮我 review server/proxy.ts" ./scripts/opencode-run.sh
#
#   # 交互模式
#   ./scripts/opencode-run.sh
#
#   # 可选变量
#   MODEL=gpt-4o-mini PROMPT="..." ./scripts/opencode-run.sh
#
# 变量            默认值        说明
# ──────────────────────────────────────────────
# PROXY_PORT      7048        AgentProxy 代理端口
# API_KEY         sk-upai     代理配置的 API key
# MODEL           gpt-4o-mini OpenCode 模型名
# PROVIDER        openai-chat OpenCode provider 名称（使用 Chat Completions API）
# PROMPT          (空)        传入则非交互模式，否则交互模式
# AGENT           build       OpenCode agent 名称
#
# ⚠️ 前置条件：
#
# 1. 项目配置文件（必须）
#    在项目目录创建 opencode.json 配置自定义 provider：
#    {
#      "provider": {
#        "openai-chat": {
#          "npm": "@ai-sdk/openai-compatible",
#          "name": "OpenAI Chat",
#          "options": {
#            "baseURL": "http://localhost:7048/v1",
#            "headers": { "x-api-key": "sk-upai" }
#          },
#          "models": {
#            "gpt-4o-mini": { "name": "GPT-4o Mini", "limit": { "context": 128000, "output": 16384 } }
#          }
#        }
#      }
#    }
#
#    注意：必须使用 openai-compatible provider 并配置 headers，
#    因为 OpenCode 默认的 openai provider 不发送 x-api-key header，
#    且 Responses API 格式与慧星云不完全兼容。
#
# 2. AgentProxy OpenAI Chat 配置
#    需要配置 AgentProxy 的 openai-chat profile：
#      curl -X PUT "http://localhost:7049/api/config/openai-chat/profiles/1" \
#        -H "Content-Type: application/json" \
#        -d '{"upstreamBaseUrl":"http://zhy1.dc.huixingyun.com:55627","apiKey":"sk-upai"}'
#
# ──────────────────────────────────────────────────────────────────

# ─── 固定配置 ────────────────────────────────────────────────────
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROXY_PORT="${PROXY_PORT:-7048}"
API_KEY="${API_KEY:-sk-upai}"
MODEL="${MODEL:-gpt-4o-mini}"
PROVIDER="${PROVIDER:-openai-chat}"
AGENT="${AGENT:-build}"

# ─── 可选变量 ────────────────────────────────────────────────────
PROMPT="${PROMPT:-}"

# ─── 检查项目配置文件 ────────────────────────────────────────────
CONFIG_FILE="$PROJECT_DIR/opencode.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "⚠️  未找到项目配置文件: $CONFIG_FILE"
  echo "正在自动创建配置文件..."

  # 自动创建配置文件
  cat > "$CONFIG_FILE" << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openai-chat": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenAI Chat",
      "options": {
        "baseURL": "http://localhost:7048/v1",
        "headers": {
          "x-api-key": "sk-upai"
        }
      },
      "models": {
        "gpt-4o-mini": {
          "name": "GPT-4o Mini",
          "limit": {
            "context": 128000,
            "output": 16384
          }
        }
      }
    }
  }
}
EOF
  echo "✅ 配置文件已创建: $CONFIG_FILE"
fi

# ─── 构建命令 ────────────────────────────────────────────────────
args=(run)
[[ -n "$PROMPT" ]] && args+=("$PROMPT")
args+=(--model "$PROVIDER/$MODEL")
args+=(--agent "$AGENT")

# ─── 执行 ────────────────────────────────────────────────────────
cd "$PROJECT_DIR"

echo "🔀 代理: localhost:$PROXY_PORT  🤖 模型: $PROVIDER/$MODEL  🕵️ Agent: $AGENT"
if [[ -n "$PROMPT" ]]; then
  echo "💬 ${PROMPT:0:80}..."
fi
echo "---"

exec opencode "${args[@]}"