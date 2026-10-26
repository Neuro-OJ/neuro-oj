import type { DomainProblemReference } from '~/utils/domain-problems';
import { domainProblemApiPath } from '~/utils/domain-problems';
export interface DomainShareSettings {
  enabled: boolean;
  scope: 'all' | 'selected';
  target_domains: Array<{ id: string; slug: string; name: string }>;
  revision: number;
}
export interface DomainShareInput {
  enabled: boolean;
  scope: 'all' | 'selected';
  target_domain_slugs: string[];
}
export interface DomainProblemBinding {
  reference: DomainProblemReference;
  title: string | null;
  binding_id: string;
  revision: number;
  kind: 'owned' | 'shared';
  visibility: 'public' | 'members';
  disabled_at: string | null;
  resource_available: boolean;
  effective_version_mode: 'any' | 'exact';
  required_version_id: string | null;
  answer_version_id: string | null;
  can_edit: boolean;
  can_share: boolean;
  can_manage_policy: boolean;
  can_change_state: boolean;
}
export interface SharedResourceOption {
  title: string;
  reference?: DomainProblemReference;
  kind?: 'oi' | 'ai' | 'objective';
  id?: string;
  source_domain_id?: string;
  source_domain_slug?: string;
}
/** 共享、使用域策略及可恢复下架分别保存自己的 revision。 */
export function useDomainResources() {
  const { api } = useApi();
  const sharingPath = (slug: string, kind: 'problem' | 'training', ref: string) =>
    kind === 'problem'
      ? `${domainProblemApiPath(slug, ref)}/sharing`
      : `/api/v1/domains/${encodeURIComponent(slug)}/trainings/${encodeURIComponent(ref)}/sharing`;
  return {
    discover: (slug: string, kind: 'problem' | 'training', page: number, source_slug: string, keyword: string) =>
      api.get<{ items: SharedResourceOption[]; page: number; limit: number; total: number }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/shared-resources`,
        { query: { kind, page, limit: 20, source_slug, keyword }, silent: true },
      ),
    bindings: (slug: string, page: number, keyword = '') =>
      api.get<{ items: DomainProblemBinding[]; total: number; page: number; limit: number }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/problem-bindings`,
        { query: { page, limit: 20, keyword }, silent: true },
      ),
    importProblem: (slug: string, source_ref: string) =>
      api.post<{ data: { binding: { id: string; revision: number }; reference: DomainProblemReference } }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/problem-bindings`,
        { source_ref },
      ),
    policy: (
      slug: string,
      reference: string,
      revision: number,
      policy: { mode: 'any' | 'exact'; version_id?: string },
      reason: string,
    ) =>
      api.put<{ data: { revision: number } }>(`${domainProblemApiPath(slug, reference)}/policy`, { policy, reason }, {
        headers: { 'If-Match': String(revision) },
      }),
    state: (
      slug: string,
      reference: string,
      revision: number,
      input: { disabled: boolean; visibility: 'public' | 'members'; reason: string },
    ) =>
      api.post<{ data: { revision: number } }>(`${domainProblemApiPath(slug, reference)}/state`, input, {
        headers: { 'If-Match': String(revision) },
      }),
    sharing: (slug: string, kind: 'problem' | 'training', reference: string) =>
      api.get<{ data: DomainShareSettings }>(sharingPath(slug, kind, reference), { silent: true }),
    share: (slug: string, kind: 'problem' | 'training', reference: string, input: DomainShareInput, revision: number) =>
      api.post<{ data: DomainShareSettings }>(sharingPath(slug, kind, reference), input, {
        headers: { 'If-Match': String(revision) },
      }),
  };
}
