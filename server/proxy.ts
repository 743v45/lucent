/**
 * Lucent HTTP 代理转发模块
 *
 * 功能：
 * - 接收客户端请求
 * - 转发到真实 API (OpenAI/Claude)
 * - 支持 SSE 流式响应
 * - 处理认证
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig, getActiveProfileForApiType } from './config.js';
import { detectApiType } from './context-extractors.js';
import { DEFAULT_PROXY_PORT, DEFAULT_SERVER_HOST, PROXY_TRACE_HEADER, DEFAULT_UPSTREAM_URLS, CLAUDE_SETTINGS_DIR, MAX_REQUEST_BODY_SIZE } from './constants.js';
import createDebug from 'debug';
const log = createDebug('lucent:proxy');

// ==================== 配置 ====================
// 默认值从 constants 取，运行时由 startProxyServer 参数覆盖

// ==================== 工具函数 ====================

/**
 * 强制上游返回未压缩响应
 * 原因：链路中的网关/代理可能把上游的压缩 body 原样透传，
 * 却把 content-encoding 响应头剥掉。undici 看不到 content-encoding 就不会解压，
 * 于是把一坨 gzip 字节当明文交回。
 */
function forceIdentityAcceptEncoding(headers: Record<string, string>): Record<string, string> {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== 'accept-encoding') {
      out[k] = headers[k];
    }
  }
  out['accept-encoding'] = 'identity';
  return out;
}

/**
 * 移除 Content-Length header
 * 原因：代理转发时会修改请求头（去掉 accept-encoding、加 trace header 等），
 * 客户端声明的 content-length 可能失真。透传旧值会触发 undici
 * UND_ERR_REQ_CONTENT_LENGTH_MISMATCH → 502 → CLI 静默重试退避。
 */
function stripContentLengthHeader(headers: Record<string, string>): Record<string, string> {
  if (!headers) return headers;
  const key = Object.keys(headers).find(k => k.toLowerCase() === 'content-length');
  if (!key) return headers;
  const { [key]: _omit, ...rest } = headers;
  return rest;
}

/**
 * 从 Claude 配置文件获取原始 Base URL（fallback 用）
 */
function getOriginalBaseUrl(): string {
  // 优先使用 Lucent 配置（取第一个 group 的 active profile）
  const config = getConfig();
  const firstGroup = config.groups[0];
  if (firstGroup) {
    const profile = firstGroup.profiles.find(p => p.id === firstGroup.activeProfileId);
    if (profile?.upstreamBaseUrl) {
      return profile.upstreamBaseUrl;
    }
  }

  const cwd = process.cwd();
  const claudeDir = CLAUDE_SETTINGS_DIR;

  // 优先级：当前项目配置 > 全局配置 > 环境变量 > 默认值
  const configPaths = [
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(claudeDir, 'settings.json'),
  ];

  for (const configPath of configPaths) {
    try {
      if (existsSync(configPath)) {
        const settings = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (settings.env?.ANTHROPIC_BASE_URL) {
          return settings.env.ANTHROPIC_BASE_URL;
        }
      }
    } catch {
      // 忽略错误，继续下一个
    }
  }

  // 检查环境变量
  if (process.env.ANTHROPIC_BASE_URL) {
    return process.env.ANTHROPIC_BASE_URL;
  }

  // 默认值
  return DEFAULT_UPSTREAM_URLS['anthropic-messages'];
}

/**
 * 从请求中提取原始 Base URL
 */
function getBaseUrlFromRequest(reqUrl: string): string {
  try {
    // 如果请求的是完整 URL，直接使用
    if (reqUrl.startsWith('http://') || reqUrl.startsWith('https://')) {
      const url = new URL(reqUrl);
      return url.origin;
    }

    // 否则使用配置的 Base URL
    return getOriginalBaseUrl();
  } catch {
    return getOriginalBaseUrl();
  }
}

// ==================== 代理服务器 ====================

export interface ProxyServer {
  port: number;
  stop: () => Promise<void>;
}

/**
 * 启动代理服务器
 */
