import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { useResourceRefresh } from '~/composables/useResourceRefresh';

describe('资源刷新代次', () => {
  it('开始新一代请求时取消旧令牌并拒绝旧响应', () => {
    const scope = effectScope();
    const state = scope.run(() => useResourceRefresh())!;
    const first = state.begin();
    expect(state.isCurrent(first)).toBe(true);

    const second = state.begin();
    expect(first.signal.aborted).toBe(true);
    expect(state.isCurrent(first)).toBe(false);
    expect(state.isCurrent(second)).toBe(true);
    expect(state.generation.value).toBe(2);
    scope.stop();
  });

  it('失效会取消当前请求并推进代次', () => {
    const scope = effectScope();
    const state = scope.run(() => useResourceRefresh())!;
    const token = state.begin();
    state.invalidate();
    expect(token.signal.aborted).toBe(true);
    expect(state.isCurrent(token)).toBe(false);
    expect(state.generation.value).toBe(2);
    scope.stop();
  });
});
