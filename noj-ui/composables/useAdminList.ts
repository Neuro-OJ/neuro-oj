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

import { ref } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { extractApiError } from '~/utils/apiError';
import { usePolling } from '~/composables/usePolling';

export interface AdminListOptions<T> {
  /** API 路径（如 "/api/v1/admin/users"） */
  path: string;
  /** 默认每页条数 */
  perPage?: number;
  /** 响应字段映射（默认从 `res.data` 读列表，`res.total` 读总数） */
  fetchOptions?: {
    dataField?: string;
    totalField?: string;
  };
  /** 自定义转换函数 — 完全接管响应解析 */
  transform?: (raw: unknown) => { items: T[]; total: number };
  /** 自动轮询配置（静默刷新：不置 loading、失败不弹错） */
  polling?: {
    /** 轮询间隔（ms）；null = 关闭。支持响应式源，切换即时生效 */
    intervalMs: MaybeRefOrGetter<number | null>;
    /** 返回 true 时自动停止轮询（如提交列表全部终态） */
    stopWhen?: () => boolean;
  };
}

export interface AdminListResult<T> {
  items: Ref<T[]>;
  totalPages: Ref<number>;
  loading: Ref<boolean>;
  error: Ref<string>;
  currentPage: Ref<number>;
  perPage: number;
  keyword: Ref<string>;
  /** 搜索输入（300ms 防抖，自动重置到第 1 页） */
  searchInput: (val: string) => void;
  /** 加载指定页 */
  load: (page?: number) => Promise<void>;
  /** 分页切换 */
  onPageChange: (page: number) => void;
  /** 轮询控制（仅配置了 polling 时返回）：start/stop/isPolling，供页面在 stopWhen 停轮询后手动恢复 */
  pollingControl?: { start: () => void; stop: () => void; isPolling: Ref<boolean> };
  /** 最近一次成功加载时间 */
  lastRefresh: Ref<Date | null>;
}

/** 深层读取嵌套字段（支持 "pagination.total_pages" 路径） */
function deepGet(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

export function useAdminList<T = Record<string, unknown>>(
  options: AdminListOptions<T>,
): AdminListResult<T> {
  const items = ref<T[]>([]) as Ref<T[]>;
  const loading = ref(true);
  const error = ref('');
  const currentPage = ref(1);
  const totalPages = ref(1);
  const lastRefresh = ref<Date | null>(null);
  const perPageVal = options.perPage ?? 20;
  const keyword = ref('');

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let requestVersion = 0;

  /** silent=true 用于轮询：不置 loading、不清 error，失败静默保留旧数据 */
  async function load(page = 1, silent = false) {
    const currentRequest = ++requestVersion;
    if (!silent) {
      loading.value = true;
      error.value = '';
    }
    currentPage.value = page;

    try {
      const params = new URLSearchParams({
        page: String(page),
        per_page: String(perPageVal),
      });
      if (keyword.value) params.set('keyword', keyword.value);

      // 列表加载为后台场景：错误写入 error state 由页面展示，不弹 toast
      const { api } = useApi();
      if (options.transform) {
        const raw = await api.get(`${options.path}?${params}`, { silent: true });
        const r = options.transform(raw);
        if (currentRequest !== requestVersion) return;
        items.value = r.items;
        totalPages.value = Math.max(1, Math.ceil(r.total / perPageVal));
        lastRefresh.value = new Date();
      } else {
        const dataField = options.fetchOptions?.dataField ?? 'data';
        const totalField = options.fetchOptions?.totalField ?? 'total';
        const res = await api.get<Record<string, unknown>>(
          `${options.path}?${params}`,
          { silent: true },
        );
        if (currentRequest !== requestVersion) return;
        const rawData = deepGet(res, dataField);
        items.value = (Array.isArray(rawData) ? rawData : []) as T[];
        lastRefresh.value = new Date();

        const rawTotal = deepGet(res, totalField);
        if (typeof rawTotal === 'number') {
          totalPages.value = Math.max(1, Math.ceil(rawTotal / perPageVal));
        } else {
          // fallback: pagination.total_pages
          const rawPages = deepGet(res, 'pagination.total_pages');
          totalPages.value = typeof rawPages === 'number' ? Math.max(1, rawPages) : 1;
        }
      }
    } catch (err: unknown) {
      if (currentRequest !== requestVersion) return;
      if (!silent) {
        // 展示后端具体错误原因（extractApiError 统一提取）
        error.value = extractApiError(err).message;
      }
    } finally {
      // 无条件复位 loading：silent 轮询若成为最后一个请求也要复位，
      // 否则手动请求在途时被轮询抢占 requestVersion 会导致 loading 永久卡死
      if (currentRequest === requestVersion) loading.value = false;
    }
  }

  function searchInput(val: string) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      keyword.value = val;
      load(1);
    }, 300);
  }

  function onPageChange(page: number) {
    load(page);
  }

  // 自动轮询（静默刷新，requestVersion 防竞态保证不覆盖用户搜索/分页结果）
  let pollingControl: AdminListResult<T>['pollingControl'];
  if (options.polling) {
    const polling = usePolling({
      intervalMs: options.polling.intervalMs,
      fetcher: () => load(currentPage.value, true),
      stopWhen: options.polling.stopWhen,
    });
    pollingControl = polling;
  }

  return {
    items,
    totalPages,
    loading,
    error,
    currentPage,
    perPage: perPageVal,
    keyword,
    lastRefresh,
    searchInput,
    load,
    onPageChange,
    ...(pollingControl ? { pollingControl } : {}),
  };
}
