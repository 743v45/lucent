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
import { inferEndpointTypeFromPath } from './endpoint-registry.js';
import { applyBodyRewritesToBuffer } from './body-rewriter.js';
import {
  DEFAULT_PROXY_PORT,
  DEFAULT_SERVER_HOST,
  PROXY_TRACE_HEADER,
  REQ_START_HEADER,
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
 * - /v1/messages 或 /messages → anthropic-messages
 * - /v1/chat/completions 或 /chat/completions → openai-chat
 * - /v1/completions 或 /completions → openai-chat
 * - /v1/responses 或 /responses → openai-responses
 * - 其它 → null（不支持）
 */
function inferEndpointType(rest: string): EndpointType | null {
  const path = rest.split('?')[0];
  const stripped = path.replace(/^\/v1(?=\/)/, '');
  return inferEndpointTypeFromPath(stripped);
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
  // 响应头可能已被上游流式分支写出发送，二次 writeHead 会抛 ERR_HTTP_HEADERS_SENT
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

/**
 * 读取响应体并限制最大字节数，超限时截断
 * 防止超大响应体撑爆内存
 */
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let result = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      // 取到上限为止的部分，剩余丢弃
      const remaining = maxBytes - (received - value.byteLength);
      if (remaining > 0) {
        result += decoder.decode(value.subarray(0, remaining));
      }
      try { reader.cancel(); } catch { /* ignore */ }
      result += `\n[truncated at ${maxBytes} bytes]`;
      return result;
    }
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
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
      const reqUrl = req.url ?? '/';
      const startTime = Date.now();
      const clientIp = req.socket.remoteAddress;

      // 响应写出时打印一条完整日志
      const originalWriteHead = res.writeHead.bind(res);
      res.writeHead = (statusCode: number, ...args: any[]) => {
        const duration = Date.now() - startTime;
        console.log(`[Lucent Proxy] ${req.method} ${reqUrl} ${statusCode} ${duration}ms ip=${clientIp}`);
        return originalWriteHead(statusCode, ...args);
      };

      try {
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
        // TTFT/Duration 时钟起点：客户端请求到达代理的时刻（startTime 在请求入口取）
        headers[REQ_START_HEADER] = String(startTime);

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

        // 7.5 可选：body 重写规则（opt-in，仅当配置启用规则 + JSON body 时尝试）
        // 三层保护：body-rewriter 内部 try/catch + 此处 try/catch + outBody 至少等于原 body
        // 标注 Uint8Array：body（Buffer<ArrayBuffer>，Buffer.concat 返回）与 rewritten
        // （Buffer<ArrayBufferLike>，body-rewriter 返回）泛型参数不一致，但都是 Uint8Array 子类型；
        // Uint8Array 是 BodyInit 的 BufferSource 成员，赋给 fetchOptions.body 无类型摩擦
        let outBody: Uint8Array = body;
        const rewrites = config.bodyRewrites;
        if (rewrites && rewrites.length > 0 && body.length > 0) {
          try {
            const ct = headers['content-type'] ?? '';
            const { buffer: rewritten, applied } = applyBodyRewritesToBuffer(body, rewrites, ct);
            if (applied > 0) {
              outBody = rewritten;
              log('🔄 body 重写命中: provider=%s endpoint=%s applied=%d', providerName, endpointType, applied);
            }
          } catch (err) {
            log('body 重写异常，使用原 body: %s', (err as Error).message);
          }
        }

        // 8. 拼接完整上游 URL（去掉 rest 中的 /v1 前缀，由 baseUrl 提供版本路径）
        const cleanBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        const apiPath = rest.replace(/^\/v1(?=\/)/, '');
        const fullUrl = `${cleanBase}${apiPath}`;

        log('🔗 代理转发: %s %s → %s', req.method, reqUrl, fullUrl);

        // 9. 发起请求
        const fetchOptions: RequestInit = {
          method: req.method,
          headers,
        };
        if (outBody.length > 0) {
          // as BodyInit：Node fetch 运行时接受 Buffer/Uint8Array；类型上 @types/node 的
          // ArrayBufferLike 与 lib.dom BodyInit（要求 ArrayBuffer）有摩擦，断言绕过
          fetchOptions.body = outBody as BodyInit;
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
            // 限制错误体读取量，防止超大错误响应撑爆内存
            const MAX_ERROR_BODY = 64 * 1024; // 64KB
            const errorText = await readBodyWithLimit(response, MAX_ERROR_BODY);
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
          // @ts-expect-error — Readable.fromWeb 类型在当前 @types/node 下不完全
          const nodeStream = Readable.fromWeb(response.body);
          // 非 EPIPE 错误（如上游读取异常）记录日志，便于排查
          nodeStream.on('error', (err) => {
            if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
              log('上游流错误: %s', err.message);
            }
          });
          // 客户端中途断开时主动销毁上游流，让断开传播到上游，
          // 避免后台 tee 提取任务悬挂
          res.on('close', () => {
            if (!res.writableEnded) {
              nodeStream.destroy();
            }
          });
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