/**
 * HTTP 错误映射共享 util（#14）
 *
 * providers 与 body-rewrites 路由原先各自维护一份靠正则匹配 error.message 反推状态码的
 * mapErrorToStatus：两份关键词会漂移，且依赖英文文案；下游 500 错误信息若含 'must'/'invalid'
 * 会被误判成 400，掩盖真实故障。此处收敛为单源 httpStatusFromError，两路由共用。
 */

/**
 * 将下层（config.ts CRUD / 校验）抛出的错误翻译为 HTTP 状态码。
 *
 * 优先级：
 *   1. err.code（类型化错误码——根治方向）：
 *      - 'EINVALID'  → 400
 *      - 'ENOTFOUND' → 404
 *      - 'ECONFLICT' → 409
 *      - 其他非空 code（如 Node fs 的 EACCES/ENOSPC 等系统错误）→ 500
 *        携带 code 但非已知业务码，视为真实服务端故障，不再靠正则猜，
 *        避免 message 含 'must'/'invalid' 的系统错误被误判 400（#14 核心修复）。
 *   2. 无 code 的纯文本 Error（当前 config.ts 校验/CRUD 抛错形态）→ message 关键词正则兜底：
 *      - /already exists|duplicate/i        → 409
 *      - /not found/i                       → 404
 *      - /invalid|cannot|must|unknown key|missing key|fieldpath|pattern|flags/i → 400
 *   3. 默认 500
 *
 * 注：纯关键词反推有固有局限——当前 config.ts 抛的是无 code 的 Error，只能靠 message 兜底；
 *   将来 config.ts 校验改抛带 code 的类型化错误后，上面的 code 分支将自动精准接管，
 *   正则兜底可逐步退役（接口已为此预留）。
 */
export function httpStatusFromError(err: unknown): number {
  // 1. 类型化 code 优先
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === 'EINVALID') return 400;
  if (code === 'ENOTFOUND') return 404;
  if (code === 'ECONFLICT') return 409;
  // 携带其他 code（系统错误等）→ 真实服务端故障，不正则猜（防 'must' 误判 400）
  if (code !== undefined && code !== null && code !== '') return 500;

  // 2. 无 code → message 关键词兜底（当前 config.ts 抛纯文本 Error 的形态）
  const msg = err instanceof Error ? err.message : String(err);
  if (/already exists|duplicate/i.test(msg)) return 409;
  if (/not found/i.test(msg)) return 404;
  if (/invalid|cannot|must|unknown key|missing key|fieldpath|pattern|flags/i.test(msg)) return 400;
  return 500;
}
