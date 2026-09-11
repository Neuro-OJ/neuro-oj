export type { SearchEntityType, SearchItem, SearchState, SearchType } from '../utils/search-types.ts';

export function useSearch() {
  const { api } = useApi();
  const state = useState<SearchState>('search:state', () => ({
    open: false,
    query: '',
    type: 'all',
    groups: {},
    flatItems: [],
    hasMore: false,
    page: 1,
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
      // 非组件作用域内调用时忽略
    }
  }

  const search = (
    q: string,
    opts?: {
      mode?: 'palette' | 'page';
      type?: SearchType;
      page?: number;
      perPage?: number;
    },
  ) => {
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
    state.value.query = trimmed;
    if (opts?.type) state.value.type = opts.type;

    if (trimmed.length < 2) {
      requestSeq++;
      state.value.groups = {};
      state.value.flatItems = [];
      state.value.hasMore = false;
      state.value.loading = false;
      state.value.error = null;
      return;
    }

    return new Promise<void>((resolve) => {
      pendingResolve = resolve;
      debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        pendingResolve = null;
        const mySeq = ++requestSeq;
        state.value.loading = true;
        state.value.error = null;
        const mode = opts?.mode ?? 'palette';
        const type = opts?.type ?? state.value.type;
        const page = opts?.page ?? 1;
        const perPage = opts?.perPage ?? 20;

        try {
          if (mode === 'palette') {
            const res = await api.get('/api/v1/search', {
              params: {
                q: trimmed,
                types: 'problem,user,community_post,community_comment,contest,submission,message,announcement',
                per_type: 5,
              },
              silent: true,
            });
            if (mySeq !== requestSeq) {
              resolve();
              return;
            }
            state.value.groups = (res as { data: { groups: SearchState['groups'] } }).data.groups;
            state.value.flatItems = [];
            state.value.hasMore = false;
          } else if (type === 'all') {
            const res = await api.get('/api/v1/search', {
              params: { q: trimmed, page, per_page: perPage },
              silent: true,
            });
            if (mySeq !== requestSeq) {
              resolve();
              return;
            }
            const data = (res as { data: { items: SearchItem[]; has_more: boolean } })
              .data;
            state.value.flatItems = data.items;
            state.value.hasMore = data.has_more;
            state.value.page = page;
            state.value.groups = {};
          } else {
            const res = await api.get('/api/v1/search', {
              params: { q: trimmed, type, page, per_page: perPage },
              silent: true,
            });
            if (mySeq !== requestSeq) {
              resolve();
              return;
            }
            const data = (res as { data: { items: SearchItem[]; has_more: boolean } })
              .data;
            state.value.flatItems = data.items;
            state.value.hasMore = data.has_more;
            state.value.page = page;
            state.value.groups = {};
          }
        } catch (e: unknown) {
          if (mySeq === requestSeq) {
            state.value.error = (e as { data?: { error?: string } })?.data?.error ?? '搜索失败';
            state.value.groups = {};
            state.value.flatItems = [];
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
