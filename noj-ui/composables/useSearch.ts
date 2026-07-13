/**
 * 全局搜索状态管理（issue #100）。
 *
 * 单一 useState 实例（key="search:state"）在所有组件间共享：
 * - SearchPalette.vue 写入 query/results
 * - pages/search.vue 读取 query/results 用于分页
 * - Navbar.vue 调用 open() 唤起面板
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

  /**
   * 防抖搜索（300ms）。
   * type="all" 时同时拉取题目 + 用户两个端点（前端合并展示）。
   */
  const search = async (q: string, opts?: { type?: SearchType; limit?: number }) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      state.value.results = { problems: [], users: [] };
      state.value.loading = false;
      state.value.error = null;
      return;
    }

    if (debounceTimer) clearTimeout(debounceTimer);

    return new Promise<void>((resolve) => {
      debounceTimer = setTimeout(async () => {
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

            state.value.results.problems = pRes.status === "fulfilled"
              ? (pRes.value as { data: { items: ProblemSearchResult[] } }).data.items
              : [];
            state.value.results.users = uRes.status === "fulfilled"
              ? (uRes.value as { data: { items: UserSearchResult[] } }).data.items
              : [];
          } else {
            const res = await $fetch("/api/v1/search", {
              params: { q: trimmed, type, limit },
            });
            const items = (res as { data: { items: ProblemSearchResult[] | UserSearchResult[] } })
              .data.items;
            state.value.results = {
              problems: type === "problem" ? items as ProblemSearchResult[] : [],
              users: type === "user" ? items as UserSearchResult[] : [],
            };
          }
        } catch (e: unknown) {
          state.value.error = (e as { data?: { error?: string } })?.data?.error
            ?? "搜索失败";
          state.value.results = { problems: [], users: [] };
        } finally {
          state.value.loading = false;
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