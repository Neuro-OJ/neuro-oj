import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { useViewAsyncData } from '~/composables/useViewAsyncData';

const actor = ref({ id: 'student' });
const route = { fullPath: '/d/school' };
const snapshot = ref<unknown>();
let cachedFor: (key: string) => unknown;
const app = { isHydrating: false, payload: { data: {} as Record<string, unknown> } };
beforeEach(() => {
  app.isHydrating = false;
  app.payload.data = {};
  snapshot.value = {
    path: '/d/school',
    actorId: 'student',
    envelope: { sections: { activity: { data: { data: 42 } } } },
  };
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useRoute', () => route);
  vi.stubGlobal('useRouter', () => ({ currentRoute: ref(route) }));
  vi.stubGlobal('useState', (key: string) => key === 'bff:view' ? snapshot : key === 'auth:user' ? actor : ref(null));
  vi.stubGlobal('createError', (value: unknown) => value);
  vi.stubGlobal(
    'useAsyncData',
    (
      _key: unknown,
      handler: () => Promise<unknown>,
      options: { getCachedData: (key: string, app: unknown, context: { cause: string }) => unknown },
    ) => {
      cachedFor = (key) => options.getCachedData(key, app, { cause: 'initial' });
      const data = ref(cachedFor('key'));
      const refresh = async () => {
        const cached = options.getCachedData('key', app, { cause: 'refresh:manual' });
        data.value = cached === undefined ? await handler() : cached;
      };
      return {
        data,
        refresh,
        initial: async () => {
          if (data.value === undefined) data.value = await handler();
        },
      };
    },
  );
});

describe('视图数据初始消费与刷新', () => {
  it('初始消费 BFF，第一次手动刷新立即读取新数据', async () => {
    const load = vi.fn(() => Promise.resolve({ data: 43 }));
    const state = useViewAsyncData('activity', 'key', load);
    expect(state.data.value).toEqual({ data: 42 });
    expect(load).not.toHaveBeenCalled();
    await state.refresh();
    expect(load).toHaveBeenCalledOnce();
    expect(state.data.value).toEqual({ data: 43 });
  });
  it('水合优先复用对应 asyncData payload', () => {
    app.isHydrating = true;
    app.payload.data.key = { data: 40 };
    expect(useViewAsyncData('activity', 'key', vi.fn()).data.value).toEqual({ data: 40 });
  });
  it('模块失败不自动重取，用户重试才调用原始接口', async () => {
    snapshot.value = {
      path: '/d/school',
      actorId: 'student',
      envelope: { sections: { activity: { error: { statusCode: 503, data: { error: '服务暂不可用' } } } } },
    };
    const load = vi.fn(() => Promise.resolve({ data: 43 }));
    const state = useViewAsyncData('activity', 'key', load) as unknown as {
      initial(): Promise<void>;
      refresh(): Promise<void>;
    };
    await expect(state.initial()).rejects.toMatchObject({ statusCode: 503 });
    expect(load).not.toHaveBeenCalled();
    await state.refresh();
    expect(load).toHaveBeenCalledOnce();
  });
  it('分页和筛选键变化后不复用初始模块', () => {
    useViewAsyncData('activity', 'key', vi.fn());
    expect(cachedFor('page-2')).toBeUndefined();
  });
  it('账号不一致时不使用另一账号快照', () => {
    snapshot.value = {
      path: '/d/school',
      actorId: 'coach',
      envelope: { sections: { activity: { data: 'other-user' } } },
    };
    expect(useViewAsyncData('activity', 'key', vi.fn()).data.value).toBeUndefined();
  });
});
