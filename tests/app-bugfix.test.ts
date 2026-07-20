/**
 * App.tsx 侧栏拖拽 + SettingsContext 值稳定性 bugfix 单测（vitest node 环境）
 *
 * Bug #23：handleMouseMove 每像素 setSidebarWidth → App 整树逐像素重渲染（含 LogListPanel /
 *  DetailPanel），selectedLog=logs.find 每像素 O(n)；handleMouseUp 依赖 [sidebarWidth] 每像素变
 *  → 全局 mousemove/mouseup effect 每像素 removeEventListener/addEventListener，监听有 rebind 间隙丢失风险。
 *  修复：宽度用 ref 跟踪 + rAF 节流 setState；handleMouseUp 改读 ref.current，回调零依赖 → effect 只绑一次。
 *
 * Bug #24：settingsValue 是每渲染新建对象字面量、updatePreferences 每渲染新建函数，作 SettingsContext
 *  Provider value 传入 → 所有 useContext 消费者每次 App 渲染都被强制重渲染。
 *  修复：updatePreferences 用 useCallback，settingsValue 用 useMemo；引用仅在相关输入变化时换新。
 *
 * App 整体在 node 不可渲染（触达 document/localStorage/window + 自动刷新轮询），故抽出两个 DOM-free
 * 自定义 hook（useSidebarDrag / useSettingsValue）+ 两个纯函数（clampSidebarWidth / applyPreferencesUpdate），
 * 用 react-test-renderer（同 useLogs.test.ts 范式）测引用稳定性与逻辑分支。
 */
import { describe, it, expect, vi } from 'vitest';
import { create, act } from 'react-test-renderer';
import * as React from 'react';
import {
  clampSidebarWidth,
  applyPreferencesUpdate,
  useSidebarDrag,
  useSettingsValue,
} from '../src/App.js';
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../src/constants.js';
import type { TabType } from '../src/types';

/** renderHook + rerender：用 react-test-renderer 挂一个调用 hook 的空组件，支持以新 props 重渲染。 */
function renderHookWithRerender<P, T>(fn: (props: P) => T, initialProps: P) {
  const result = { current: undefined as T };
  function Probe(props: P) {
    result.current = fn(props);
    return null;
  }
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(Probe, initialProps));
  });
  return {
    result,
    rerender: (props: P) =>
      act(() => {
        renderer.update(React.createElement(Probe, props));
      }),
    unmount: () =>
      act(() => {
        renderer.unmount();
      }),
  };
}

describe('clampSidebarWidth — 侧栏宽度钳制（Bug #23 纯逻辑）', () => {
  it('低于下限回退到下限', () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 1)).toBe(SIDEBAR_MIN_WIDTH);
  });
  it('高于上限回退到上限', () => {
    expect(clampSidebarWidth(99_999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 1)).toBe(SIDEBAR_MAX_WIDTH);
  });
  it('区间内（含端点）原样返回', () => {
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH)).toBe(SIDEBAR_MAX_WIDTH);
  });
});

describe('useSidebarDrag — 拖拽回调引用稳定（Bug #23 核心：handleMouseUp 稳定引用）', () => {
  it('多次重渲染下 beginDrag/onDragMove/endDrag 引用不变（bug 下每次新函数）', () => {
    const { result, rerender, unmount } = renderHookWithRerender(
      () => useSidebarDrag(() => 300),
      null,
    );
    const begin1 = result.current!.beginDrag;
    const move1 = result.current!.onDragMove;
    const end1 = result.current!.endDrag;

    rerender(null);
    rerender(null);

    expect(result.current!.beginDrag).toBe(begin1);
    expect(result.current!.onDragMove).toBe(move1);
    expect(result.current!.endDrag).toBe(end1); // Bug #23：回调零依赖 → 引用稳定，effect 只绑一次
    unmount();
  });

  it('初始 width 来自 initializer（懒求值）', () => {
    const { result, unmount } = renderHookWithRerender(() => useSidebarDrag(() => 250), null);
    expect(result.current!.width).toBe(250);
    unmount();
  });
});

