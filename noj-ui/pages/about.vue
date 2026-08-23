<script setup lang="ts">
interface Contributor {
  login: string
  avatar_url: string
  contributions: number
}

interface SiteStats {
  problems: number
  submissions: number
  users: number
  accepted: number
}

const repoUrl = "https://github.com/Neuro-OJ/neuro-oj"
const { api } = useApi()

// 站点统计：Nitro 代理转发到 noj-core /api/v1/stats。
// server: false 避免 SSR 阻塞在外部请求上，首屏后客户端填充（与贡献者一致）。
const { data: statsData } = await useAsyncData<{ data: SiteStats }>(
  "about-stats",
  () => api.get<{ data: SiteStats }>("/api/v1/stats", { silent: true }),
  { server: false },
)
const stats = computed(() => statsData.value?.data)

// 统计项定义：数字 + 标签 + 图标 + 加载骨架
const statItems = computed(() => [
  { key: "problems", label: "题目总数", icon: "i-lucide-book-open", value: stats.value?.problems },
  { key: "submissions", label: "提交总数", icon: "i-lucide-terminal", value: stats.value?.submissions },
  { key: "users", label: "注册用户", icon: "i-lucide-users", value: stats.value?.users },
  { key: "accepted", label: "评测通过", icon: "i-lucide-circle-check", value: stats.value?.accepted },
])

// 贡献者：Nitro 路由从 GitHub API 拉取（带缓存与回退）。
const { data: contributorsData } = await useAsyncData("about-contributors", () =>
  api.get<{ data: Contributor[] }>("/api/contributors", { silent: true }),
  { server: false },
)
const contributors = computed(() => contributorsData.value?.data ?? [])

// 头像加载失败时回退为首字母圆标
const brokenAvatars = ref(new Set<string>())
function onAvatarError(e: Event, c: Contributor) {
  (e.target as HTMLImageElement).style.display = "none"
  brokenAvatars.value.add(c.login)
}
function formatNumber(n?: number): string {
  return (n ?? 0).toLocaleString("zh-CN")
}
</script>

