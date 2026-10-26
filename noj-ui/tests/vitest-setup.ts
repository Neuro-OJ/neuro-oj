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
