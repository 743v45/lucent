/**
 * 根据 response headers 的 Content-Type 判断响应类型
 * 优先级：response Content-Type > metadata.stream
 *
 * @returns 'sse' | 'json'
 */
export function resolveResponseType(
  responseContentType: string | undefined,
  metadataStream: boolean | undefined,
): 'sse' | 'json' {
  const ct = (responseContentType ?? '').toLowerCase();
  if (ct.includes('text/event-stream')) return 'sse';
  if (ct.includes('application/json')) return 'json';
  // 回退到 request body.stream
  return metadataStream ? 'sse' : 'json';
}