<template>
  <div class="max-w-[860px] mx-auto px-4 py-8 sm:px-6 sm:py-12 flex flex-col gap-8">
    <!-- Hero -->
    <section class="bg-gradient-to-br from-slate-900 via-blue-900 to-blue-700 rounded-2xl overflow-hidden shadow-modal">
      <div class="p-8 sm:p-10 lg:p-12 flex flex-col gap-6 text-white">
        <span class="self-start inline-flex items-center gap-1.5 rounded-full bg-white/10 border border-white/15 px-3 py-1 text-xs font-medium text-blue-100">
          <UIcon name="i-lucide-sparkles" class="size-3.5" />
          面向 LMCC 的 AI 在线评测系统
        </span>
        <div class="flex flex-col gap-3">
          <h1 class="text-3xl sm:text-4xl font-extrabold tracking-tight">Neuro OJ</h1>
          <p class="text-blue-100/90 leading-relaxed max-w-[520px]">
            一个面向 AI 时代程序设计与工程能力评测的在线评测系统，
            以容器级资源隔离承载任意自定义评测逻辑，为 CCF 大语言模型能力认证（LMCC）设计。
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <a
            href="/problems"
            class="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 no-underline hover:bg-blue-50 transition-colors"
          >
            <UIcon name="i-lucide-rocket" class="size-4" />
            开始做题
          </a>
          <a
            :href="repoUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1.5 rounded-lg border border-white/30 px-4 py-2 text-sm font-medium text-white no-underline hover:bg-white/10 transition-colors"
          >
            <UIcon name="i-lucide-github" class="size-4" />
            GitHub
          </a>
        </div>
        <div class="flex items-start gap-2 rounded-lg bg-amber-400/10 border border-amber-300/30 px-4 py-3 text-xs text-amber-100">
          <UIcon name="i-lucide-info" class="size-4 shrink-0 mt-px" />
          <span>Neuro OJ 与 CCF 及 LMCC 无任何官方关系，为独立社区项目。</span>
        </div>
      </div>
    </section>

    <!-- 页内锚点导航 -->
    <nav aria-label="页面导航" class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
      <a href="#features" class="no-underline text-text-secondary hover:text-primary transition-colors">核心区别</a>
      <a href="#architecture" class="no-underline text-text-secondary hover:text-primary transition-colors">技术架构</a>
      <a href="#community" class="no-underline text-text-secondary hover:text-primary transition-colors">开源社区</a>
    </nav>

    <!-- 数据面板 -->
    <section aria-label="站点统计" class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <div
        v-for="item in statItems"
        :key="item.key"
        class="bg-white border border-border rounded-xl shadow-card p-5 flex flex-col items-center gap-2 text-center"
      >
        <UIcon :name="item.icon" class="size-5 text-primary" />
        <template v-if="item.value !== undefined">
          <span class="text-2xl font-extrabold text-text tabular-nums tracking-tight">
            {{ formatNumber(item.value) }}
          </span>
        </template>
        <div v-else class="w-16 h-7 rounded-md bg-gray-100 animate-pulse" role="status" aria-label="统计加载中" />
        <span class="text-xs text-text-muted">{{ item.label }}</span>
      </div>
    </section>

    <!-- 与传统 OJ 的区别 -->
    <section id="features" class="scroll-mt-24">
      <h2 class="text-lg font-bold text-text flex items-center gap-2 mb-4">
        <UIcon name="i-lucide-layout-grid" class="size-4.5 text-primary" />
        与传统 OJ 的核心区别
      </h2>
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <article class="bg-white border border-border rounded-xl shadow-card p-5 flex flex-col gap-3 hover:shadow-dropdown hover:-translate-y-0.5 transition-all">
          <div class="w-10 h-10 rounded-lg bg-primary-bg text-primary flex items-center justify-center shrink-0">
            <UIcon name="i-lucide-grid" class="size-5" />
          </div>
          <h3 class="font-semibold text-text">完全由题目自定义的评测过程</h3>
          <p class="text-sm text-text-secondary leading-relaxed">
            传统 OJ（Hydro、Luogu 等）要求题目遵循固定的评测范式——stdin/stdout 或 filein/fileout。
            Neuro OJ 通过<strong class="text-text">题目支持包（support package）</strong>将评测逻辑完全交给题目自定义。
            每道题自带 <code class="text-primary bg-primary-bg px-1 rounded text-xs font-mono">evaluate.py</code>、
            测试用例和评测脚本，评测方式不受平台约束：可以解析 JSON 输出、调用外部 API、运行多轮对话评估等。
          </p>
        </article>

        <article class="bg-white border border-border rounded-xl shadow-card p-5 flex flex-col gap-3 hover:shadow-dropdown hover:-translate-y-0.5 transition-all">
          <div class="w-10 h-10 rounded-lg bg-primary-bg text-primary flex items-center justify-center shrink-0">
            <UIcon name="i-lucide-box" class="size-5" />
          </div>
          <h3 class="font-semibold text-text">容器级资源限制，适配 AI 场景</h3>
          <p class="text-sm text-text-secondary leading-relaxed">
            传统 OJ 限制单个进程的 CPU 时间和内存，但在 AI 评测场景中，
            代码可能涉及多进程、GPU 调用、模型加载、网络请求等复杂行为。
            Neuro OJ 的<strong class="text-text">时间和内存限制作用于整个 Docker 容器</strong>，
            而非单个进程，真实反映 AI 应用在复杂依赖环境下的资源消耗。
          </p>
        </article>

        <article class="bg-white border border-border rounded-xl shadow-card p-5 flex flex-col gap-3 hover:shadow-dropdown hover:-translate-y-0.5 transition-all">
          <div class="w-10 h-10 rounded-lg bg-primary-bg text-primary flex items-center justify-center shrink-0">
            <UIcon name="i-lucide-monitor" class="size-5" />
          </div>
          <h3 class="font-semibold text-text">全面容器化的评测环境</h3>
          <p class="text-sm text-text-secondary leading-relaxed">
            每道题可指定自定义 Docker 镜像（<code class="text-primary bg-primary-bg px-1 rounded text-xs font-mono">runtime_config</code>），
            意味着评测环境可以预装任意依赖——PyTorch、TensorFlow、NumPy、
            Node.js 包、C++ 库等。平台不再限制语言版本和可用库，
            题目作者自由定义最适合评测的运行时环境。
          </p>
        </article>
      </div>
    </section>

    <!-- 架构概览 -->
    <section id="architecture" class="scroll-mt-24">
      <h2 class="text-lg font-bold text-text flex items-center gap-2 mb-4">
        <UIcon name="i-lucide-server" class="size-4.5 text-primary" />
        技术架构
      </h2>
      <div class="bg-white border border-border rounded-xl shadow-card p-6">
        <div class="flex flex-col sm:flex-row items-stretch gap-2 sm:gap-3">
          <div class="flex-1 bg-slate-50 border border-border rounded-lg px-4 py-3.5">
            <div class="font-semibold text-text flex items-center gap-1.5 mb-1">
              <UIcon name="i-lucide-compass" class="size-4 text-primary" /> noj-ui
            </div>
            <div class="text-text-muted text-xs mb-2">Nuxt 4 + Vue 3 · 用户界面</div>
            <a
              :href="`${repoUrl}/tree/main/noj-ui`"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 text-xs text-primary no-underline hover:underline"
            >
              源码 <UIcon name="i-lucide-external-link" class="size-3" />
            </a>
          </div>
          <UIcon name="i-lucide-arrow-right" class="size-4 text-text-muted self-center shrink-0 sm:rotate-0 rotate-90" />
          <div class="flex-1 bg-slate-50 border border-border rounded-lg px-4 py-3.5">
            <div class="font-semibold text-text flex items-center gap-1.5 mb-1">
              <UIcon name="i-lucide-terminal" class="size-4 text-primary" /> noj-core
            </div>
            <div class="text-text-muted text-xs mb-2">Deno + Hono · RESTful API</div>
            <a
              :href="`${repoUrl}/tree/main/noj-core`"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 text-xs text-primary no-underline hover:underline"
            >
              源码 <UIcon name="i-lucide-external-link" class="size-3" />
            </a>
          </div>
          <UIcon name="i-lucide-arrow-right" class="size-4 text-text-muted self-center shrink-0 sm:rotate-0 rotate-90" />
          <div class="flex-1 bg-slate-50 border border-border rounded-lg px-4 py-3.5">
            <div class="font-semibold text-text flex items-center gap-1.5 mb-1">
              <UIcon name="i-lucide-box" class="size-4 text-primary" /> noj-judge
            </div>
            <div class="text-text-muted text-xs mb-2">Rust + Docker · 评测 Worker</div>
            <a
              :href="`${repoUrl}/tree/main/noj-judge`"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 text-xs text-primary no-underline hover:underline"
            >
              源码 <UIcon name="i-lucide-external-link" class="size-3" />
            </a>
          </div>
        </div>
        <p class="text-xs text-text-muted mt-4 leading-relaxed">
          三模块通过 RESTful API 与 Redis 消息队列协作：noj-ui 提交代码 → noj-core 分发评测任务 →
          noj-judge 在 Docker 沙箱中执行并回传结果，支持多 Worker 水平扩展。
        </p>
      </div>
    </section>

    <!-- GitHub & 贡献者 -->
    <section id="community" class="scroll-mt-24">
      <h2 class="text-lg font-bold text-text flex items-center gap-2 mb-4">
        <UIcon name="i-lucide-github" class="size-4.5 text-primary" />
        开源社区
      </h2>
      <div class="bg-white border border-border rounded-xl shadow-card p-6">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
          <p class="text-sm text-text-secondary">
            本项目在 GitHub 上开源（AGPL-3.0），欢迎 Star、Issue 和 Pull Request。
          </p>
          <a
            :href="repoUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-gray-50 px-4 py-2 text-sm font-medium text-text no-underline hover:bg-primary-bg hover:text-primary hover:border-primary/30 transition-colors shrink-0"
          >
            <UIcon name="i-lucide-star" class="size-4 text-primary" />
            Neuro-OJ/neuro-oj
            <UIcon name="i-lucide-external-link" class="size-3" />
          </a>
        </div>

        <h3 class="text-sm font-semibold text-text mb-3">贡献者</h3>
        <div v-if="contributors.length" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          <a
            v-for="c in contributors"
            :key="c.login"
            :href="`https://github.com/${c.login}`"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-3 px-3 py-2 bg-gray-50 border border-border rounded-lg no-underline hover:bg-primary-bg hover:border-primary/30 transition-colors"
          >
            <img
              v-if="!brokenAvatars.has(c.login)"
              :src="c.avatar_url"
              :alt="`${c.login} 的头像`"
              class="w-8 h-8 rounded-full bg-gray-200 shrink-0"
              loading="lazy"
              referrerpolicy="no-referrer"
              @error="onAvatarError($event, c)"
            />
            <span v-else class="w-8 h-8 rounded-full bg-primary-bg text-primary flex items-center justify-center text-sm font-bold shrink-0">
              {{ c.login.charAt(0).toUpperCase() }}
            </span>
            <span class="flex flex-col min-w-0">
              <span class="font-medium text-text truncate">{{ c.login }}</span>
              <span class="text-xs text-text-muted">{{ c.contributions }} commits</span>
            </span>
          </a>
        </div>
        <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2" role="status" aria-label="贡献者加载中">
          <div v-for="i in 6" :key="i" class="h-[52px] rounded-lg bg-gray-100 animate-pulse" />
        </div>
      </div>
    </section>

    <!-- 常见问题（帮助入口） -->
    <section id="faq" class="scroll-mt-24">
      <h2 class="text-lg font-bold text-text flex items-center gap-2 mb-4">
        <UIcon name="i-lucide-circle-help" class="size-5 text-primary" />
        常见问题
      </h2>
      <div class="flex flex-col gap-2 max-w-[760px]">
        <details class="group rounded-xl border border-border bg-white px-5 py-3.5">
          <summary class="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-text select-none [&::-webkit-details-marker]:hidden">
            如何开始做题？
            <UIcon name="i-lucide-chevron-down" class="size-4 text-text-muted transition-transform group-open:rotate-180" />
          </summary>
          <p class="mt-2 text-sm leading-relaxed text-text-secondary">注册并登录后，进入「题库」选择题目，点击「去解题」进入做题页，选择语言并提交代码即可。</p>
        </details>
        <details class="group rounded-xl border border-border bg-white px-5 py-3.5">
          <summary class="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-text select-none [&::-webkit-details-marker]:hidden">
            提交后状态一直显示 Pending？
            <UIcon name="i-lucide-chevron-down" class="size-4 text-text-muted transition-transform group-open:rotate-180" />
          </summary>
          <p class="mt-2 text-sm leading-relaxed text-text-secondary">评测任务进入队列后由评测 Worker 依次处理，可在「评测队列」页查看实时状态；评测完成后提交详情会自动更新。</p>
        </details>
        <details class="group rounded-xl border border-border bg-white px-5 py-3.5">
          <summary class="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-text select-none [&::-webkit-details-marker]:hidden">
            密码有什么要求？
            <UIcon name="i-lucide-chevron-down" class="size-4 text-text-muted transition-transform group-open:rotate-180" />
          </summary>
          <p class="mt-2 text-sm leading-relaxed text-text-secondary">密码至少 8 位，需同时包含大小写字母和数字，且不能与用户名或邮箱前缀相同。</p>
        </details>
        <details class="group rounded-xl border border-border bg-white px-5 py-3.5">
          <summary class="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-text select-none [&::-webkit-details-marker]:hidden">
            如何参加竞赛？
            <UIcon name="i-lucide-chevron-down" class="size-4 text-text-muted transition-transform group-open:rotate-180" />
          </summary>
          <p class="mt-2 text-sm leading-relaxed text-text-secondary">在「竞赛大厅」查看进行中或未开始的竞赛，点击报名；开赛后即可进入做题页参赛。</p>
        </details>
        <details class="group rounded-xl border border-border bg-white px-5 py-3.5">
          <summary class="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-text select-none [&::-webkit-details-marker]:hidden">
            支持哪些评测语言？
            <UIcon name="i-lucide-chevron-down" class="size-4 text-text-muted transition-transform group-open:rotate-180" />
          </summary>
          <p class="mt-2 text-sm leading-relaxed text-text-secondary">默认提供 Python 3 评测环境，更多语言由管理员配置评测镜像后在「管理后台」启用。</p>
        </details>
      </div>
    </section>

    <!-- Footer -->
    <footer class="text-center text-xs text-text-muted border-t border-border pt-6 flex flex-col gap-2">
      <p>
        基于
        <a
          :href="`${repoUrl}/blob/main/LICENSE`"
          target="_blank"
          rel="noopener noreferrer"
          class="text-primary no-underline hover:underline"
        >AGPL-3.0</a>
        许可证开源。如需商业授权，请联系开发团队。
      </p>
      <p>Neuro OJ 为独立社区项目，与 CCF 及 LMCC 无任何官方关系。</p>
    </footer>
  </div>
</template>
