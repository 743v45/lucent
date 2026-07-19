/**
 * 定时自动刷新 Hook
 *
 * - interval='off' 不启动定时器；非 off 按 REFRESH_INTERVAL_MS[interval] 轮询调 onRefresh。
 * - 切换 interval 立即重建定时器（随 interval 变化的 effect）。
 * - skipIf() 为真时跳过本轮（防并发，默认接 () => logsLoading）。
 * - document.hidden 时 tick 直接返回（后台暂停）；回可见由 visibilitychange 立即补刷一次。
 * - interval 持久化到 localStorage（key 由调用方给）；初始化从 localStorage 读 + 非法值回退默认。
 *
 * 注：vitest 为 node 环境（见 vitest.config.ts），本 hook 不单测；行为靠 e2e 覆盖，
 * 仅纯函数 parseRefreshInterval 有 node 单测。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  REFRESH_INTERVAL_MS,
  parseRefreshInterval,
  type RefreshIntervalId,
} from '../constants';

export interface UseAutoRefreshOptions {
  /** 每 tick 调用一次（通常接 useLogs 的 loadLogs） */
  onRefresh: () => void | Promise<void>;
  /** 返回 true 则跳过本轮（默认不跳） */
  skipIf?: () => boolean;
  /** document.hidden 时暂停，回可见补刷一次（默认 true） */
  pauseWhenHidden?: boolean;
  /** localStorage 持久化 key */
  storageKey: string;
  /** 无存储值时的默认间隔（默认 'off'） */
  defaultValue?: RefreshIntervalId;
}

export interface UseAutoRefreshResult {
  interval: RefreshIntervalId;
  setRefreshInterval: (v: RefreshIntervalId) => void;
}

export function useAutoRefresh(opts: UseAutoRefreshOptions): UseAutoRefreshResult {
  const { onRefresh, skipIf, pauseWhenHidden = true, storageKey, defaultValue = 'off' } = opts;

  const [interval, setIntervalState] = useState<RefreshIntervalId>(() =>
    parseRefreshInterval(localStorage.getItem(storageKey), defaultValue),
  );

  // 回调用 ref：避免其引用变化（如 loadLogs 每次渲染新建）导致定时器频繁重建。
  // 定时器只应随 interval 变化重建。
  const onRefreshRef = useRef(onRefresh);
  const skipIfRef = useRef(skipIf);
  const pauseRef = useRef(pauseWhenHidden);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
    skipIfRef.current = skipIf;
    pauseRef.current = pauseWhenHidden;
  });

  const tick = useCallback(() => {
    if (pauseRef.current && document.hidden) return; // 后台暂停，不发请求
    if (skipIfRef.current?.()) return; // 上一轮还在进行，跳过
    void onRefreshRef.current();
  }, []);

  // 随 interval 重建定时器；off（ms=null）不建
  useEffect(() => {
    const ms = REFRESH_INTERVAL_MS[interval];
    if (ms == null) return;
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [interval, tick]);

  // 回到可见立即补刷一次（后台期间被 tick 暂停，切回前台补一次最新）
  useEffect(() => {
    if (!pauseWhenHidden || REFRESH_INTERVAL_MS[interval] == null) return;
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [interval, pauseWhenHidden, tick]);

  const setRefreshInterval = useCallback(
    (v: RefreshIntervalId) => {
      setIntervalState(v);
      localStorage.setItem(storageKey, v);
    },
    [storageKey],
  );

  return { interval, setRefreshInterval };
}
