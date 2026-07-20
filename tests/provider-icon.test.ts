/**
 * ProviderIcon 单一图标表一致性单测（Bug #34：原 MONO_LOADERS / AVATAR_LOADERS 两份 26 条表）
 *
 * 修复后 mono / avatar 共址为单一 ICON_LOADERS（新增/移除品牌只改一处）。
 * 本测试固化两条不变量：
 *  ① 预设覆盖：每个 PROVIDER_PRESETS 的 iconKey 都有对应 loader（防止加预设忘加图标）
 *  ② 无孤儿：每个 loader key 都被某个预设引用（防止删预设留死图标）
 *
 * 运行: npx vitest run tests/provider-icon.test.ts
 */
import { describe, it, expect } from 'vitest';
import { ICON_KEYS } from '../src/components/common/ProviderIcon';
import { PROVIDER_PRESETS } from '../src/constants/presets';

describe('ProviderIcon 单一图标表（Bug #34）', () => {
  it('ICON_KEYS 不为空（已迁移为单一表，非两份漂移表）', () => {
    expect(ICON_KEYS.length).toBeGreaterThan(0);
  });

  it('① 预设覆盖：每个 preset.iconKey 都能在 ICON_KEYS 中找到 loader', () => {
    const loaderSet = new Set(ICON_KEYS);
    for (const preset of PROVIDER_PRESETS) {
      expect(loaderSet.has(preset.iconKey), `preset "${preset.name}" 的 iconKey "${preset.iconKey}" 缺少 loader`).toBe(true);
    }
  });

  it('② 无孤儿：每个 loader key 都被某个预设引用', () => {
    const presetIconKeys = new Set(PROVIDER_PRESETS.map(p => p.iconKey));
    for (const key of ICON_KEYS) {
      expect(presetIconKeys.has(key), `loader key "${key}" 没有任何预设引用（孤儿图标）`).toBe(true);
    }
  });

  it('ICON_KEYS 与 preset.iconKey 集合完全一致（双向覆盖）', () => {
    const loaderSet = new Set(ICON_KEYS);
    const presetIconKeys = new Set(PROVIDER_PRESETS.map(p => p.iconKey));
    expect(loaderSet).toEqual(presetIconKeys);
  });
});
