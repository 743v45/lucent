/**
 * SettingsModal handleAutoSave 按 provider 防抖 — 回归测试（Bug #8: last-write-wins 静默回滚）
 *
 * Bug：handleAutoSave 在 onBlur 时把整份 endpoints 快照整体 PUT（非单字段 patch）。
 * 用户连续编辑多个 endpoint → 多次 blur 触发多次并发 PUT；服务端 updateProvider
 * 用 `endpoints: updates.endpoints` 整体替换，后发的新值可能被先发的旧值覆盖，
 * 导致上游 URL 被静默回滚（UI 缓存看着对、刷新后消失）。
 *
 * 修复：抽出 createProviderAutoSaver，按 provider 防抖（400ms），连续编辑合并为
 * 最后一次 blur 之后的一次 PUT，且在触发时读取最新 formDataRef（last-write-wins 正向）。
 *
 * 本测试在 node 环境用 vitest fake timer 直接驱动工厂（SettingsModal.tsx 导出），
 * mock 掉 ../src/utils/api 的 updateProvider，验证：
 *  ① 400ms 内连续 schedule 同一 provider 只触发一次 updateProvider
 *  ② 触发时用的是最新 endpoints（两次编辑都保留、无字段被旧值覆盖）
 *  ③ 不同 provider 互不影响（按 name 独立防抖）
 *  ④ 每次 schedule 重置该 provider 的计时窗口（不会提前发）
 *  ⑤ 无效 URL 即时拦截（onInvalid 触发、不发 PUT）
 *  ⑥ cancelAll 清空 pending timer（组件卸载后不再发 PUT / 不再 setState）
 *  ⑦ 保存成功回调 onSaved 传入返回的 Provider（用于更新本地 providers 列表）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EndpointType, Provider } from '../src/types';

// hoisted mock：记录 updateProvider 调用，默认返回合成的 Provider
const { updateProviderMock } = vi.hoisted(() => ({
  updateProviderMock: vi.fn(),
}));
vi.mock('../src/utils/api.js', () => ({ updateProvider: updateProviderMock }));

import { updateProvider } from '../src/utils/api.js';
import { createProviderAutoSaver } from '../src/components/settings/SettingsModal.js';

type EndpointMap = Record<EndpointType, string | null>;

function emptyEndpoints(): EndpointMap {
  return { 'openai-chat': null, 'openai-responses': null, 'anthropic-messages': null };
}

/** 模拟组件里的 formDataRef.current（每次编辑整体替换 entry，复刻 updateFormData 的不可变更新） */
function setEndpoint(
  store: { current: Record<string, { endpoints: EndpointMap }> },
  name: string,
  field: EndpointType,
  value: string | null,
) {
  const prev = store.current[name]?.endpoints ?? emptyEndpoints();
  store.current[name] = { endpoints: { ...prev, [field]: value } };
}

function makeStore() {
  return { current: {} as Record<string, { endpoints: EndpointMap }> };
}

function makeSaver(
  store: ReturnType<typeof makeStore>,
  extra: {
    onInvalid?: (name: string, et: EndpointType) => void;
    onSaved?: (name: string, updated: Provider) => void;
  } = {},
) {
  return createProviderAutoSaver({
    delay: 400,
    getData: (name: string) => store.current[name],
    onSaved: extra.onSaved ?? (() => {}),
    onError: () => {},
    onInvalid: extra.onInvalid ?? (() => {}),
  });
}

