/**
 * Lucent HTTP 代理转发模块
 *
 * 功能：
 * - 接收客户端请求
 * - 按 /{name}/{rest} 或 /custom/{name}/{rest} 路径解析供应商 + 端点
 * - 转发到真实 API (OpenAI/Claude)
 * - 支持 SSE 流式响应
 * - 处理鉴权头注入
 */

import { createServer } from 'node:http';
import { getConfig, findProviderByName } from './config.js';
import { type EndpointType } from './types.js';
import {
  DEFAULT_PROXY_PORT,
  DEFAULT_SERVER_HOST,
  PROXY_TRACE_HEADER,
  MAX_REQUEST_BODY_SIZE,
} from './constants.js';
import createDebug from 'debug';
const log = createDebug('lucent:proxy');

// ==================== 路径解析 ====================

/**
 * 匹配两种代理路径：
 * - /{name}/{rest}      预设供应商
 * - /custom/{name}/{rest} 自定义供应商
 * name: provider name（只允许 [a-zA-Z0-9_-]+）
 * rest: 剩余路径（如 /v1/messages）
 */
const PATH_REGEX = /^\/(?:custom\/)?([a-zA-Z0-9_-]+)(\/.*)$/;

/**
 * 从 rest 子路径推断 endpointType
 * - /v1/messages → anthropic-messages
 * - /v1/chat/completions 或 /v1/completions → openai-chat
 * - /v1/responses → openai-responses
 * - 其它 → null（不支持）
 */
function inferEndpointType(rest: string): EndpointType | null {
  if (rest === '/v1/messages') return 'anthropic-messages';
  if (rest === '/v1/chat/completions' || rest === '/v1/completions') return 'openai-chat';
  if (rest === '/v1/responses') return 'openai-responses';
  return null;
}

// ==================== 请求头处理 ====================

/**
 * 强制上游返回未压缩响应
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
 */
function stripContentLengthHeader(headers: Record<string, string>): Record<string, string> {
  if (!headers) return headers;
  const key = Object.keys(headers).find(k => k.toLowerCase() === 'content-length');
  if (!key) return headers;
  const { [key]: _omit, ...rest } = headers;
  return rest;
}

// ==================== 错误响应 ====================

function sendJsonError(res: any, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
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
        const reqUrl = req.url ?? '/';

        // 1. 解析路径
        const match = PATH_REGEX.exec(reqUrl);
        if (!match) {
          sendJsonError(res, 404, `路径格式错误，必须为 /{name}/{rest} 或 /custom/{name}/{rest}`);
          return;
        }

        const [, providerName, rest] = match;

        // 2. 查找 provider
        const config = getConfig();
        const provider = findProviderByName(config, providerName);
        if (!provider) {
          sendJsonError(res, 404, `provider '${providerName}' not found`);
          return;
        }

        // 3. 推断 endpointType
        const endpointType = inferEndpointType(rest);
        if (!endpointType) {
          sendJsonError(res, 404, `unsupported endpoint path: ${rest}`);
          return;
        }

        // 4. 检查 provider 是否支持此端点
        const baseUrl = provider.endpoints[endpointType];
        if (!baseUrl) {
          sendJsonError(res, 404, `provider '${providerName}' does not support ${endpointType}`);
          return;
        }

        // 5. 转换请求头（纯透传，不修改鉴权头）
        let headers: Record<string, string> = { ...req.headers } as Record<string, string>;
        delete headers.host;

        headers = forceIdentityAcceptEncoding(headers);
        headers = stripContentLengthHeader(headers);

        // 标记代理转发 + 传递路由信息给拦截器
        headers[PROXY_TRACE_HEADER] = 'true';
        headers['x-lucent-provider'] = providerName;
        headers['x-lucent-endpoint'] = endpointType;

        log('🧩 路由解析: provider=%s endpointType=%s rest=%s baseUrl=%s',
          providerName, endpointType, rest, baseUrl);

        // 7. 读取请求 body
        const buffers: Buffer[] = [];
        let bodySize = 0;
        for await (const chunk of req) {
          bodySize += chunk.length;
          if (bodySize > MAX_REQUEST_BODY_SIZE) {
            log('请求体超限: %d bytes', bodySize);
            sendJsonError(res, 413, `Request body too large (${bodySize} > ${MAX_REQUEST_BODY_SIZE} bytes)`);
            return;
          }
          buffers.push(chunk);
        }
        const body = Buffer.concat(buffers);

        // 8. 拼接完整上游 URL
        const cleanBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        const fullUrl = `${cleanBase}${rest}`;

        log('🔗 代理转发: %s %s → %s', req.method, reqUrl, fullUrl);

        // 9. 发起请求
        const fetchOptions: RequestInit = {
          method: req.method,
          headers,
        };
        if (body.length > 0) {
          fetchOptions.body = body;
        }

        const response = await fetch(fullUrl, fetchOptions);

        // 10. 处理响应头
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of response.headers.entries()) {
          if (
            key.toLowerCase() !== 'content-encoding' &&
            key.toLowerCase() !== 'transfer-encoding' &&
            key.toLowerCase() !== 'content-length'
          ) {
            responseHeaders[key] = value;
          }
        }

        // 11. 处理错误响应
        if (!response.ok) {
          try {
            const errorText = await response.text();
            log('❌ 上游错误: status=%d body=%s', response.status, errorText);
            res.writeHead(response.status, responseHeaders);
            res.end(errorText);
            return;
          } catch {
            // 读取失败，回退流式
          }
        }

        log('✅ 上游响应: status=%d', response.status);
        res.writeHead(response.status, responseHeaders);

        // 12. 流式传输响应
        if (response.body) {
          const { Readable, pipeline } = await import('node:stream');
          // @ts-ignore
          const nodeStream = Readable.fromWeb(response.body);
          nodeStream.on('error', () => {});
          pipeline(nodeStream, res, (err) => {
            if (err && (err as NodeJS.ErrnoException).code !== 'EPIPE') {
              log('Stream 错误: %s', err.message);
            }
          });
        } else {
          res.end();
        }
      } catch (err) {
        log('代理错误: %O', err);
        sendJsonError(res, 502, 'Proxy Error');
      }
    });

    server.listen(port, host, () => {
      resolve({
        port,
        stop: async () => {
          return new Promise<void>((resolveStop, rejectStop) => {
            server.close((err) => {
              if (err) rejectStop(err);
              else resolveStop();
            });
          });
        },
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[Lucent] ⚠️ 代理端口 ${port} 已被占用`);
      } else {
        console.error('[Lucent] 代理服务器启动失败:', err.message);
      }
      reject(err);
    });
  });
}