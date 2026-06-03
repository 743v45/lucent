/**
 * AgentProxy HTTP 代理转发模块
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
import { homedir } from 'node:os';
import { getActiveProfile } from './config.js';

// ==================== 配置 ====================
const PROXY_CONFIG = {
  defaultPort: 7048,
  host: '127.0.0.1',
} as const;

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
 * 原因：代理会改写请求 body（interceptor 的模型替换 JSON.parse→改 model→JSON.stringify），
 * 客户端声明的 content-length 随之失真。透传旧值会触发 undici
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
  // 优先使用 AgentProxy 配置
  const activeProfile = getActiveProfile();
  if (activeProfile?.upstreamBaseUrl) {
    return activeProfile.upstreamBaseUrl;
  }

  const cwd = process.cwd();
  const claudeDir = join(homedir(), '.claude');

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
  return 'https://api.anthropic.com';
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
export async function startProxyServer(options?: { port?: number }): Promise<ProxyServer> {
  const port = options?.port || PROXY_CONFIG.defaultPort;

  return new Promise<ProxyServer>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        // 获取原始 Base URL
        const originalBaseUrl = getBaseUrlFromRequest(req.url);

        // 转换 incoming headers
        let headers: Record<string, string> = { ...req.headers } as Record<string, string>;
        delete headers.host; // 让 fetch 设置 host

        // 应用请求头转换
        headers = forceIdentityAcceptEncoding(headers);
        headers = stripContentLengthHeader(headers);

        // 读取请求 body
        const buffers: Buffer[] = [];
        for await (const chunk of req) {
          buffers.push(chunk);
        }
        const body = Buffer.concat(buffers);

        // 准备 fetch 选项
        const fetchOptions: RequestInit = {
          method: req.method,
          headers: headers,
        };

        // 标记此请求为 AgentProxy 代理转发的请求
        // 拦截器识别到此 Header 会强制记录
        fetchOptions.headers = {
          ...fetchOptions.headers,
          'x-agentproxy-trace': 'true',
        } as HeadersInit;

        if (body.length > 0) {
          fetchOptions.body = body as any;
        }

        // 拼接完整 URL
        const cleanBase = originalBaseUrl.endsWith('/') ? originalBaseUrl.slice(0, -1) : originalBaseUrl;
        const cleanReq = req.url.startsWith('/') ? req.url.slice(1) : req.url;
        const fullUrl = `${cleanBase}/${cleanReq}`;

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
            res.writeHead(response.status, responseHeaders);
            res.end(errorText);
            return;
          } catch (err) {
            // 读取 body 失败，回退到流式处理
            console.error('[AgentProxy Proxy] Failed to read error body:', err);
          }
        }

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
              console.error('[AgentProxy Proxy] Stream pipeline error:', err.message);
            }
          });
        } else {
          res.end();
        }
      } catch (err) {
        console.error('[AgentProxy Proxy] Error:', err);
        res.statusCode = 502;
        res.end('Proxy Error');
      }
    });

    // 启动服务器
    server.listen(port, PROXY_CONFIG.host, () => {
      console.log(`[AgentProxy] 代理服务器: http://${PROXY_CONFIG.host}:${port}`);
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

    server.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * 创建代理服务器（不自动启动）
 */
export function createProxyServer(options?: { port?: number }): ProxyServer {
  let serverInstance: any = null;
  const port = options?.port || PROXY_CONFIG.defaultPort;

  return {
    port,
    stop: async () => {
      if (serverInstance) {
        return new Promise<void>((resolve, reject) => {
          serverInstance.close((err: Error) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      }
    },
  };
}
