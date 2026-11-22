import type { DomainProblemReference } from '~/utils/domain-problems';
import { domainProblemApiPath } from '~/utils/domain-problems';

export interface DomainProblemBinding {
  reference: DomainProblemReference;
  title: string | null;
  binding_id: string;
  revision: number;
  visibility: 'public' | 'members';
  disabled_at: string | null;
  resource_available: boolean;
  effective_version_mode: 'any' | 'exact';
  required_version_id: string | null;
  answer_version_id: string | null;
  can_edit: boolean;
  can_manage_policy: boolean;
  can_change_state: boolean;
}

/** 复制来源域身份；只用于展示来源，不授予任何权限。 */
export interface CopySourceDomain {
  id: string;
  slug: string;
  name: string;
}

/** 题目来源项：复制命令只需要来源题号与已发布版本。 */
export interface ProblemCopySource {
  kind: 'problem';
  source: CopySourceDomain;
  problem_id: string;
  number: number;
  display_ref: string;
  reference: string;
  title: string;
  problem_kind: 'objective' | 'oi' | 'dual';
  version_id: string;
}

/** 题单来源项：按 revision 复核，题目随题单一并复制。 */
export interface TrainingCopySource {
  kind: 'training';
  source: CopySourceDomain;
  training_id: string;
  public_id: string;
  title: string;
  revision: number;
}

export type CopySourceItem = ProblemCopySource | TrainingCopySource;

/**
 * 域资源读写。
 *
 * 跨域操作只产生独立副本：来源目录与复制命令替代旧的共享设置接口；
 * 目录本身只返回可复制资源，授权由后端在计数与分页前完成。
 */
export function useDomainResources() {
  const { api } = useApi();
  return {
    copySources: (slug: string, kind: 'problem' | 'training', page: number, sourceSlug: string, keyword: string) =>
      api.get<{ items: CopySourceItem[]; page: number; limit: number; total: number }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/copy-sources`,
        { query: { kind, page, limit: 20, source_slug: sourceSlug, keyword }, silent: true },
      ),
    bindings: (slug: string, page: number, keyword = '') =>
      api.get<{ items: DomainProblemBinding[]; total: number; page: number; limit: number }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/problem-bindings`,
        { query: { page, limit: 20, keyword }, silent: true },
      ),
    importProblem: (slug: string, source_ref: string, version_id?: string) =>
      api.post<{ data: { binding: { id: string; revision: number }; reference: DomainProblemReference } }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/problem-bindings`,
        { source_ref, version_id },
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
      input: { disabled: boolean; visibility?: 'public' | 'members'; reason: string },
    ) =>
      api.post<{ data: { revision: number } }>(`${domainProblemApiPath(slug, reference)}/state`, input, {
        headers: { 'If-Match': String(revision) },
      }),
  };
}
