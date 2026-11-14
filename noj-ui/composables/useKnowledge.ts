/**
 * 知识图谱（P1）API 组合函数：题目挂载读取/保存、图谱数据、管理端用量/预估/回填/审核。
 *
 * 约定：
 * - 全部经 `useApi()` 调用，错误由调用方用 `extractApiError` 处理；
 * - `KNOWLEDGE_DISABLED_CODE`（总开关关闭）视为「功能不存在」：调用方捕获后把
 *   `disabled` 置 true 并整块隐藏 UI，不弹错、不渲染报错卡片；
 * - SSE/分页等静默场景使用 `silent: true`。
 */
import type { DeepReadonly, Ref } from 'vue';
import { readonly } from 'vue';
import {
  type BackfillResult,
  isBackfillDrift,
  isKnowledgeDisabled,
  type KnowledgeGraph,
  type KnowledgeLadder,
  type KnowledgeLadderItem,
  type KnowledgeNodeView,
  type KnowledgeSelection,
  type PendingReviewPage,
  type ProblemKnowledgeView,
  type TagEstimate,
  type TagUsage,
} from '~/utils/knowledge';

export function useKnowledge() {
  const { api } = useApi();
  /** 总开关关闭：为 true 时所有知识 UI 整块隐藏。 */
  const disabled = useState<boolean>('knowledge:disabled', () => false);
  const graph = useState<KnowledgeGraph | null>('knowledge:graph', () => null);
  // 同一接口同一目标在飞时复用同一 Promise，避免重复请求。
  const inflight = new Map<string, Promise<unknown>>();

  function markDisabled(err: unknown): boolean {
    if (!isKnowledgeDisabled(err)) return false;
    disabled.value = true;
    return true;
  }

  /** 读图谱（会话内缓存一次，用于选择器分组）。 */
  function loadGraph(force = false): Promise<KnowledgeGraph | null> {
    const cached = graph.value as KnowledgeGraph | null;
    if (cached && !force) return Promise.resolve(cached);
    const key = 'graph';
    const running = inflight.get(key);
    if (running) return running as Promise<KnowledgeGraph | null>;
    const task = (async () => {
      try {
        const res = await api.get<{ data: KnowledgeGraph }>('/api/v1/knowledge/graph', { silent: true });
        graph.value = res.data;
        return res.data;
      } catch (err) {
        if (markDisabled(err)) return null;
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, task);
    return task;
  }

  /** 读题目归类；404（题目不存在/保护期）或功能关闭 → null（不展示）。 */
  function loadProblem(problemId: string): Promise<ProblemKnowledgeView | null> {
    const key = `problem:${problemId}`;
    const running = inflight.get(key);
    if (running) return running as Promise<ProblemKnowledgeView | null>;
    const task = (async () => {
      try {
        const res = await api.get<{ data: ProblemKnowledgeView }>(
          `/api/v1/knowledge/problems/${encodeURIComponent(problemId)}`,
          { silent: true },
        );
        return res.data;
      } catch (err) {
        if (markDisabled(err)) return null;
        const status = (err as { status?: number } | null)?.status;
        if (status === 404) return null;
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, task);
    return task;
  }

  /** 读知识点详情（`doc` 讲解 / 前置 / 后续）；功能关闭 → null，其他错误抛出。 */
  async function loadNode(nodeId: string): Promise<KnowledgeNodeView | null> {
    try {
      const res = await api.get<{ data: KnowledgeNodeView }>(
        `/api/v1/knowledge/nodes/${encodeURIComponent(nodeId)}`,
        { silent: true },
      );
      return res.data;
    } catch (err) {
      if (markDisabled(err)) return null;
      throw err;
    }
  }

  /**
   * 读节点题目阶梯（含 `next`）。节点或域不可访问（404）与功能关闭都返回 null，
   * 由页面展示「暂无题目 / 整块隐藏」。
   */
  function loadLadder(nodeId: string, domain: string): Promise<KnowledgeLadder | null> {
    const key = `ladder:${nodeId}:${domain}`;
    const running = inflight.get(key);
    if (running) return running as Promise<KnowledgeLadder | null>;
    const task = (async () => {
      try {
        const res = await api.get<{ data: KnowledgeLadder }>(
          `/api/v1/knowledge/nodes/${encodeURIComponent(nodeId)}/ladder`,
          { params: { domain }, silent: true },
        );
        return res.data;
      } catch (err) {
        if (markDisabled(err)) return null;
        const status = (err as { status?: number } | null)?.status;
        if (status === 404) return null;
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, task);
    return task;
  }

  /**
   * 题目页「同类下一题」：该题主知识点阶梯中更高难度的下一题。
   *
   * 这是题面页的装饰性入口，任何失败（未归类、无更高难度、功能关闭、网络错误）
   * 都返回 null 让按钮不渲染，不影响做题主流程。
   */
  async function loadNextForProblem(problemId: string): Promise<KnowledgeLadderItem | null> {
    try {
      const res = await api.get<{ data: KnowledgeLadderItem | null }>(
        `/api/v1/knowledge/problems/${encodeURIComponent(problemId)}/next`,
        { silent: true },
      );
      return res.data;
    } catch (err) {
      markDisabled(err);
      return null;
    }
  }

  /**
   * 保存人工挂载（整体替换）。
   *
   * `pass_ratio_override` 只在显式传入时提交（判 null 视为清除覆盖）；
   * 不传则后端不改动难度设置。
   */
  async function saveProblem(
    problemId: string,
    value: KnowledgeSelection,
    options: { passRatioOverride?: number | null } = {},
  ): Promise<ProblemKnowledgeView | null> {
    try {
      const body: Record<string, unknown> = { primary: value.primary, secondary: value.secondary };
      if (options.passRatioOverride !== undefined) body.pass_ratio_override = options.passRatioOverride;
      const res = await api.put<{ data: ProblemKnowledgeView }>(
        `/api/v1/knowledge/problems/${encodeURIComponent(problemId)}`,
        body,
      );
      return res.data;
    } catch (err) {
      markDisabled(err);
      throw err;
    }
  }

  // ─── 管理端 ───────────────────────────────────────────

  async function loadUsage(): Promise<TagUsage | null> {
    try {
      const res = await api.get<{ data: TagUsage }>('/api/v1/admin/knowledge/tagging/usage', { silent: true });
      return res.data;
    } catch (err) {
      if (markDisabled(err)) return null;
      throw err;
    }
  }

  /** 回填预估：每次都真实请求（数量会漂移）。 */
  async function estimateBackfill(): Promise<TagEstimate | null> {
    try {
      const res = await api.get<{ data: TagEstimate }>('/api/v1/admin/knowledge/tagging/estimate', { silent: true });
      return res.data;
    } catch (err) {
      if (markDisabled(err)) return null;
      throw err;
    }
  }

  /**
   * 回填投递。409（预估漂移）不弹默认 toast，返回 `drifted: true`，由界面提示重新预估；
   * 其他错误照常抛出（默认 toast）。
   */
  async function backfill(expectedCount: number): Promise<{ data: BackfillResult | null; drifted: boolean }> {
    try {
      const res = await api.post<{ data: BackfillResult }>(
        '/api/v1/admin/knowledge/tagging/backfill',
        { confirm: true, expected_count: expectedCount },
        {
          onError: (err) => {
            if (isBackfillDrift(err) || isKnowledgeDisabled(err)) return;
          },
        },
      );
      return { data: res.data, drifted: false };
    } catch (err) {
      if (markDisabled(err)) return { data: null, drifted: false };
      if (isBackfillDrift(err)) return { data: null, drifted: true };
      throw err;
    }
  }

  async function loadReviews(page: number, perPage = 20): Promise<PendingReviewPage | null> {
    try {
      const res = await api.get<{ data: PendingReviewPage }>('/api/v1/admin/knowledge/reviews', {
        params: { page, per_page: perPage },
        silent: true,
      });
      return res.data;
    } catch (err) {
      if (markDisabled(err)) return null;
      throw err;
    }
  }

  /** 审核决定：accept/reject 或人工修改（`{ primary, secondary }`）。 */
  async function decideReview(
    problemId: string,
    decision: 'accept' | 'reject' | KnowledgeSelection,
  ): Promise<ProblemKnowledgeView | null> {
    try {
      const body = typeof decision === 'string'
        ? { decision }
        : { primary: decision.primary, secondary: decision.secondary };
      const res = await api.post<{ data: ProblemKnowledgeView }>(
        `/api/v1/admin/knowledge/reviews/${encodeURIComponent(problemId)}`,
        body,
      );
      return res.data;
    } catch (err) {
      markDisabled(err);
      throw err;
    }
  }

  return {
    disabled: readonly(disabled) as unknown as DeepReadonly<Ref<boolean>>,
    graph: graph as Ref<KnowledgeGraph | null>,
    loadGraph,
    loadProblem,
    loadNode,
    loadLadder,
    loadNextForProblem,
    saveProblem,
    loadUsage,
    estimateBackfill,
    backfill,
    loadReviews,
    decideReview,
  };
}
