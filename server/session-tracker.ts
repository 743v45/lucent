/**
 * 会话识别器：用「首条 user 指纹 + messages 前缀校验」给 main 请求打 threadId。
 * 与 delta-storage（存储压缩）独立，identify 必须收完整原始 body（delta slice 之前）。
 */
import { CHECKPOINT_KEY_CONTENT_LENGTH } from './constants.js';

interface LikeMessage {
  role: string;
  content: unknown;
}

export interface SessionLineage {
  threadId: string;
  msgFingerprints: string[];
  lastTimestamp: string;
  requestCount: number;
}

/** djb2 哈希（复用 context-rebuilder 已验证实现）→ base36 */
function djb2Hash(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** 从 string 或 ContentBlock[] 提取纯文本 */
function normalizeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('');
  }
  return '';
}

/** 单条 message 指纹 = role + 去空白截断内容的 hash */
function fingerprintMsg(msg: LikeMessage): string {
  const text = normalizeText(msg.content).replace(/\s/g, '').slice(0, CHECKPOINT_KEY_CONTENT_LENGTH);
  return `${msg.role}:${djb2Hash(text)}`;
}

/** 纯函数：首条 user 消息 → 锚点 key（thread_<hash>）。无 user/空内容返回 undefined */
export function computeAnchorKey(messages: LikeMessage[]): string | undefined {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return undefined;
  const text = normalizeText(firstUser.content).replace(/\s/g, '').slice(0, CHECKPOINT_KEY_CONTENT_LENGTH);
  if (!text) return undefined;
  return `thread_${djb2Hash(text)}`;
}

/** 纯函数：messages → 指纹序列 */
export function computeFingerprintSeq(messages: LikeMessage[]): string[] {
  return messages.map(fingerprintMsg);
}

function isPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length === 0 || prefix.length > full.length) return false;
  return prefix.every((fp, i) => fp === full[i]);
}

/** 纯函数：在 lineage 列表中找前缀匹配的续会话；多个匹配取最近时间戳 */
export function findContinuation(lineages: SessionLineage[], fpSeq: string[]): SessionLineage | undefined {
  const matches = lineages.filter(l => isPrefix(l.msgFingerprints, fpSeq));
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return matches.sort((a, b) =>
    new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime()
  )[0];
}
