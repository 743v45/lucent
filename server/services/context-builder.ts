/**
 * Context 构建服务
 *
 * 从 request.body 构建前端需要的 context 数据
 *
 * 注意：核心逻辑已合并到 log-reader.ts 的 buildContextFromRequest 中
 * 此文件仅用于导出独立的 buildContextFromRequest 供外部使用
 */

// buildContextFromRequest 已内联到 log-reader.ts 中
// 此文件保留为空，避免破坏可能的导入

export { readLogs, getLogById } from './log-reader.js';
