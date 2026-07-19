/**
 * Lucent 前端常量
 *
 * 中管理所有硬编码值
 */

// ==================== API 路径 ====================
export const API_BASE_PATH = '/api';

// ==================== 布局尺寸 ====================
export const SIDEBAR_DEFAULT_WIDTH = 300;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 700;
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
// 定时自动刷新间隔选择（值见 RefreshIntervalId）
export const STORAGE_KEY_REFRESH_INTERVAL = 'lucent.refreshInterval';
// 详情面板 Body 全展开态（{ request, response }，JSON）——记忆，切日志不重置
export const STORAGE_KEY_DETAIL_BODY_EXPANDED = 'lucent.detailBodyExpanded';
// 详情面板 Headers 折叠态（{ request, response }，JSON）——记忆，切日志不重置
export const STORAGE_KEY_DETAIL_HEADERS_EXPANDED = 'lucent.detailHeadersExpanded';

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

/** 按状态码范围返回 Tailwind 文字颜色类 */
export function getStatusColor(status: number): string {
  if (status >= 500) return 'text-error';    // 5xx - 红色 (服务端错误)
  if (status >= 400) return 'text-tool';     // 4xx - 橙色 (客户端错误)
  if (status >= 300) return 'text-warning';  // 3xx - 黄色 (重定向)
  return 'text-success';                     // 2xx - 绿色 (成功)
}

// ==================== 时间格式化 ====================
export const MS_TO_S_THRESHOLD = 1000;
export const TOKEN_FORMAT_THRESHOLD_MILLION = 1_000_000;
export const TOKEN_FORMAT_THRESHOLD_KILO = 1_000;

// ==================== 图标 ====================
export const DEFAULT_ICON_SIZE = 18;

// ==================== Root 元素 ====================
export const ROOT_ELEMENT_ID = 'root';

// ==================== 定时自动刷新 ====================
export type RefreshIntervalId = 'off' | '5s' | '10s' | '1min' | '10min' | '1h';

export const REFRESH_INTERVAL_OPTIONS: { value: RefreshIntervalId; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: '5s', label: '5秒' },
  { value: '10s', label: '10秒' },
  { value: '1min', label: '1分钟' },
  { value: '10min', label: '10分钟' },
  { value: '1h', label: '1小时' },
];

export const REFRESH_INTERVAL_MS: Record<RefreshIntervalId, number | null> = {
  off: null,
  '5s': 5_000,
  '10s': 10_000,
  '1min': 60_000,
  '10min': 600_000,
  '1h': 3_600_000,
};

const REFRESH_INTERVAL_VALID: ReadonlySet<string> = new Set(
  REFRESH_INTERVAL_OPTIONS.map(o => o.value),
);

/** 从 localStorage 原始值解析 interval：非法/空用 defaultValue（默认 'off'）。纯函数，node 可单测。 */
export function parseRefreshInterval(
  raw: string | null,
  defaultValue: RefreshIntervalId = 'off',
): RefreshIntervalId {
  return raw && REFRESH_INTERVAL_VALID.has(raw) ? (raw as RefreshIntervalId) : defaultValue;
}

// ==================== 默认端口 ====================
export const DEFAULT_PROXY_PORT = 7048;
