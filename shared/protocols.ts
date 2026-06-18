/**
 * shared/protocols.ts — 三协议身份维度单源
 *
 * Lucent 支持的三个上游协议(anthropic-messages / openai-chat / openai-responses)
 * 的身份字段在此唯一声明:id / label / strippedPaths / defaultTestModel / schemaDocRef。
 *
 * 一切「这个协议叫什么、认领哪些 path、用什么测试模型、对应哪份 schema 文档」的
 * 问题,答案都在这张表里。其他文件(types.ts / endpoint-handlers.ts /
 * context-extractors.ts / routes/providers.ts)一律从本表派生,不得手写字面量。
 *
 * 覆盖的事件提取逻辑见 shared/sse-events.ts(那是行为,这里是身份)。
 */

/** 单个协议的身份描述符 */
export interface ProtocolDescriptor {
  /** 协议标识,同时是 PROTOCOL_REGISTRY 的键 */
  id: ProtocolId;
  /** 展示名(UI label,如 "Anthropic Messages") */
  label: string;
  /**
   * 去掉 /v1 前缀后的认领路径数组。registry 的 matchPath / detectEndpointType /
   * 测试连接 testUrl 三处共用此单源。
   *
   * 不变量:任意两个协议的 strippedPaths 不得有交集(否则 inferEndpointTypeFromPath
   * 遍历时会误判)。
   */
  strippedPaths: readonly string[];
  /** 测试连接用的廉价模型(最小化 token 消耗) */
  defaultTestModel: string;
  /** 对应 docs/protocols/ 下的权威 schema 文档路径 */
  schemaDocRef: string;
}

/** 协议标识联合类型(派生源,其他文件的 EndpointType 都从此派生) */
export type ProtocolId =
  | 'anthropic-messages'
  | 'openai-chat'
  | 'openai-responses';

/** 协议注册表——三协议身份维度的唯一真相源 */
export const PROTOCOL_REGISTRY = {
  'anthropic-messages': {
    id: 'anthropic-messages',
    label: 'Anthropic Messages',
    strippedPaths: ['/messages'],
    defaultTestModel: 'claude-sonnet-4-20250514',
    schemaDocRef: 'docs/protocols/01-anthropic-messages.md',
  },
  'openai-chat': {
    id: 'openai-chat',
    label: 'OpenAI Chat',
    strippedPaths: ['/chat/completions', '/completions'],
    defaultTestModel: 'gpt-4o-mini',
    schemaDocRef: 'docs/protocols/02-openai-chat-completions.md',
  },
  'openai-responses': {
    id: 'openai-responses',
    label: 'OpenAI Responses',
    strippedPaths: ['/responses'],
    defaultTestModel: 'gpt-4o-mini',
    schemaDocRef: 'docs/protocols/03-openai-responses.md',
  },
} as const satisfies Record<ProtocolId, ProtocolDescriptor>;

/** 所有协议 id(派生自 registry,不得手写) */
export const PROTOCOL_IDS = Object.keys(PROTOCOL_REGISTRY) as ProtocolId[];
