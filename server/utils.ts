/**
 * Lucent 共享工具函数
 *
 * 集中管理 API Key 脱敏、Header 清理等跨模块复用的工具
 */

import { API_KEY_MASK_PREFIX, API_KEY_MASK_SUFFIX, API_KEY_MASK_THRESHOLD } from './constants.js';

// ==================== API Key 脱敏 ====================

/**
 * 对单个密钥字符串进行脱敏
 */
export function maskApiKey(key: string): string {
  if (!key) return '';
  return key.length > API_KEY_MASK_THRESHOLD
    ? `${key.slice(0, API_KEY_MASK_PREFIX)}****${key.slice(-API_KEY_MASK_SUFFIX)}`
    : '****';
}

/**
 * 脱敏敏感 headers（x-api-key, authorization 等）
 */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const safe = { ...headers };

  // 脱敏 x-api-key
  if (safe['x-api-key']) {
    safe['x-api-key'] = maskApiKey(safe['x-api-key']);
  }

  // 脱敏 authorization
  if (safe['authorization']) {
    const v = safe['authorization'];
    const spaceIdx = v.indexOf(' ');
    if (spaceIdx > 0) {
      const scheme = v.slice(0, spaceIdx);
      const token = v.slice(spaceIdx + 1);
      safe['authorization'] = scheme + ' ' + maskApiKey(token);
    } else {
      safe['authorization'] = '****';
    }
  }

  return safe;
}

/**
 * 序列化 profile 为脱敏格式（用于 API 返回）
 */
export function serializeProfileSafe(profile: { id: string; name: string; upstreamBaseUrl: string; apiKey: string }) {
  return {
    id: profile.id,
    name: profile.name,
    upstreamBaseUrl: profile.upstreamBaseUrl,
    apiKeySet: profile.apiKey.length > 0,
    apiKeyPreview: maskApiKey(profile.apiKey),
  };
}

/**
 * 序列化 group 为脱敏格式
 */
export function serializeGroupSafe(group: {
  apiType: string;
  activeProfileId: string;
  profiles: Array<{ id: string; name: string; upstreamBaseUrl: string; apiKey: string }>;
}) {
  return {
    apiType: group.apiType,
    activeProfileId: group.activeProfileId,
    profiles: group.profiles.map(serializeProfileSafe),
  };
}
