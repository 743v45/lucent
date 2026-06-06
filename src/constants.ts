/**
 * AgentProxy 前端常量
 *
 * 中管理所有硬编码值
 */

import type { ApiProviderType } from './types';

// ==================== API 路径 ====================
export const API_BASE_PATH = '/api';

// ==================== 布局尺寸 ====================
export const SIDEBAR_DEFAULT_WIDTH = 300;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 500;
export const HEADER_HEIGHT = 51;
export const SETTINGS_MODAL_WIDTH = 780;
export const SETTINGS_MODAL_CONTENT_HEIGHT = 420;
export const SETTINGS_SIDEBAR_WIDTH = 260;
export const NAME_INPUT_WIDTH = 160;
export const CONTEXT_LIST_WIDTH = 280;
export const DURATION_COL_WIDTH = 50;

// ==================== 颜色 ====================
export const COLOR_MAIN_AGENT = '#C9A227';
export const COLOR_SUB_AGENT = '#B87A4A';
export const COLOR_JSON_VIEW_BG = '#08090a';
export const THEME_PRIMARY_COLOR = '#5e6ad2';

// ==================== 超时/延迟 ====================
export const DATE_HOVER_DELAY_MS = 1000;
export const COPIED_FEEDBACK_DURATION_MS = 1500;

// ==================== 默认上游 URL ====================
export const DEFAULT_UPSTREAM_URLS: Record<ApiProviderType, string> = {
  'anthropic-messages': 'https://api.anthropic.com',
  'openai-chat': 'https://api.openai.com',
  'openai-responses': 'https://api.openai.com',
};

// ==================== 环境变量名 ====================
export const ENV_VAR_NAMES: Record<ApiProviderType, string> = {
  'anthropic-messages': 'ANTHROPIC_BASE_URL',
  'openai-chat': 'OPENAI_BASE_URL',
  'openai-responses': 'OPENAI_BASE_URL',
};

// ==================== 代理拦截的 API 路径 ====================
export const API_INTERCEPT_PATHS: Record<ApiProviderType, string> = {
  'anthropic-messages': '/v1/messages',
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
};

// ==================== API 路径正则匹配 ====================
export const API_PATH_REGEX = {
  ANTHROPIC_MESSAGES: /\/v1\/messages|\/api\/v1\/messages/,
  OPENAI_CHAT: /\/v1\/(chat\/completions|completions)/,
  OPENAI_RESPONSES: /\/v1\/responses/,
} as const;

// ==================== 默认值 ====================
export const DEFAULT_PROFILE_NAME = 'default';
export const DEFAULT_THEME = 'light';
export const DEFAULT_ACTIVE_TAB = 'request';
export const DEFAULT_LOCALE = 'zh-CN';

// ==================== URL 参数 ====================
export const URL_PARAM_LOG_ID = 'log';
export const URL_PARAM_TAB = 'tab';

// ==================== localStorage ====================
export const STORAGE_KEY_SIDEBAR_WIDTH = 'logListWidth';

// ==================== URL 截断 ====================
export const URL_SEARCH_PREVIEW_LENGTH = 20;
export const URL_FALLBACK_PREVIEW_LENGTH = 40;

// ==================== JSON 视图 ====================
export const JSON_COLLAPSED_EXPAND_LEVEL = 2;

// ==================== Cache 命中率阈值 ====================
export const CACHE_HIT_RATE_GOOD_THRESHOLD = 70;
export const CACHE_HIT_RATE_BAD_THRESHOLD = 30;

// ==================== HTTP 状态码 ====================
export const HTTP_ERROR_STATUS_THRESHOLD = 400;

// ==================== 时间格式化 ====================
export const MS_TO_S_THRESHOLD = 1000;
export const TOKEN_FORMAT_THRESHOLD_MILLION = 1_000_000;
export const TOKEN_FORMAT_THRESHOLD_KILO = 1_000;

// ==================== 图标 ====================
export const DEFAULT_ICON_SIZE = 18;

// ==================== Root 元素 ====================
export const ROOT_ELEMENT_ID = 'root';

// ==================== 默认端口 ====================
export const DEFAULT_PROXY_PORT = 7048;
