/**
 * AgentProxy 服务端常量
 *
 * 集中管理所有硬编码值，避免分散在各个模块中
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

// ==================== 端口 ====================
/** 代理服务器监听端口（拦截 API 请求） */
export const DEFAULT_PROXY_PORT = 7048;
/** Web 管理界面端口 */
export const DEFAULT_WEB_PORT = 7049;

// ==================== 服务器地址 ====================
export const DEFAULT_SERVER_HOST = '127.0.0.1';
/** @deprecated 使用 DEFAULT_SERVER_HOST */
export const SERVER_HOST = DEFAULT_SERVER_HOST;

// ==================== 应用数据目录 ====================
export const APP_DATA_DIR_NAME = '.agentproxy';  // 用户主目录下的应用数据目录
export const LOG_SUBDIR = 'logs';
export const CONFIG_FILE_NAME = 'config.json';

export const LOG_DIR = join(homedir(), APP_DATA_DIR_NAME, LOG_SUBDIR);      // ~/~/.agentproxy/logs
export const CONFIG_DIR = join(homedir(), APP_DATA_DIR_NAME);               // ~/.agentproxy
export const CONFIG_PATH = join(CONFIG_DIR, CONFIG_FILE_NAME);              // ~/.agentproxy/config.json

// ==================== 日志配置 ====================
export const MAX_LOG_FILE_SIZE = 100 * 1024 * 1024; // 100MB — 单个日志文件最大体积
export const MAX_LOG_FILES = 50;                    // 日志轮转保留文件数
export const LOG_RETENTION_DAYS = 30;               // 日志自动清理天数
export const MAX_LOG_FILES_TO_READ = 5;             // Web 端查看日志时最多读取的文件数
export const DEFAULT_LOG_QUERY_LIMIT = 100;         // 日志查询默认返回条数
export const LOG_ENTRY_SEPARATOR = '\n---\n';       // 日志条目之间的分隔符（写入时使用）
export const LOG_SPLIT_REGEX = /\n---\n?/;          // 解析日志时用于拆分条目的正则

// ==================== 心跳与超时 ====================
/** SSE 心跳间隔，防止连接因空闲被关闭 */
export const HEARTBEAT_INTERVAL_MS = 30000; // 30s

// ==================== Delta 存储 ====================
/** 每隔多少条 SSE delta 事件保存一次完整快照（用于上下文重建） */
export const DELTA_CHECKPOINT_INTERVAL = 10;

// ==================== 上下文窗口大小 ====================
export const DEFAULT_CONTEXT_SIZE = 200000;  // 200K — 普通模型的默认上下文长度
export const LARGE_CONTEXT_SIZE = 1000000;   // 1M — 大上下文模型的上下文长度
/** 匹配使用大上下文的模型名称，用于自动选择 LARGE_CONTEXT_SIZE */
export const LARGE_CONTEXT_MODEL_PATTERN = /opus|mythos|sonnet-4|claude-4/;

// ==================== API Key 脱敏 ====================
export const API_KEY_MASK_THRESHOLD = 12;  // key 长度超过此值才进行脱敏
export const API_KEY_MASK_PREFIX = 8;      // 保留前 8 位明文
export const API_KEY_MASK_SUFFIX = 4;      // 保留末 4 位明文

// ==================== 默认上游 URL ====================
/** 各 API 类型对应的默认上游服务器地址，用户未配置 upstreamUrl 时使用 */
export const DEFAULT_UPSTREAM_URLS = {
  'anthropic-messages': 'https://api.anthropic.com',
  'openai-chat': 'https://api.openai.com',
  'openai-responses': 'https://api.openai.com',
} as const;

// ==================== 测试连接模型 ====================
/** 各 API 类型用于「测试连接」功能的廉价模型 */
export const TEST_MODELS = {
  'anthropic-messages': 'claude-sonnet-4-20250514',
  'openai-chat': 'gpt-4o-mini',
  'openai-responses': 'gpt-4o-mini',
} as const;

export const TEST_REQUEST_CONTENT = 'hi';  // 测试连接时发送的消息内容
export const TEST_MAX_TOKENS = 1;           // 测试连接时请求的最大 token 数（最小化消耗）

// ==================== Anthropic API 版本 ====================
/** 请求 Anthropic API 时使用的 api-version header 值 */
export const ANTHROPIC_API_VERSION = '2023-06-01';

// ==================== 自定义请求头 ====================
/** 标记请求经过本代理的 trace header，用于请求追踪 */
export const PROXY_TRACE_HEADER = 'x-agentproxy-trace';
/** 内部组件间通信使用的请求头，不透传到上游 */
export const INTERNAL_HEADERS = ['x-agentproxy-internal', 'x-cc-viewer-internal'] as const;

// ==================== 内容截断限制 ====================
/** 解析请求/响应体失败时，截取用于错误日志的最大长度 */
export const MAX_BODY_PARSE_FAILURE_LENGTH = 500;
/** 流式错误响应体的最大截取长度 */
export const MAX_STREAM_ERROR_BODY_LENGTH = 1000;
/** 非流式响应体的最大截取长度（日志展示用） */
export const MAX_RESPONSE_BODY_LENGTH = 1000;
/** tool_use 输入内容的预览截取长度 */
export const TOOL_INPUT_PREVIEW_LENGTH = 200;

// ==================== 上下文重建 ====================
export const MAX_CONTEXT_CHECKPOINTS = 100;      // 单次请求保留的最大检查点数量
export const CHECKPOINT_KEY_CONTENT_LENGTH = 50;  // 检查点去重 key 的内容截取长度

// ==================== Claude 配置目录 ====================
/** Claude CLI 的配置目录路径，用于读取用户的 API key 等设置 */
export const CLAUDE_SETTINGS_DIR = join(homedir(), '.claude');

// ==================== API 路径正则 ====================
/** 根据请求路径匹配对应的 API 协议类型 */
export const API_PATH_REGEX = {
  ANTHROPIC_MESSAGES: /\/v1\/messages|\/api\/v1\/messages/,
  OPENAI_CHAT: /\/v1\/(chat\/completions|completions)/,
  OPENAI_RESPONSES: /\/v1\/responses/,
} as const;
