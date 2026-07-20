import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from '../src/utils/api';

describe('low#12 request headers 合并 — 默认 Content-Type 不被调用方覆盖', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** 桩 fetch：成功返回空 JSON，捕获 init 供断言 headers */
  function stubFetch() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '',
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('调用方传 headers 不含 Content-Type 时仍保留默认 application/json', async () => {
    const fetchMock = stubFetch();

    await request('/x', {
      method: 'POST',
      body: '{}',
      headers: { 'X-Custom': '1' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    // bug 下：尾部 ...options 把 headers 整体覆盖为 { X-Custom: '1' }，丢掉默认 Content-Type
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Custom': '1',
    });
  });

  it('调用方显式覆盖 Content-Type 时以其值为准（合并顺序：默认在前）', async () => {
    const fetchMock = stubFetch();
    await request('/x', { method: 'POST', headers: { 'Content-Type': 'text/plain' } });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
  });

  it('无 headers 入参时仅默认 Content-Type', async () => {
    const fetchMock = stubFetch();
    await request('/x');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});
