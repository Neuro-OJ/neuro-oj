// Nuxt 自动导入的测试替身；BFF 专项测试可覆盖默认委托。
import { vi } from 'vitest';
import { computed, ref } from 'vue';
vi.stubGlobal(
  'useRouter',
  () => ({ currentRoute: computed(() => (globalThis as unknown as { useRoute: () => unknown }).useRoute()) }),
);

vi.stubGlobal(
  'useProblemSummaries',
  () => ({ data: ref({ items: [] }), status: ref('success'), error: ref(null), refresh: vi.fn() }),
);

// 知识图谱 API 默认不可用：所有用例不发起真实知识接口请求，
// 需要断言知识 UI 的用例自行覆盖 `useKnowledge`。
vi.stubGlobal('useKnowledge', () => ({
  disabled: ref(false),
  graph: ref(null),
  loadGraph: () => Promise.resolve(null),
  loadProblem: () => Promise.resolve(null),
  saveProblem: () => Promise.resolve(null),
  loadUsage: () => Promise.resolve(null),
  estimateBackfill: () => Promise.resolve(null),
  backfill: () => Promise.resolve({ data: null, drifted: false }),
  loadReviews: () => Promise.resolve(null),
  decideReview: () => Promise.resolve(null),
}));

// 页面通过该 composable 回填面包屑标题；页面测试不渲染布局，无需真实实现。
vi.stubGlobal('useBreadcrumbParams', vi.fn());
