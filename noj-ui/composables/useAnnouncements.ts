/** 公告阅读契约：域入口合并实例与本域，实例入口只读实例。 */
export interface AnnouncementSummary {
  id: string;
  public_id?: string;
  domain_id: string | null;
  scope?: 'instance' | 'domain';
  title: string;
  excerpt: string;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}
export interface AnnouncementDetail extends AnnouncementSummary {
  content: string;
}
export function useAnnouncements(domainSlug?: string) {
  const { api } = useApi();
  const base = domainSlug ? `/api/v1/domains/${domainSlug}/announcements` : '/api/v1/announcements';
  const href = (id?: string) => `${domainSlug ? `/d/${domainSlug}` : ''}/announcements${id ? `/${id}` : ''}`;
  return {
    href,
    list: (page = 1, perPage = 20) =>
      api.get<{ data: AnnouncementSummary[]; meta: { page: number; total: number; total_pages: number } }>(base, {
        query: { page, per_page: perPage },
        silent: true,
      }),
    detail: async (id: string) => {
      if (domainSlug) return (await api.get<{ data: AnnouncementDetail }>(`${base}/${id}`, { silent: true })).data;
      return api.get<AnnouncementDetail>(`${base}/${id}`, { silent: true });
    },
  };
}
