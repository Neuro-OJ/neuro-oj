<script setup lang="ts">
interface Contributor {
  login: string;
  avatar_url: string;
  contributions: number;
}

interface SiteStats {
  problems: number;
  submissions: number;
  users: number;
  accepted: number;
}

const repoUrl = 'https://github.com/Neuro-OJ/neuro-oj';
const { api } = useApi();

// 站点统计：Nitro 代理转发到 noj-core /api/v1/stats。
// server: false 避免 SSR 阻塞在外部请求上，首屏后客户端填充（与贡献者一致）。
const { data: statsData } = await useAsyncData<{ data: SiteStats }>(
  'about-stats',
  () => api.get<{ data: SiteStats }>('/api/v1/stats', { silent: true }),
  { server: false },
);
const stats = computed(() => statsData.value?.data);

// 统计项：只保留数字与标签，不配装饰图标
const statItems = computed(() => [
  { key: 'problems', label: '题目', value: stats.value?.problems },
  { key: 'submissions', label: '提交', value: stats.value?.submissions },
  { key: 'users', label: '用户', value: stats.value?.users },
  { key: 'accepted', label: '通过', value: stats.value?.accepted },
]);

const features = [
  {
    title: '评测过程由题目定义',
    body:
      '传统 OJ 要求题目遵循 stdin/stdout 或文件读写的固定范式。Neuro OJ 通过题目支持包把评测逻辑交还给题目：每道题自带 evaluate.py、测试用例与评测脚本，可以解析 JSON 输出、调用外部 API、运行多轮对话评估。',
  },
  {
    title: '资源限制作用于整个容器',
    body:
      'AI 评测中的代码常涉及多进程、GPU、模型加载与网络请求。Neuro OJ 的时间与内存限制作用于整个 Docker 容器而非单个进程，如实反映复杂依赖环境下的资源消耗。',
  },
  {
    title: '评测环境可任意定制',
    body:
      '每道题可通过 runtime_config 指定自定义镜像，预装 PyTorch、NumPy、Node.js 包或 C++ 库。语言版本与可用库不再由平台限定。',
  },
];

const modules = [
  { name: 'noj-ui', stack: 'Nuxt 4 · Vue 3', role: '用户界面' },
  { name: 'noj-core', stack: 'Deno · Hono', role: 'API 与任务分发' },
  { name: 'noj-judge', stack: 'Rust · Docker', role: '沙箱评测 Worker' },
];

const faqs = [
  {
    label: '如何开始做题？',
    content: '注册并登录后，进入「题库」选择题目，点击「去解题」进入做题页，选择语言并提交代码即可。',
  },
  {
    label: '提交后一直显示 Pending？',
    content: '评测任务进入队列后由评测 Worker 依次处理，可在「评测队列」页查看实时状态；评测完成后提交详情会自动更新。',
  },
  { label: '密码有什么要求？', content: '至少 8 位，需同时包含大小写字母和数字，且不能与用户名或邮箱前缀相同。' },
  { label: '如何参加竞赛？', content: '在「竞赛大厅」查看进行中或未开始的竞赛并报名，开赛后即可进入做题页参赛。' },
  {
    label: '支持哪些评测语言？',
    content: '默认提供 Python 3 评测环境，更多语言由管理员配置评测镜像后在「管理后台」启用。',
  },
];

// 贡献者：Nitro 路由从 GitHub API 拉取（带缓存与回退）。
const { data: contributorsData } = await useAsyncData(
  'about-contributors',
  () => api.get<{ data: Contributor[] }>('/api/contributors', { silent: true }),
  { server: false },
);
const contributors = computed(() => contributorsData.value?.data ?? []);

// 头像加载失败时回退为首字母圆标
const brokenAvatars = ref(new Set<string>());
function onAvatarError(e: Event, c: Contributor) {
  (e.target as HTMLImageElement).style.display = 'none';
  brokenAvatars.value.add(c.login);
}
function formatNumber(n?: number): string {
  return (n ?? 0).toLocaleString('zh-CN');
}
</script>

