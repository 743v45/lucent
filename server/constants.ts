/**
 * AgentProxy 服务端常量
 *
 * 集中管理所有硬编码值，避免分散在各个模块中
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

// ==================== 端口 ====================
export const DEFAULT_PROXY_PORT = 7048;
export const DEFAULT_WEB_PORT = 7049;

// ==================== 服务器地址 ====================
export const SERVER_HOST = '127.0.0.1';

// ==================== 应用数据目录 ====================
export const APP_DATA_DIR_NAME = '.agentproxy';
export const LOG_SUBDIR = 'logs';
export const CONFIG_FILE_NAME = 'config.json';

export const LOG_DIR = join(homedir(), APP_DATA_DIR_NAME, LOG_SUBDIR);
export const CONFIG_DIR = join(homedir(), APP_DATA_DIR_NAME);
export const CONFIG_PATH = join(CONFIG_DIR, CONFIG_FILE_NAME);

// ==================== 日志配置 ====================
export const MAX_LOG_FILE_SIZE = 100 * 1024 * 1024; // 100MB
export const MAX_LOG_FILES = 50;
export const LOG_RETENTION_DAYS = 30;
export const MAX_LOG_FILES_TO_READ = 5;
export const DEFAULT_LOG_QUERY_LIMIT = 100;
export const LOG_ENTRY_SEPARATOR = '\n---\n';
export const LOG_SPLIT_REGEX = /\n---\n?/;

// ==================== 心跳与超时 ====================
export const HEARTBEAT_INTERVAL_MS = 30000; // 30s

// ==================== Delta 存储 ====================
export const DELTA_CHECKPOINT_INTERVAL = 10;

// ==================== 上下文窗口大小 ====================
export const DEFAULT_CONTEXT_SIZE = 200000;  // 200K
export const LARGE_CONTEXT_SIZE = 1000000;   // 1M
export const LARGE_CONTEXT_MODEL_PATTERN = /opus|mythos|sonnet-4|claude-4/;

// ==================== API Key 脱敏 ====================
export const API_KEY_MASK_THRESHOLD = 12;
export const API_KEY_MASK_PREFIX = 8;
export const API_KEY_MASK_SUFFIX = 4;

// ==================== 默认上游 URL ====================
export const DEFAULT_UPSTREAM_URLS = {
  'anthropic-messages': 'https://api.anthropic.com',
  'openai-chat': 'https://api.openai.com',
  'openai-responses': 'https://api.openai.com',
  'gemini-generate': 'https://generativelanguage.googleapis.com',
} as const;

// ==================== 测试连接模型 ====================
export const TEST_MODELS = {
  'anthropic-messages': 'claude-sonnet-4-20250514',
  'openai-chat': 'gpt-4o-mini',
  'openai-responses': 'gpt-4o-mini',
  'gemini-generate': 'gemini-2.0-flash',
} as const;

export const TEST_REQUEST_CONTENT = 'hi';
export const TEST_MAX_TOKENS = 1;

// ==================== Anthropic API 版本 ====================
export const ANTHROPIC_API_VERSION = '2023-06-01';

// ==================== 自定义请求头 ====================
export const PROXY_TRACE_HEADER = 'x-agentproxy-trace';
export const INTERNAL_HEADERS = ['x-agentproxy-internal', 'x-cc-viewer-internal'] as const;

// ==================== 内容截断限制 ====================
export const MAX_BODY_PARSE_FAILURE_LENGTH = 500;
export const MAX_STREAM_ERROR_BODY_LENGTH = 1000;
export const MAX_RESPONSE_BODY_LENGTH = 1000;
export const TOOL_INPUT_PREVIEW_LENGTH = 200;

// ==================== 上下文重建 ====================
export const MAX_CONTEXT_CHECKPOINTS = 100;
export const CHECKPOINT_KEY_CONTENT_LENGTH = 50;

// ==================== Claude 配置目录 ====================
export const CLAUDE_SETTINGS_DIR = join(homedir(), '.claude');

// ==================== API 路径正则 ====================
export const API_PATH_REGEX = {
  ANTHROPIC_MESSAGES: /\/v1\/messages|\/api\/v1\/messages/,
  OPENAI_CHAT: /\/v1\/(chat\/completions|completions)/,
  OPENAI_RESPONSES: /\/v1\/responses/,
  GEMINI_GENERATE: /\/v\d+\/models\/[^/]+:generateContent/,
} as const;