export async function startProxyServer(options?: { port?: number; host?: string }): Promise<ProxyServer> {
  const port = options?.port || DEFAULT_PROXY_PORT;
  const host = options?.host || DEFAULT_SERVER_HOST;

  return new Promise<ProxyServer>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        // 获取原始 Base URL
        const originalBaseUrl = getBaseUrlFromRequest(req.url ?? '/');

        // 转换 incoming headers
        let headers: Record<string, string> = { ...req.headers } as Record<string, string>;
        delete headers.host; // 让 fetch 设置 host

        // Debug: 显示接收到的鉴权信息
        const downstreamAuth = headers['authorization'];
        const downstreamApiKey = headers['x-api-key'];
        log('📥 下游鉴权: authorization=%s, x-api-key=%s',
          downstreamAuth ? (downstreamAuth.slice(0, 20) + '...') : '(none)',
          downstreamApiKey ? (downstreamApiKey.slice(0, 8) + '...') : '(none)');

        delete headers.authorization; // 上游不认 OAuth token，只保留 x-api-key

        log('🔧 删除 authorization 后的鉴权: x-api-key=%s',
          headers['x-api-key'] ? (headers['x-api-key'].slice(0, 8) + '...') : '(none)');

        // 应用请求头转换
        headers = forceIdentityAcceptEncoding(headers);
        headers = stripContentLengthHeader(headers);

        // 读取请求 body（完整缓冲，因为 interceptor 需要解析 JSON 做日志记录；
        // LLM API 请求体量通常在 KB~MB 级别，不需要流式传输）
        const buffers: Buffer[] = [];
        let bodySize = 0;
        for await (const chunk of req) {
          bodySize += chunk.length;
          if (bodySize > MAX_REQUEST_BODY_SIZE) {
            log('请求体超限: %d bytes (限制 %d bytes)', bodySize, MAX_REQUEST_BODY_SIZE);
            res.writeHead(413, { 'content-type': 'text/plain' });
            res.end(`Request body too large (${bodySize} > ${MAX_REQUEST_BODY_SIZE} bytes)`);
            return;
          }
          buffers.push(chunk);
        }
        const body = Buffer.concat(buffers);

        // 准备 fetch 选项
        const fetchOptions: RequestInit = {
          method: req.method,
          headers: headers,
        };

        // 标记此请求为 Lucent 代理转发的请求
        // 拦截器识别到此 Header 会强制记录
        fetchOptions.headers = {
          ...fetchOptions.headers,
          [PROXY_TRACE_HEADER]: 'true',
        } as HeadersInit;

        if (body.length > 0) {
          fetchOptions.body = body as any;
        }

        // 拼接完整 URL
        const cleanBase = originalBaseUrl.endsWith('/') ? originalBaseUrl.slice(0, -1) : originalBaseUrl;
        const reqUrl = req.url ?? '/';
        const cleanReq = reqUrl.startsWith('/') ? reqUrl.slice(1) : reqUrl;
        const fullUrl = `${cleanBase}/${cleanReq}`;

        // Debug: 检测 API 类型并显示配置的鉴权信息
        const apiType = detectApiType(fullUrl);
        if (apiType) {
          const activeProfile = getActiveProfileForApiType(apiType);
          const hasApiKey = activeProfile?.apiKey ? activeProfile.apiKey.length > 0 : false;
          log('🔧 配置鉴权: apiType=%s, profile=%s, hasApiKey=%s',
            apiType,
            activeProfile?.name || 'none',
            hasApiKey ? `yes(${activeProfile?.apiKey?.slice(0, 8)}...)` : 'no');

          // 根据上游 API 要求设置鉴权头
          if (hasApiKey && activeProfile?.apiKey) {
            if (apiType === 'anthropic-messages') {
              headers['x-api-key'] = activeProfile.apiKey;
            } else {
              headers['authorization'] = `Bearer ${activeProfile.apiKey}`;
            }
            log('🔐 应用配置鉴权: %s',
              apiType === 'anthropic-messages'
                ? `x-api-key=${activeProfile.apiKey.slice(0, 8)}...`
                : `authorization=Bearer ${activeProfile.apiKey.slice(0, 8)}...`);
          }
        } else {
          log('⚠️  无法检测 API 类型: url=%s', fullUrl);
        }

        // Debug: 显示最终发送到上游的鉴权
        const finalAuth = (fetchOptions.headers as Record<string, string>)['authorization'];
        const finalApiKey = (fetchOptions.headers as Record<string, string>)['x-api-key'];
        log('📤 发送到上游鉴权: authorization=%s, x-api-key=%s',
          finalAuth ? (finalAuth.slice(0, 20) + '...') : '(none)',
          finalApiKey ? (finalApiKey.slice(0, 8) + '...') : '(none)');
        log('🔗 代理请求: %s %s -> %s', req.method, req.url, fullUrl);

        // 发起请求
        const response = await fetch(fullUrl, fetchOptions);

        // 处理响应头（fetch 自动解压，需移除编码相关 header）
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of response.headers.entries()) {
          // 跳过 Content-Encoding、Transfer-Encoding 和 Content-Length
          if (
            key.toLowerCase() !== 'content-encoding' &&
            key.toLowerCase() !== 'transfer-encoding' &&
            key.toLowerCase() !== 'content-length'
          ) {
            responseHeaders[key] = value;
          }
        }

        // 处理错误响应
        if (!response.ok) {
          try {
            const errorText = await response.text();
            log('❌ 上游错误响应: status=%d body=%s', response.status, errorText);
            log('❌ 上游鉴权失败可能原因: 未配置上游 apiKey 或 apiKey 无效');
            res.writeHead(response.status, responseHeaders);
            res.end(errorText);
            return;
          } catch (err) {
            // 读取 body 失败，回退到流式处理
            log('⚠️ 读取错误 body 失败: %O', err);
          }
        }

        log('✅ 上游响应成功: status=%d', response.status);

        res.writeHead(response.status, responseHeaders);

        if (response.body) {
          // 流式传输响应
          const { Readable, pipeline } = await import('node:stream');
          // @ts-ignore
          const nodeStream = Readable.fromWeb(response.body);

          // 持久 error handler 兜底
          nodeStream.on('error', () => {});

          // pipeline 处理流错误
          pipeline(nodeStream, res, (err) => {
            if (err) {
              // EPIPE 是客户端断开，正常情况，静默处理
              if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
                log('客户端断开连接: %s', req.url);
                return;
              }
              log('Stream pipeline 错误: %s', err.message);
            }
          });
        } else {
          res.end();
        }
      } catch (err) {
        log('代理错误: %O', err);
        res.statusCode = 502;
        res.end('Proxy Error');
      }
    });

    // 启动服务器
    server.listen(port, host, () => {
      console.log(`[Lucent] 代理服务器: http://${host}:${port}`);
      resolve({
        port,
        stop: async () => {
          return new Promise<void>((resolveStop, rejectStop) => {
            server.close((err) => {
              if (err) {
                rejectStop(err);
              } else {
                resolveStop();
              }
            });
          });
        },
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[Lucent] ⚠️ 代理端口 ${port} 已被占用，请检查是否有其他 Lucent 实例正在运行`);
        console.error(`[Lucent]   提示: lsof -i :${port} 或 kill $(lsof -ti :${port})`);
      } else {
        console.error('[Lucent] 代理服务器启动失败:', err.message);
      }
      reject(err);
    });
  });
}
