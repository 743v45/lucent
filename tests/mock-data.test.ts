/**
 * Mock数据测试示例
 *
 * 演示如何使用测试工具加载和验证mock数据
 */

import { describe, it, expect } from 'vitest';
import {
  loadMockData,
  filterLogs,
  getAgentTypeStats,
  getTokenUsageStats,
  getKVCacheStats,
  getErrorLogs,
  printLogSummary,
  validateLogEntry,
  createMockLogEntry,
} from './test-utils.js';

describe('Mock日志数据测试', () => {
  describe('加载和解析', () => {
    it('应该成功加载mock数据', () => {
      const logs = loadMockData();
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.length).toBe(6); // 6个Agent ID（每个最后一条完整记录）
    });

    it('每个日志条目都应该包含必需字段', () => {
      const logs = loadMockData();

      for (const log of logs) {
        expect(validateLogEntry(log)).toBe(true);
        expect(log.id).toBeDefined();
        expect(log.timestamp).toBeDefined();
        expect(log.request).toBeDefined();
        expect(log.response).toBeDefined();
        expect(log.agentType).toBeDefined();
        expect(log.metadata).toBeDefined();
      }
    });
  });

  describe('Agent类型统计', () => {
    it('应该正确统计主Agent和子Agent数量', () => {
      const logs = loadMockData();
      const stats = getAgentTypeStats(logs);

      expect(stats.main).toBe(2); // abc123main, context01
      expect(stats.sub).toBe(4); // toolbash01, toolplan01, workflowxyz, search01
    });
  });

  describe('Token使用统计', () => {
    it('应该正确计算总Token使用量', () => {
      const logs = loadMockData();
      const stats = getTokenUsageStats(logs);

      expect(stats.totalInput).toBeGreaterThan(0);
      expect(stats.totalOutput).toBeGreaterThan(0);
      expect(stats.averageInput).toBeGreaterThan(0);
      expect(stats.averageOutput).toBeGreaterThan(0);
    });

    it('应该包含缓存Token统计', () => {
      const logs = loadMockData();
      const stats = getTokenUsageStats(logs);

      expect(stats.totalCacheRead).toBeGreaterThan(0);
      expect(stats.totalCacheCreate).toBeGreaterThan(0);
    });
  });

  describe('KV-Cache统计', () => {
    it('应该正确统计有缓存的日志', () => {
      const logs = loadMockData();
      const stats = getKVCacheStats(logs);

      expect(stats.withCache).toBe(1); // 只有 abc123main 有 kvCache
      expect(stats.withoutCache).toBe(5); // 其他5个没有
    });

    it('应该计算正确的平均命中率', () => {
      const logs = loadMockData();
      const stats = getKVCacheStats(logs);

      expect(stats.averageHitRate).toBeGreaterThan(0);
      expect(stats.averageHitRate).toBeLessThanOrEqual(1);
    });
  });

  describe('错误处理', () => {
    it('应该识别错误日志', () => {
      const logs = loadMockData();
      const errors = getErrorLogs(logs);

      expect(errors.length).toBe(1);
      expect(errors[0].id).toBe('1717304601123_workflowxyz');
      expect(errors[0].response.status).toBe(429);
      expect(errors[0].error).toBe('Rate limit exceeded');
    });
  });

  describe('过滤功能', () => {
    it('应该按Agent类型过滤', () => {
      const logs = loadMockData();
      const mainOnly = filterLogs(logs, { agentType: 'main' });
      const subOnly = filterLogs(logs, { agentType: 'sub' });

      expect(mainOnly.length).toBe(2);
      expect(subOnly.length).toBe(4);
      expect(mainOnly.every(log => log.agentType === 'main')).toBe(true);
      expect(subOnly.every(log => log.agentType === 'sub')).toBe(true);
    });

    it('应该按Provider过滤', () => {
      const logs = loadMockData();
      const claudeOnly = filterLogs(logs, { provider: 'claude' });

      expect(claudeOnly.length).toBe(logs.length); // 所有都是claude
    });

    it('应该按搜索查询过滤', () => {
      const logs = loadMockData();
      const searchResults = filterLogs(logs, { searchQuery: 'workflow' });

      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults.some(log =>
        log.id.includes('workflow') ||
        log.request.url.includes('workflow') ||
        JSON.stringify(log.response.body).toLowerCase().includes('workflow')
      )).toBe(true);
    });
  });

  describe('工具函数', () => {
    it('应该能够创建mock日志条目', () => {
      const mockLog = createMockLogEntry({
        agentType: 'sub',
      });

      expect(validateLogEntry(mockLog)).toBe(true);
      expect(mockLog.agentType).toBe('sub');
    });

    it('应该能够覆盖默认值', () => {
      const customLog = createMockLogEntry({
        id: 'test-123',
        duration: 5000,
        metadata: {
          model: 'claude-opus-4-8',
          provider: 'claude',
          stream: true,
        },
      });

      expect(customLog.id).toBe('test-123');
      expect(customLog.duration).toBe(5000);
      expect(customLog.metadata.model).toBe('claude-opus-4-8');
      expect(customLog.metadata.stream).toBe(true);
    });
  });

  describe('打印摘要', () => {
    it('应该成功打印日志摘要（仅检查不抛错）', () => {
      const logs = loadMockData();

      expect(() => {
        printLogSummary(logs);
      }).not.toThrow();
    });
  });
});
