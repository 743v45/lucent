/**
 * 简单并发信号量：限制同时执行的异步任务数。
 *
 * 超过 max 的调用排队等待；活跃任务完成释放后，按 FIFO 逐个放行排队的调用。
 * 用于会话视图首屏多组同时按 threadId 全量加载时削峰，避免瞬时 N 个全量分页请求。
 */
export function makeSemaphore(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  };

  return async function acquire<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      active++;
    }
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