<template>
  <div class="mx-auto flex max-w-[880px] flex-col gap-16 px-4 py-12 sm:px-6 sm:py-16">
    <!-- 页首：纯排版，不加渐变、光斑与装饰图标 -->
    <header class="flex flex-col gap-6">
      <p class="font-mono text-xs text-text-muted">关于</p>
      <h1 class="text-4xl font-semibold text-text sm:text-5xl">Neuro OJ</h1>
      <p class="max-w-[60ch] text-lg leading-relaxed text-text-secondary">
        面向 AI 领域认证与竞赛的在线评测平台。以容器级资源隔离承载任意自定义评测逻辑，覆盖 IOAI、NOAI、LMCC 等场景。
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <UButton to="/problems" size="lg">开始做题</UButton>
        <UButton :to="repoUrl" target="_blank" size="lg" color="neutral" variant="outline"
          trailing-icon="i-lucide-arrow-up-right">
          GitHub 仓库
        </UButton>
      </div>
      <p class="text-xs text-text-muted">独立社区项目，与 CCF 及 LMCC 无官方关系。</p>
    </header>

    <!-- 站点统计：一条遥测带，等宽数字 -->
    <section aria-label="站点统计"
      class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
      <div v-for="item in statItems" :key="item.key" class="flex flex-col gap-1 bg-bg-panel px-5 py-4">
        <span class="font-mono text-xs text-text-muted">{{ item.label }}</span>
        <span v-if="item.value !== undefined" class="text-2xl font-semibold tabular-nums text-text">
          {{ formatNumber(item.value) }}
        </span>
        <span v-else class="h-8 w-20 rounded-[4px] bg-bg-sunken" role="status" aria-label="统计加载中" />
      </div>
    </section>

    <!-- 核心区别：编号列表，不用卡片 -->
    <section id="features" class="scroll-mt-24">
      <h2 class="mb-6 text-xl font-semibold text-text">与传统 OJ 的区别</h2>
      <ol class="flex flex-col">
        <li
          v-for="(f, idx) in features"
          :key="f.title"
          class="grid gap-2 border-t border-border py-6 sm:grid-cols-[48px_220px_1fr] sm:gap-6"
        >
          <span class="font-mono text-sm tabular-nums text-text-muted">{{ String(idx + 1).padStart(2, '0') }}</span>
          <h3 class="font-medium text-text">{{ f.title }}</h3>
          <p class="text-sm leading-relaxed text-text-secondary">{{ f.body }}</p>
        </li>
      </ol>
    </section>

    <!-- 技术架构：模块表 -->
    <section id="architecture" class="scroll-mt-24">
      <h2 class="mb-2 text-xl font-semibold text-text">技术架构</h2>
      <p class="mb-6 max-w-[60ch] text-sm leading-relaxed text-text-secondary">
        三个模块通过 RESTful API 与 Redis 消息队列协作：界面提交代码，核心服务分发评测任务，评测 Worker 在 Docker 沙箱中执行并回传结果，可水平扩展。
      </p>
      <div class="overflow-hidden rounded-lg border border-border bg-bg-panel">
        <div
          v-for="m in modules"
          :key="m.name"
          class="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-1 border-b border-border px-5 py-4 last:border-b-0 sm:grid-cols-[140px_180px_1fr_auto]"
        >
          <span class="font-mono text-sm font-medium text-text">{{ m.name }}</span>
          <span class="hidden text-sm text-text-secondary sm:block">{{ m.stack }}</span>
          <span class="col-start-1 text-sm text-text-muted sm:col-start-auto">{{ m.role }}</span>
          <a
            :href="`${repoUrl}/tree/main/${m.name}`"
            target="_blank"
            rel="noopener noreferrer"
            class="col-start-2 row-span-2 row-start-1 text-sm text-primary no-underline hover:underline sm:col-start-auto sm:row-span-1 sm:row-start-auto"
          >源码</a>
        </div>
      </div>
    </section>

    <!-- 开源社区 -->
    <section id="community" class="scroll-mt-24">
      <h2 class="mb-2 text-xl font-semibold text-text">开源社区</h2>
      <p class="mb-6 text-sm leading-relaxed text-text-secondary">
        代码以 AGPL-3.0 协议开源于
        <a :href="repoUrl" target="_blank" rel="noopener noreferrer" class="font-mono text-primary no-underline hover:underline">Neuro-OJ/neuro-oj</a>，欢迎提交 Issue 与 Pull Request。
      </p>
      <ul v-if="contributors.length" class="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <li v-for="c in contributors" :key="c.login">
          <a
            :href="`https://github.com/${c.login}`"
            target="_blank"
            rel="noopener noreferrer"
            class="group flex items-center gap-3 no-underline"
          >
            <img
              v-if="!brokenAvatars.has(c.login)"
              :src="c.avatar_url"
              :alt="`${c.login} 的头像`"
              class="size-7 shrink-0 rounded-full bg-bg-sunken"
              loading="lazy"
              referrerpolicy="no-referrer"
              @error="onAvatarError($event, c)"
            />
            <span v-else
              class="flex size-7 shrink-0 items-center justify-center rounded-full bg-bg-sunken text-xs font-medium text-text-secondary">
              {{ c.login.charAt(0).toUpperCase() }}
            </span>
            <span class="min-w-0 truncate text-sm text-text group-hover:text-primary">{{ c.login }}</span>
            <span class="ml-auto font-mono text-xs tabular-nums text-text-muted">{{ c.contributions }}</span>
          </a>
        </li>
      </ul>
      <div v-else class="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3" role="status" aria-label="贡献者加载中">
        <div v-for="i in 6" :key="i" class="h-7 rounded-[4px] bg-bg-sunken" />
      </div>
    </section>

    <!-- 常见问题 -->
    <section id="faq" class="scroll-mt-24">
      <h2 class="mb-2 text-xl font-semibold text-text">常见问题</h2>
      <UAccordion :items="faqs"
        :ui="{ trigger: 'text-sm font-medium text-text', body: 'text-sm leading-relaxed text-text-secondary' }" />
    </section>

    <footer class="flex flex-col gap-1 border-t border-border pt-6 text-xs text-text-muted">
      <p>
        基于
        <a :href="`${repoUrl}/blob/main/LICENSE`" target="_blank" rel="noopener noreferrer" class="text-primary no-underline hover:underline">AGPL-3.0</a>
        许可证开源。如需商业授权，请联系开发团队。
      </p>
    </footer>
  </div>
</template>
