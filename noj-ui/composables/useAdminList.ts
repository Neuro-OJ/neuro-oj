/**
 * Admin 通用列表管理组合函数。
 *
 * 封装分页、加载/错误状态、搜索逻辑，
 * 消除 admin 管理页面中大量重复的数据获取样板代码。
 *
 * 用法：
 * ```ts
 * const { items, loading, error, load, onPageChange, searchInput } = useAdminList<User>({
 *   path: "/api/v1/admin/users",
 *   fetchOptions: { dataField: "data", totalField: "total" },
 * })
 * ```
 */

import { ref } from "vue"

export interface AdminListOptions<T> {
  /** API 路径（如 "/api/v1/admin/users"） */
  path: string
  /** 默认每页条数 */
  perPage?: number
  /** 响应字段映射（默认从 `res.data` 读列表，`res.total` 读总数） */
  fetchOptions?: {
    dataField?: string
    totalField?: string
  }
  /** 自定义转换函数 — 完全接管响应解析 */
  transform?: (raw: unknown) => { items: T[]; total: number }
}

export interface AdminListResult<T> {
  items: Ref<T[]>
  totalPages: Ref<number>
  loading: Ref<boolean>
  error: Ref<string>
  currentPage: Ref<number>
  perPage: number
  keyword: Ref<string>
  /** 搜索输入（300ms 防抖，自动重置到第 1 页） */
  searchInput: (val: string) => void
  /** 加载指定页 */
  load: (page?: number) => Promise<void>
  /** 分页切换 */
  onPageChange: (page: number) => void
}

/** 深层读取嵌套字段（支持 "pagination.total_pages" 路径） */
function deepGet(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

export function useAdminList<T = Record<string, unknown>>(
  options: AdminListOptions<T>,
): AdminListResult<T> {
  const items = ref<T[]>([]) as Ref<T[]>
  const loading = ref(true)
  const error = ref("")
  const currentPage = ref(1)
  const totalPages = ref(1)
  const perPageVal = options.perPage ?? 20
  const keyword = ref("")

  let searchTimer: ReturnType<typeof setTimeout> | undefined

  async function load(page = 1) {
    loading.value = true
    error.value = ""
    currentPage.value = page

    try {
      const params = new URLSearchParams({
        page: String(page),
        per_page: String(perPageVal),
      })
      if (keyword.value) params.set("keyword", keyword.value)

      if (options.transform) {
        const raw = await $fetch(`${options.path}?${params}`)
        const r = options.transform(raw)
        items.value = r.items
        totalPages.value = Math.max(1, Math.ceil(r.total / perPageVal))
      } else {
        const dataField = options.fetchOptions?.dataField ?? "data"
        const totalField = options.fetchOptions?.totalField ?? "total"
        const res = await $fetch<Record<string, unknown>>(`${options.path}?${params}`)
        const rawData = deepGet(res, dataField)
        items.value = (Array.isArray(rawData) ? rawData : []) as T[]

        const rawTotal = deepGet(res, totalField)
        if (typeof rawTotal === "number") {
          totalPages.value = Math.max(1, Math.ceil(rawTotal / perPageVal))
        } else {
          // fallback: pagination.total_pages
          const rawPages = deepGet(res, "pagination.total_pages")
          totalPages.value = typeof rawPages === "number" ? Math.max(1, rawPages) : 1
        }
      }
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : "加载失败"
    } finally {
      loading.value = false
    }
  }

  function searchInput(val: string) {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      keyword.value = val
      load(1)
    }, 300)
  }

  function onPageChange(page: number) {
    load(page)
  }

  return {
    items,
    totalPages,
    loading,
    error,
    currentPage,
    perPage: perPageVal,
    keyword,
    searchInput,
    load,
    onPageChange,
  }
}
