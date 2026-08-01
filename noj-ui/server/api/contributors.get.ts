// 贡献者列表：从 GitHub API 拉取，1 小时内存缓存；GitHub 不可达时回退到静态快照。
// 过滤机器人账号（dependabot[bot] 等），避免展示为人类贡献者。

interface Contributor {
  login: string;
  avatar_url: string;
  contributions: number;
}

const GITHUB_URL = 'https://api.github.com/repos/Neuro-OJ/neuro-oj/contributors?per_page=100';
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

// 静态回退快照（GitHub 不可达时使用；头像由 https://github.com/<login>.png 动态解析，计数为快照值）
const FALLBACK: Omit<Contributor, 'avatar_url'>[] = [
  { login: 'hachimi-ak-ioi', contributions: 66 },
  { login: 'chenmou2012', contributions: 40 },
  { login: 'box3-galen-nv', contributions: 4 },
  { login: 'w1010tdev', contributions: 1 },
];

let cache: { at: number; data: Contributor[] } | null = null;

export default defineEventHandler(async (): Promise<{ data: Contributor[] }> => {
  const now = Date.now();

  // 命中缓存直接返回
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return { data: cache.data };
  }

  try {
    const res = await fetch(GITHUB_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'neuro-oj' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);

    const raw = (await res.json()) as Array<{ login: string; avatar_url: string; contributions: number }>;
    const data = raw
      .filter((c) => !/dependabot|\[bot\]/i.test(c.login))
      .map((c) => ({ login: c.login, avatar_url: c.avatar_url, contributions: c.contributions }));

    if (data.length === 0) throw new Error('empty contributors');
    cache = { at: now, data };
    return { data };
  } catch {
    // GitHub 不可达 → 静态回退
    const data: Contributor[] = FALLBACK.map((c) => ({
      login: c.login,
      avatar_url: `https://github.com/${c.login}.png?size=40`,
      contributions: c.contributions,
    }));
    cache = { at: now, data };
    return { data };
  }
});
