import type { DomainEditorContent } from '~/utils/domain/problem/domain-problem-editor';
import { domainProblemApiPath } from '~/utils/domain/problem/domain-problems';
import type { DomainProblemReference } from '~/utils/domain/problem/domain-problems';

/** 共享草稿视图（`synthesized` 表示尚未落库、由服务端派生）。 */
export interface ProblemDraftView {
  problem_id: string;
  base_version_id: string | null;
  revision: number;
  content: Record<string, unknown>;
  updated_by: string | null;
  updated_at: string | null;
  synthesized: boolean;
}

/** 发布预检报告。 */
export interface PublishPreflightReport {
  problem_id: string;
  revision: number;
  base_version_id: string | null;
  content_complete: boolean;
  content_hash: string | null;
  files: Array<{
    role: string;
    path: string;
    state: string;
    exists: boolean | null;
    byte_size: number | null;
    sha256: string | null;
  }>;
  errors: Array<{ code: string; message: string; path?: string }>;
  warnings: Array<{ code: string; message: string; path?: string }>;
  ready: boolean;
}

/** 发布结果。 */
export interface PublishVersionResult {
  problem_id: string;
  version_id: string;
  version: number;
  draft_revision: number;
  unchanged: boolean;
}

/** 编辑本域源题，不通过共享引用写来源域。 */
export function useDomainProblemEditor() {
  const { api } = useApi();
  return {
    drafts: (slug: string, page: number) =>
      api.get<
        {
          items: Array<
            {
              reference: DomainProblemReference;
              title: string;
              draft_revision: number;
              base_version_id: string | null;
              updated_at: string | null;
            }
          >;
          total: number;
          page: number;
          limit: number;
        }
      >(`/api/v1/domains/${encodeURIComponent(slug)}/problem-drafts`, { query: { page, limit: 20 }, silent: true }),
    create: (slug: string, content: DomainEditorContent, visibility: 'public' | 'private') =>
      api.post<{ problem_id: string; number: number; display_ref: string; draft_revision: number }>(
        domainProblemApiPath(slug),
        {
          title: content.title,
          description: content.description,
          samples: content.samples,
          visibility,
          is_objective: content.kind === 'objective',
          judge_type: content.kind === 'oi' ? 'oi' : 'dual',
          ...(content.kind !== 'objective' ? { runtime_config: content.runtime_config } : {}),
          ...(content.kind === 'ai'
            ? { submission_mode: content.submission_mode, artifact_max_size_mb: content.artifact_max_size_mb }
            : {}),
        },
      ),
    draft: (slug: string, reference: string) =>
      api.get<ProblemDraftView>(`${domainProblemApiPath(slug, reference)}/draft`, { silent: true }),
    save: (slug: string, reference: string, content: DomainEditorContent, revision: number) =>
      api.put<ProblemDraftView>(`${domainProblemApiPath(slug, reference)}/draft`, { content }, {
        headers: { 'If-Match': String(revision) },
      }),
    publish: (slug: string, reference: string, revision: number, change_note: string) =>
      api.post<PublishVersionResult>(`${domainProblemApiPath(slug, reference)}/publish`, { change_note }, {
        headers: { 'If-Match': String(revision) },
      }),
    preflight: (slug: string, reference: string, revision: number) =>
      api.get<PublishPreflightReport>(`${domainProblemApiPath(slug, reference)}/publish-preflight`, {
        query: { expected_revision: revision },
        silent: true,
      }),
    images: () => api.get<{ data: { image: string; kind: string }[] }>('/api/v1/judge-images', { silent: true }),
    importBundle: (slug: string, reference: string, revision: number, body: FormData) =>
      api.post<{ data: { problem_id: string; draft_revision: number } }>(
        `${domainProblemApiPath(slug, reference)}/import-bundle`,
        body,
        { headers: { 'If-Match': String(revision) } },
      ),
    oiFiles: (slug: string, reference: string) =>
      api.get<{ data: { draft_revision: number; files: Array<{ path: string; size: number }> } }>(
        `${domainProblemApiPath(slug, reference)}/oi/files`,
        { silent: true },
      ),
    oiFile: (slug: string, reference: string, path: string) =>
      api.get<{ data: { path: string; size: number; text: string | null; truncated: boolean } }>(
        `${domainProblemApiPath(slug, reference)}/oi/file`,
        { query: { path }, silent: true },
      ),
    oiSave: (slug: string, reference: string, revision: number, body: FormData) =>
      api.post<{ data: { problem_id: string; draft_revision: number; files_changed: boolean } }>(
        `${domainProblemApiPath(slug, reference)}/oi/save`,
        body,
        { headers: { 'If-Match': String(revision) } },
      ),
  };
}
