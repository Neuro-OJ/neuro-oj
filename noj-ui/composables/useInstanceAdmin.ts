import type {
  DomainCreationRequest,
  GovernancePage,
  InstanceDomain,
  InstanceSetting,
} from '~/utils/instance-governance';
/** 平台治理明确列出目标域，不将域管理员提升为实例管理员。 */
export function useInstanceAdmin() {
  const { api } = useApi();
  return {
    settings: () => api.get<{ data: InstanceSetting[] }>('/api/v1/admin/system/settings', { silent: true }),
    saveSetting: (setting: InstanceSetting, value: unknown) =>
      api.put<{ data: InstanceSetting }>(`/api/v1/admin/system/settings/${setting.key}`, { value }, {
        silent: true,
        headers: setting.updated_at ? { 'If-Match': `"${setting.updated_at}"` } : undefined,
      }),
    domains: (query: { page: number; status?: InstanceDomain['status']; keyword?: string }) =>
      api.get<GovernancePage<InstanceDomain>>('/api/v1/admin/instance/domains', {
        query: { ...query, per_page: 20 },
        silent: true,
      }),
    requests: (query: { page: number; status?: DomainCreationRequest['status'] }) =>
      api.get<GovernancePage<DomainCreationRequest>>('/api/v1/admin/instance/domain-creation-requests', {
        query: { ...query, per_page: 20 },
        silent: true,
      }),
    review: (id: string, approved: boolean) =>
      api.post<{ data: DomainCreationRequest }>(
        `/api/v1/admin/instance/domain-creation-requests/${encodeURIComponent(id)}/review`,
        { approved },
        { silent: true },
      ),
  };
}
