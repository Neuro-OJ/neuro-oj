/**
 * 题目列表页的筛选状态管理 composable。
 *
 * 将 URL 查询参数（keyword、difficulty、category_id、page）作为筛选状态的单一来源，
 * 提供统一的读写接口。筛选条件变化时自动重置页码。
 */
export function useProblemFilters() {
  const router = useRouter()
  const route = useRoute()

  /** 从 URL 查询参数中读取筛选值（只读派生）。 */
  const page = computed(() => Number(route.query.page) || 1)
  const keyword = computed(() => (route.query.keyword as string) || "")
  const difficulty = computed(() => (route.query.difficulty as string) || "")
  const categoryId = computed(() => (route.query.category_id as string) || "")

  const limit = 20

  const hasActiveFilters = computed(() =>
    keyword.value || difficulty.value || categoryId.value,
  )

  /**
   * 更新单个筛选参数。
   * - 若 value 为空则删除该参数
   * - 若非 page 参数变更，自动重置到第 1 页
   */
  function setFilter(key: string, value: string) {
    const query = { ...route.query }
    if (value) {
      query[key] = value
    } else {
      delete query[key]
    }
    if (key !== "page") {
      delete query.page
    }
    router.push({ query })
  }

  /** 构建给 API 的查询参数对象。 */
  const queryParams = computed(() => {
    const params: Record<string, string> = {}
    const p = page.value
    if (p !== 1) params.page = String(p)
    params.limit = String(limit)
    if (keyword.value) params.keyword = keyword.value
    if (difficulty.value) params.difficulty = difficulty.value
    if (categoryId.value) params.category_id = categoryId.value
    return params
  })

  return {
    page,
    limit,
    keyword,
    difficulty,
    categoryId,
    hasActiveFilters,
    setFilter,
    queryParams,
  }
}
