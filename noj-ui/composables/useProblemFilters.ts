/**
 * 题目列表页的筛选状态管理 composable。
 *
 * 将 URL 查询参数（keyword、difficulty、tag、page）作为筛选状态的单一来源，
 * 提供统一的读写接口。筛选条件变化时自动重置页码。
 */
export function useProblemFilters() {
  const router = useRouter();
  const route = useRoute();

  /** 从 URL 查询参数中读取筛选值（只读派生）。 */
  const page = computed(() => Number(route.query.page) || 1);
  const keyword = computed(() => (route.query.keyword as string) || '');
  const difficulty = computed(() => (route.query.difficulty as string) || '');
  const tagId = computed(() => (route.query.tag as string) || '');
  /** 题目类型筛选。空字符串 = 未选择（API 默认返回 P 型）。 */
  const problemType = computed(() => (route.query.type as string) || '');
  const problemNumber = computed(() => (route.query.number as string) || '');

  const limit = 20;

  const hasActiveFilters = computed(() => !!keyword.value || !!difficulty.value || !!tagId.value);

  /**
   * 更新单个筛选参数。
   * - 若 value 为空则删除该参数
   * - 若非 page 参数变更，自动重置到第 1 页
   */
  function setFilter(key: string, value: string | null | undefined) {
    const query = { ...route.query };
    if (value) {
      query[key] = value;
    } else {
      delete query[key];
    }
    if (key !== 'page') {
      delete query.page;
    }
    router.push({ query });
  }

  /** 构建给 API 的查询参数对象。 */
  const queryParams = computed(() => {
    const params: Record<string, string> = {};
    const p = page.value;
    if (p !== 1) params.page = String(p);
    params.limit = String(limit);
    if (keyword.value) params.keyword = keyword.value;
    if (difficulty.value) params.difficulty = difficulty.value;
    if (tagId.value) params.tag = tagId.value;
    if (problemType.value) params.type = problemType.value;
    if (problemNumber.value) params.number = problemNumber.value;
    return params;
  });

  return {
    page,
    limit,
    keyword,
    difficulty,
    tagId,
    problemType,
    problemNumber,
    hasActiveFilters,
    setFilter,
    queryParams,
  };
}
