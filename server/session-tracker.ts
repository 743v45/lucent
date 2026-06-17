/**
 * 会话识别器：用「首条 user 指纹 + messages 前缀校验」给 main 请求打 threadId。
 */
import { CHECKPOINT_KEY_CONTENT_LENGTH, MAX_SESSIONS } from './constants.js';
import { extractContext } from './context-extractors.js';
import createDebug from 'debug';
const dbg = createDebug('lucent:session');

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

export class SessionTracker {
  private sessions = new Map<string, SessionLineage[]>(); // anchorKey → lineages

  /** 给一个请求算 threadId（undefined=未归类）。必须传完整原始 body。 */
  identify(body: unknown, url: string, timestamp: string): string | undefined {
    const extracted = extractContext(body, url);
    if (!extracted || !extracted.messages.length) return undefined;
    const messages = extracted.messages as LikeMessage[];
    const anchorKey = computeAnchorKey(messages);
    if (!anchorKey) return undefined;
    const fpSeq = computeFingerprintSeq(messages);

    const lineages = this.sessions.get(anchorKey) ?? [];
    const cont = findContinuation(lineages, fpSeq);

    let threadId: string;
    if (cont) {
      cont.msgFingerprints = fpSeq;
      cont.lastTimestamp = timestamp;
      cont.requestCount++;
      threadId = cont.threadId;
    } else {
      const n = lineages.length + 1;
      threadId = n === 1 ? anchorKey : `${anchorKey}-${n}`;
      lineages.push({ threadId, msgFingerprints: fpSeq, lastTimestamp: timestamp, requestCount: 1 });
      this.sessions.set(anchorKey, lineages);
      this.cleanup();
    }
    dbg('identify threadId=%s anchor=%s fpLen=%d', threadId, anchorKey, fpSeq.length);
    return threadId;
  }

  /** MVP no-op：delta 格式历史 entry 无完整 messages，重建会算错锚点；
   *  threadId 内容寻址已保证分组正确，活跃会话链自然重建。 */
  rebuildFromLogs(_entries: unknown[]): void {
    // 故意留空，见 spec deviation #1
  }

  reset(): void {
    this.sessions.clear();
  }

  private cleanup(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const sorted = [...this.sessions.entries()].sort((a, b) => {
      const aLast = Math.max(...a[1].map(l => new Date(l.lastTimestamp).getTime() || 0));
      const bLast = Math.max(...b[1].map(l => new Date(l.lastTimestamp).getTime() || 0));
      return aLast - bLast;
    });
    for (const [key] of sorted.slice(0, this.sessions.size - MAX_SESSIONS)) {
      this.sessions.delete(key);
    }
  }
}

export const globalSessionTracker = new SessionTracker();
