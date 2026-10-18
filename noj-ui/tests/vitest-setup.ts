// Nuxt 自动导入的测试替身；BFF 专项测试可覆盖默认委托。
import { vi } from 'vitest';
import { computed, ref } from 'vue';
vi.stubGlobal('useViewAsyncData', (_section: unknown, ...args: unknown[]) => {
  return (globalThis as unknown as { useAsyncData: (...args: unknown[]) => unknown }).useAsyncData(...args);
});
vi.stubGlobal('useViewSection', () => ref(undefined));

vi.stubGlobal(
  'useRouter',
  () => ({ currentRoute: computed(() => (globalThis as unknown as { useRoute: () => unknown }).useRoute()) }),
);

vi.stubGlobal(
  'useProblemSummaries',
  () => ({ data: ref({ items: [] }), status: ref('success'), error: ref(null), refresh: vi.fn() }),
);

// 页面通过该 composable 回填面包屑标题；页面测试不渲染布局，无需真实实现。
vi.stubGlobal('useBreadcrumbParams', vi.fn());
