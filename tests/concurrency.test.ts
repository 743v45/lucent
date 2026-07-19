import { describe, it, expect } from 'vitest';
import { makeSemaphore } from '../src/utils/concurrency.js';

describe('makeSemaphore', () => {
  it('限制并发数，超额排队且不超 max', async () => {
    const sem = makeSemaphore(2);
    let active = 0;
    let maxObserved = 0;
    const task = async () => {
      active++;
      maxObserved = Math.max(maxObserved, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => sem(task)));
    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  it('结果正常透传', async () => {
    const sem = makeSemaphore(1);
    expect(await sem(async () => 42)).toBe(42);
  });

  it('任务抛错时 reject 且不卡死信号量（后续任务正常）', async () => {
    const sem = makeSemaphore(1);
    await expect(sem(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await sem(async () => 'ok')).toBe('ok');
  });

  it('max=1 退化为串行', async () => {
    const sem = makeSemaphore(1);
    let active = 0;
    let maxObserved = 0;
    const task = async () => {
      active++;
      maxObserved = Math.max(maxObserved, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    await Promise.all(Array.from({ length: 4 }, () => sem(task)));
    expect(maxObserved).toBe(1);
  });
});
