/**
 * 统一管理资源列表 composable。
 *
 * 基于 `useAdminList` 封装，提供分页/搜索/刷新/错误状态，供 AdminTable 使用。
 */
import { type AdminListOptions, useAdminList } from '~/composables/useAdminList';

export interface AdminResourceOptions<T> extends Omit<AdminListOptions<T>, 'polling'> {
  /** 是否启用轮询（可选；默认关闭） */
  polling?: AdminListOptions<T>['polling'];
}

export function useAdminResource<T = Record<string, unknown>>(options: AdminResourceOptions<T>) {
  const list = useAdminList<T>({
    ...options,
    polling: options.polling,
  });

  return {
    items: list.items,
    totalPages: list.totalPages,
    loading: list.loading,
    error: list.error,
    currentPage: list.currentPage,
    perPage: list.perPage,
    keyword: list.keyword,
    lastRefresh: list.lastRefresh,
    searchInput: list.searchInput,
    load: list.load,
    onPageChange: list.onPageChange,
    ...(list.pollingControl ? { pollingControl: list.pollingControl } : {}),
  };
}
