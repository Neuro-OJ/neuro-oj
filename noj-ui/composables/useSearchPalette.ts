/**
 * 搜索面板 composable（issue #100）。
 *
 * 提供 palette 弹窗的开关状态 + 内部状态（query、结果、loading）。
 * 搜索请求经 debounce 150ms 触发，避免输入时频繁请求。
 *
 * 注意：与 noj-core 服务层一致，type=problem 公开访问、type=user 需 admin。
 * palette 在普通用户模式下隐藏 type=user 分组；点击搜索用户跳 `/search?type=user` 走全页路由。
 */

export interface ProblemSearchHit {
  id: string;
  type: string;
  number: number;
  display_id: string;
  title: string;
  difficulty: string;
}

export interface UserSearchHit {
  id: string;
  username: string;
  email: string;
  role: string;
}

interface ProblemSearchPage {
  items: ProblemSearchHit[];
  total: number;
  page: number;
  limit: number;
}

interface UserSearchPage {
  items: UserSearchHit[];
  total: number;
  page: number;
  limit: number;
}

export const useSearchPalette = () => {
  // 全局开关（多组件共享）
  const isOpen = useState<boolean>('search-palette:open', () => false);

  // 内部状态（仅 palette 组件使用）
  const query = ref('');
  const problemResults = ref<ProblemSearchHit[]>([]);
  const userResults = ref<UserSearchHit[]>([]);
  const loading = ref(false);
  const selectedIndex = ref(0);
  // 节流后的 query；input 改变 → debounce 150ms → 执行实际 fetch
  const debouncedQuery = ref('');

  function open() {
    isOpen.value = true;
  }

  function close() {
    isOpen.value = false;
    query.value = '';
    problemResults.value = [];
    userResults.value = [];
    selectedIndex.value = 0;
  }

  function toggle() {
    if (isOpen.value) close();
    else open();
  }

  /**
   * 调用 /api/v1/search?type=problem，附带 admin context 时并发请求 type=user。
   * `type=user` 端点需 admin；非 admin 端点会返 403，在客户端只请求一次后忽略。
   */
  async function fetchResults(q: string) {
    if (!q || q.trim().length === 0) {
      problemResults.value = [];
      userResults.value = [];
      return;
    }

    loading.value = true;
    try {
      const { user } = useAuth();
      const isAdmin = user.value?.role === 'admin';

      const tasks: Promise<void>[] = [
        $fetch<{ data: ProblemSearchPage }>('/api/v1/search', {
          params: { q, type: 'problem', page: 1, limit: 10 },
        })
          .then((res) => {
            problemResults.value = res.data.items;
          })
          .catch(() => {
            problemResults.value = [];
          }),
      ];
      if (isAdmin) {
        tasks.push(
          $fetch<{ data: UserSearchPage }>('/api/v1/search', {
            params: { q, type: 'user', page: 1, limit: 5 },
          })
            .then((res) => {
              userResults.value = res.data.items;
            })
            .catch(() => {
              userResults.value = [];
            }),
        );
      } else {
        userResults.value = [];
      }
      await Promise.all(tasks);
    } finally {
      loading.value = false;
    }
  }

  // Debounce: query 改变后 150ms 才真正请求
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  watch(query, (newQ) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedQuery.value = newQ;
      fetchResults(newQ);
    }, 150);
  });

  return {
    isOpen,
    open,
    close,
    toggle,
    query,
    problemResults,
    userResults,
    loading,
    selectedIndex,
  };
};