describe('applyPreferencesUpdate — preferences 更新逻辑（Bug #24 纯逻辑）', () => {
  const makeCtx = () => ({
    selectedLogId: 'log-9' as string | null,
    setActiveTab: vi.fn(),
    updateUrl: vi.fn(),
    setConversationView: vi.fn(),
  });

  it('activeTab 更新：同时 setActiveTab + updateUrl（带当前 selectedLogId），不动 conversationView', () => {
    const ctx = makeCtx();
    applyPreferencesUpdate({ activeTab: 'response' as TabType }, ctx);
    expect(ctx.setActiveTab).toHaveBeenCalledWith('response');
    expect(ctx.updateUrl).toHaveBeenCalledWith('log-9', 'response');
    expect(ctx.setConversationView).not.toHaveBeenCalled();
  });

  it('conversationView 更新：仅 setConversationView（不动 activeTab / URL）', () => {
    const ctx = makeCtx();
    applyPreferencesUpdate({ conversationView: 'session' }, ctx);
    expect(ctx.setConversationView).toHaveBeenCalledWith('session');
    expect(ctx.setActiveTab).not.toHaveBeenCalled();
    expect(ctx.updateUrl).not.toHaveBeenCalled();
  });

  it('selectedLogId=null 时 updateUrl 传 null', () => {
    const ctx = makeCtx();
    ctx.selectedLogId = null;
    applyPreferencesUpdate({ activeTab: 'response' as TabType }, ctx);
    expect(ctx.updateUrl).toHaveBeenCalledWith(null, 'response');
  });

  it('空更新：三者都不调用', () => {
    const ctx = makeCtx();
    applyPreferencesUpdate({}, ctx);
    expect(ctx.setActiveTab).not.toHaveBeenCalled();
    expect(ctx.setConversationView).not.toHaveBeenCalled();
    expect(ctx.updateUrl).not.toHaveBeenCalled();
  });
});

describe('useSettingsValue — SettingsContext 值引用稳定（Bug #24）', () => {
  function makeArgs(overrides: Partial<Parameters<typeof useSettingsValue>[0]> = {}) {
    return {
      activeTab: 'request' as TabType,
      conversationView: 'timeline' as const,
      selectedLogId: null as string | null,
      updateUrl: vi.fn(),
      setActiveTab: vi.fn(),
      setConversationView: vi.fn(),
      ...overrides,
    };
  }

  it('输入不变时，多次重渲染返回同一引用（bug 下每渲染新对象，强制消费者重渲染）', () => {
    const args = makeArgs();
    const { result, rerender, unmount } = renderHookWithRerender(
      (p: ReturnType<typeof makeArgs>) => useSettingsValue(p),
      args,
    );
    const first = result.current;
    expect(first).toBeDefined();

    // 同一份 args（各字段引用不变）重渲染两次 → useMemo 返回同一引用
    rerender(args);
    rerender(args);
    expect(result.current).toBe(first);
    unmount();
  });

  it('activeTab 变化时引用换新（preferences 内容变了），updatePreferences 仍稳定', () => {
    const args = makeArgs();
    const { result, rerender, unmount } = renderHookWithRerender(
      (p: ReturnType<typeof makeArgs>) => useSettingsValue(p),
      args,
    );
    const before = result.current!;
    const updatePrefsBefore = before.updatePreferences;

    // 只改 activeTab：updateUrl/setActiveTab/setConversationView/selectedLogId 引用均不变（复用同一份 args 的 vi.fn）
    const next = { ...args, activeTab: 'response' as TabType };
    rerender(next);

    expect(result.current).not.toBe(before); // 值换新
    expect(result.current!.preferences.activeTab).toBe('response');
    expect(result.current!.updatePreferences).toBe(updatePrefsBefore); // 其依赖未变 → 仍稳定
    unmount();
  });

  it('updatePreferences 行为：activeTab 更新同步 setActiveTab + updateUrl（带 selectedLogId）', () => {
    const args = makeArgs({ selectedLogId: 'log-1' });
    const { result, unmount } = renderHookWithRerender(
      (p: ReturnType<typeof makeArgs>) => useSettingsValue(p),
      args,
    );
    result.current!.updatePreferences({ activeTab: 'response' as TabType });
    expect(args.setActiveTab).toHaveBeenCalledWith('response');
    expect(args.updateUrl).toHaveBeenCalledWith('log-1', 'response');
    unmount();
  });
});
