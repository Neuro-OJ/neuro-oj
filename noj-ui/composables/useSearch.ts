/**
 * 全局搜索状态管理（issue #100）。
 *
 * 单一 useState 实例（key="search:state"）在所有组件间共享：
 * - SearchPalette.vue 写入 query/results
 * - pages/search.vue 读取 query/results 用于分页
 * - Navbar.vue 调用 open() 唤起面板
 *
 * 并发与生命周期（Task 10 reviewer fixes）：
 * - 每次 search() 都用 requestSeq 单调递增，过期回调跳过结果写入，避免请求竞态。
 * - 取消旧 debounce 时同步 resolve 旧 Promise，避免 await 挂起。
 * - clearTimeout 移到短查询早退之前，确保「先撤回未触发的请求」再判长度。
 * - onScopeDispose 清理挂起的 debounce + Promise，避免组件卸载后写共享 state。
 * - 同步写入 query/type 到共享 state，让分页等下游消费方能读到最新值。
 * - 「all」模式下两个端点都失败时显式设置 error，不静默吞错。
 */

export type SearchType = "all" | "problem" | "user";

export interface ProblemSearchResult {
  id: string;
  type: string;
  number: number;
  display_id: string;
  title: string;
  difficulty: string;
  rank: number;
  highlight: string;
}

export interface UserSearchResult {
  id: string;
  username: string;
  email: string;
  role: string;
  rank: number;
  highlight: string;
}

export interface SearchState {
  open: boolean;
  query: string;
  type: SearchType;
  results: {
    problems: ProblemSearchResult[];
    users: UserSearchResult[];
  };
  loading: boolean;
  error: string | null;
}

export function useSearch() {
  const state = useState<SearchState>("search:state", () => ({
    open: false,
    query: "",
    type: "all",
    results: { problems: [], users: [] },
    loading: false,
    error: null,
  }));

  const open = () => {
    state.value.open = true;
  };

  const close = () => {
    state.value.open = false;
  };

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResolve: (() => void) | null = null;
  let requestSeq = 0;

  // 组件/作用域卸载时清理挂起的 debounce 与 Promise，
  // 防止回调在卸载后执行并写入共享 state。
  if (import.meta.client) {
    try {
      onScopeDispose(() => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        if (pendingResolve) {
          const r = pendingResolve;
          pendingResolve = null;
          r();
        }
      });
    } catch {
      // 非组件作用域内调用 useSearch 时 onScopeDispose 不可用，静默忽略
    }
  }

  /**
   * 防抖搜索（300ms）。
   * type="all" 时同时拉取题目 + 用户两个端点（前端合并展示）。
   */
  const search = async (q: string, opts?: { type?: SearchType; limit?: number }) => {
    // 1) 先取消上一次未触发的 debounce，并 resolve 旧 Promise。
    //    必须在短查询早退之前做，否则「ab → a」会让旧请求继续等待触发。
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (pendingResolve) {
      const prev = pendingResolve;
      pendingResolve = null;
      prev();
    }

    const trimmed = q.trim();

    // 2) 同步把最新 query/type 写入共享 state，让分页等下游消费方能读到。
    state.value.query = trimmed;
    if (opts?.type) state.value.type = opts.type;

    if (trimmed.length < 2) {
      state.value.results = { problems: [], users: [] };
      state.value.loading = false;
      state.value.error = null;
      return;
    }

    return new Promise<void>((resolve) => {
      pendingResolve = resolve;
      debounceTimer = setTimeout(async () => {
        // 进入执行阶段：清理占位符，分配新的请求序号
        debounceTimer = null;
        pendingResolve = null;
        const mySeq = ++requestSeq;
        state.value.loading = true;
        state.value.error = null;
        const type = opts?.type ?? state.value.type;
        const limit = opts?.limit ?? 5;

        try {
          if (type === "all") {
            // 并行请求题目 + 用户
            const [pRes, uRes] = await Promise.allSettled([
              $fetch("/api/v1/search", {
                params: { q: trimmed, type: "problem", limit },
              }),
              $fetch("/api/v1/search", {
                params: { q: trimmed, type: "user", limit: 3 },
              }),
            ]);

            // 已被更新的请求覆盖，跳过写入（请求竞态防护）
            if (mySeq !== requestSeq) {
              resolve();
              return;
            }

            const problems = pRes.status === "fulfilled"
              ? (pRes.value as { data: { items: ProblemSearchResult[] } }).data.items
              : [];
            const users = uRes.status === "fulfilled"
              ? (uRes.value as { data: { items: UserSearchResult[] } }).data.items
              : [];

            // 两个端点都失败时显式设置 error（Promise.allSettled 不抛错）
            if (pRes.status === "rejected" && uRes.status === "rejected") {
              state.value.error = "搜索失败";
              state.value.results = { problems: [], users: [] };
            } else {
              state.value.results.problems = problems;
              state.value.results.users = users;
            }
          } else {
            const res = await $fetch("/api/v1/search", {
              params: { q: trimmed, type, limit },
            });

            // 已被更新的请求覆盖，跳过写入（请求竞态防护）
            if (mySeq !== requestSeq) {
              resolve();
              return;
            }

            const items = (res as { data: { items: ProblemSearchResult[] | UserSearchResult[] } })
              .data.items;
            state.value.results = {
              problems: type === "problem" ? items as ProblemSearchResult[] : [],
              users: type === "user" ? items as UserSearchResult[] : [],
            };
          }
        } catch (e: unknown) {
          // 仅当本次请求仍是最新时才写入错误（避免覆盖更新的结果）
          if (mySeq === requestSeq) {
            state.value.error = (e as { data?: { error?: string } })?.data?.error
              ?? "搜索失败";
            state.value.results = { problems: [], users: [] };
          }
        } finally {
          if (mySeq === requestSeq) {
            state.value.loading = false;
          }
          resolve();
        }
      }, 300);
    });
  };

  return {
    state: readonly(state),
    open,
    close,
    search,
  };
}