describe('createProviderAutoSaver — handleAutoSave 按 provider 防抖（Bug #8 回归）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateProviderMock.mockReset();
    updateProviderMock.mockImplementation(
      async (name: string, patch: { endpoints?: EndpointMap }) =>
        ({ name, presetName: null, endpoints: { ...(patch.endpoints ?? emptyEndpoints()) } }) as Provider,
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('① 400ms 内连续多次 schedule 同一 provider 只触发一次 updateProvider（400ms 前不发）', () => {
    const store = makeStore();
    const saver = makeSaver(store);
    store.current['p1'] = { endpoints: emptyEndpoints() };

    saver.schedule('p1');
    saver.schedule('p1');
    saver.schedule('p1');

    // 未到 400ms，PUT 不应发出
    vi.advanceTimersByTime(399);
    expect(updateProvider).not.toHaveBeenCalled();

    // 到 400ms，合并后只发一次
    vi.advanceTimersByTime(1);
    expect(updateProvider).toHaveBeenCalledTimes(1);
    expect(updateProvider).toHaveBeenCalledWith('p1', expect.objectContaining({ endpoints: expect.any(Object) }));
  });

  it('② 触发时用的是最新 endpoints（连续编辑两次的字段都保留，无 last-write-wins 回滚）', () => {
    const store = makeStore();
    const saver = makeSaver(store);

    // 模拟用户先改 chat、blur，再改 responses、blur（典型并发编辑场景）
    setEndpoint(store, 'openai', 'openai-chat', 'https://chat.example.com');
    saver.schedule('openai');
    setEndpoint(store, 'openai', 'openai-responses', 'https://resp.example.com');
    saver.schedule('openai');

    vi.advanceTimersByTime(400);
    expect(updateProvider).toHaveBeenCalledTimes(1);
    // 关键：发出的 endpoints 同时保留两次编辑，没有字段被旧值覆盖
    expect(updateProvider).toHaveBeenCalledWith('openai', {
      endpoints: {
        'openai-chat': 'https://chat.example.com',
        'openai-responses': 'https://resp.example.com',
        'anthropic-messages': null,
      },
    });
  });

  it('③ 不同 provider 互不影响（按 name 独立防抖，各自发一次）', () => {
    const store = makeStore();
    const saver = makeSaver(store);
    store.current['a'] = { endpoints: emptyEndpoints() };
    store.current['b'] = { endpoints: emptyEndpoints() };

    saver.schedule('a');
    saver.schedule('a');
    saver.schedule('b');

    vi.advanceTimersByTime(400);
    expect(updateProvider).toHaveBeenCalledTimes(2);
    const names = updateProviderMock.mock.calls.map((c) => c[0] as string);
    expect(names).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('④ 每次 schedule 重置该 provider 的计时窗口（连续编辑不会提前发）', () => {
    const store = makeStore();
    const saver = makeSaver(store);
    store.current['p1'] = { endpoints: emptyEndpoints() };

    saver.schedule('p1');
    vi.advanceTimersByTime(300); // 快到 400ms 但还没
    saver.schedule('p1');        // 再编辑 → 重置计时
    vi.advanceTimersByTime(300); // 距上次 schedule 仅过 300ms
    expect(updateProvider).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100); // 累计距上次 schedule 满 400ms
    expect(updateProvider).toHaveBeenCalledTimes(1);
  });

  it('⑤ 无效 URL 即时拦截：onInvalid 触发、不调度 PUT（advance 到 400ms 也不发）', () => {
    const store = makeStore();
    const onInvalid = vi.fn();
    const saver = makeSaver(store, { onInvalid });
    setEndpoint(store, 'p1', 'openai-chat', 'not-a-url'); // 非 http/https

    saver.schedule('p1');

    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid).toHaveBeenCalledWith('p1', 'openai-chat');
    vi.advanceTimersByTime(1000);
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it('⑥ cancelAll 清空所有 pending timer（组件卸载后不再发 PUT）', () => {
    const store = makeStore();
    const saver = makeSaver(store);
    store.current['a'] = { endpoints: emptyEndpoints() };
    store.current['b'] = { endpoints: emptyEndpoints() };

    saver.schedule('a');
    saver.schedule('b');
    saver.cancelAll(); // 模拟组件卸载 cleanup

    vi.advanceTimersByTime(10_000);
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it('⑦ 保存成功后回调 onSaved 并传入返回的 Provider（用于更新本地 providers 列表）', async () => {
    const store = makeStore();
    const onSaved = vi.fn();
    const saver = makeSaver(store, { onSaved });
    setEndpoint(store, 'p1', 'openai-chat', 'https://x.example.com');

    saver.schedule('p1');
    await vi.advanceTimersByTimeAsync(400); // 推进计时 + flush 微任务，让 await updateProvider 落地

    expect(updateProvider).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith('p1', expect.objectContaining({ name: 'p1' }));
  });
});
