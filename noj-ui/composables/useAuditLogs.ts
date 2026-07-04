/**
 * 审计日志列表 composable。
 * 状态：分页 + 筛选；自动请求 + 错误处理。
 */

export type AuditAction =
  | "users.role_change"
  | "users.ban"
  | "users.unban"
  | "problems.delete"
  | "categories.delete"
  | "submissions.rejudge"
  | "settings.update";

export interface AuditLogEntry {
  id: string;
  admin_id: string;
  action: AuditAction;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown>;
  ip_address: string;
  created_at: string;
}

export interface AuditLogListResponse {
  data: AuditLogEntry[];
  pagination: { page: number; per_page: number; total: number };
}

export interface AuditLogFilters {
  page: number;
  per_page: number;
  admin_id?: string;
  action?: AuditAction | "";
  from?: string;
  to?: string;
}

export function useAuditLogs(initial: Partial<AuditLogFilters> = {}) {
  const filters = useState("audit-logs-filters", () => ({
    page: 1,
    per_page: 20,
    admin_id: undefined,
    action: "" as AuditAction | "",
    from: undefined,
    to: undefined,
    ...initial,
  }));

  const data = ref<AuditLogEntry[]>([]);
  const pagination = ref({ page: 1, per_page: 20, total: 0 });
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetch() {
    loading.value = true;
    error.value = null;
    try {
      const params = new URLSearchParams();
      params.set("page", String(filters.value.page));
      params.set("per_page", String(filters.value.per_page));
      if (filters.value.admin_id) params.set("admin_id", filters.value.admin_id);
      if (filters.value.action) params.set("action", filters.value.action);
      if (filters.value.from) params.set("from", filters.value.from);
      if (filters.value.to) params.set("to", filters.value.to);

      const res = await $fetch<AuditLogListResponse>(
        `/api/v1/admin/audit-logs?${params}`,
      );
      data.value = res.data;
      pagination.value = res.pagination;
    } catch (e: any) {
      error.value = e?.message ?? "加载失败";
    } finally {
      loading.value = false;
    }
  }

  function reset() {
    filters.value = { page: 1, per_page: 20, admin_id: undefined, action: "", from: undefined, to: undefined };
  }

  return { filters, data, pagination, loading, error, fetch, reset };
}
