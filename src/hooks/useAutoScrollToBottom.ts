import { useEffect, useRef, useCallback } from 'react';

/**
 * 自动滚动到底部的 Hook
 *
 * 用于让内容默认滚动到底部，并在需要时触发滚动
 */
export function useAutoScrollToBottom() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollToBottom = useCallback(() => {
    // 清除之前的定时器
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    // 使用 setTimeout 确保在 DOM 更新后执行滚动
    scrollTimeoutRef.current = setTimeout(() => {
      const element = scrollRef.current;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    }, 0);
  }, []);

  // 组件挂载时自动滚动到底部
  useEffect(() => {
    scrollToBottom();

    // 清理函数
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [scrollToBottom]);

  return { scrollRef, scrollToBottom };
}
