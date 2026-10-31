import type { PostRow } from '~/composables/useCommunity';
import { communityApiPath } from '~/utils/community-workspace';
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';

/**
 * 赛后「官方题解」数据源。
 *
 * ## 为什么单独抽一层
 *
 * 比赛详情页要在**赛题列表**里逐题标出题解入口，赛题页要在**题面下方**给出直达链接。
 * 如果每个题目各发一次请求，一场 20 题的比赛结束后打开详情页就是 20 个请求。这里改为
 * **一次**拉取本域题解列表再按题分组。
 *
 * ## 授权边界（不做前端过滤）
 *
 * 数据来自域社区既有读取路径，跨域引用、其他比赛保密、社区关闭与隐藏帖子都由后端
 * 既有规则决定：后端拿不到就没有，前端不猜。
 *
 * ## 只认 `is_official`
 *
 * 普通题解与官方题解在同一列表里；把普通题解标成"官方题解"会误导选手，因此这里
 * 严格按 `is_official === true` 过滤。
 *
 * ## 为什么是 async
 *
 * `useAsyncData` 在 Nuxt 里返回 PromiseLike，页面必须 `await` 才能拿到 ref（否则
 * `data.value` 永远是 undefined）。`<script setup>` 支持顶层 await，因此本函数同样
 * 声明为 async，由调用方 await。
 *
 * @param slug 当前使用域
 * @param enabled 社区功能是否开启；关闭时不发请求
 */
export async function useOfficialSolutions(
  slug: Ref<string | null | undefined>,
  enabled: Ref<boolean>,
) {
  const { user } = useAuth();
  const { api } = useApi();

  const { data, status } = await useAsyncData(
    () => `${workspaceCacheKey(slug.value ?? '', user.value?.id ?? null, 'official-solutions')}`,
    () =>
      enabled.value && slug.value
        ? api.get<{ data: PostRow[] }>(communityApiPath(slug.value, 'posts'), {
          // 官方题解在列表里**置顶排序**（`is_official DESC` 是排序首键），
          // 因此首页即可覆盖绝大多数情况；limit 取大值进一步降低漏取概率。
          query: { type: 'solution', limit: 100 },
          silent: true,
        })
        : Promise.resolve(null),
  );

  /** 题目 ID → 官方题解（按发布时间升序，早版本在前）。 */
  const byProblem = computed(() => {
    const map = new Map<string, PostRow[]>();
    for (const row of data.value?.data ?? []) {
      if (row.post.is_official !== true || !row.post.problem_id) continue;
      const list = map.get(row.post.problem_id) ?? [];
      list.push(row);
      map.set(row.post.problem_id, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.post.created_at.localeCompare(b.post.created_at));
    }
    return map;
  });

  /** 指定题目的官方题解；无则空数组。 */
  const forProblem = (problemId: string | null | undefined): PostRow[] =>
    problemId ? byProblem.value.get(problemId) ?? [] : [];

  /** 官方题解的站内路径。 */
  const hrefOf = (row: PostRow) =>
    workspacePath(slug.value ?? '', `community/posts/${row.post.public_id || row.post.id}`);

  return {
    /** 是否仍在读取（用于占位文案，避免用"暂无"误导） */
    loading: computed(() => status.value === 'pending' && !data.value),
    forProblem,
    hrefOf,
  };
}
