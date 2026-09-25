/**
 * 法律与合规 composable。
 *
 * 封装：
 * - 公开读：当前政策文档与版本历史（`/api/v1/legal/documents`）。
 * - 管理读写：发布版本、读取/更新 legal_* 与 tsa_* 设置。
 * - 用户侧：提交删除/更正请求、查看自己的请求。
 */

import { ref } from 'vue';

/** 文档类型。 */
export type LegalKind = 'privacy' | 'terms';

/** 当前文档快照。 */
export interface LegalDocumentSnapshot {
  kind: string;
  version: number;
  content: string;
  content_hash: string;
  is_material: boolean;
}

/** 版本历史条目。 */
export interface LegalVersionSummary {
  version: number;
  published_at: string;
  is_material: boolean;
  change_summary: string | null;
}

/** 用户自己的删除/更正请求。 */
export interface DataRequestRow {
  id: string;
  kind: string;
  target_type: string;
  target_id: string | null;
  detail: string;
  status: string;
  resolution: string | null;
  created_at: string;
}

/**
 * 法律与合规前端能力。
 */
export function useLegal() {
  const { api } = useApi();

  const documents = ref<Record<string, LegalDocumentSnapshot | null>>({});

  /** 拉取当前政策文档。 */
  async function loadDocuments(silent = false) {
    const res = await api.get<{ data: Record<string, LegalDocumentSnapshot | null> }>(
      '/api/v1/legal/documents',
      { silent },
    );
    documents.value = res.data;
    return res.data;
  }

  /** 拉取某文档的版本历史。 */
  async function loadVersions(kind: LegalKind): Promise<LegalVersionSummary[]> {
    const res = await api.get<{ data: LegalVersionSummary[] }>(
      `/api/v1/legal/documents/${kind}/versions`,
      { silent: true },
    );
    return res.data;
  }

  /** 发布新版本（管理端）。 */
  async function publishVersion(
    kind: LegalKind,
    content: string,
    changeSummary: string | null,
    isMaterial: boolean,
  ): Promise<number> {
    const res = await api.post<{ data: { version: number } }>(
      `/api/v1/admin/legal/documents/${kind}/versions`,
      { content, change_summary: changeSummary, is_material: isMaterial },
    );
    return res.data.version;
  }

  /** 提交删除/更正请求（用户端）。 */
  async function createDataRequest(input: {
    kind: string;
    target_type: string;
    target_id?: string | null;
    detail: string;
  }): Promise<string> {
    const res = await api.post<{ data: { id: string } }>(
      '/api/v1/legal/data-requests',
      input,
    );
    return res.data.id;
  }

  /** 查看自己的请求。 */
  async function listMyDataRequests(): Promise<DataRequestRow[]> {
    const res = await api.get<{ data: DataRequestRow[] }>(
      '/api/v1/legal/data-requests',
      { silent: true },
    );
    return res.data;
  }

  return {
    documents,
    loadDocuments,
    loadVersions,
    publishVersion,
    createDataRequest,
    listMyDataRequests,
  };
}
