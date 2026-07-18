<script setup lang="ts">
import { ExternalLink, Grid, Box, Monitor, Server, Compass, Terminal } from "@lucide/vue"

const contributors = [
  { login: "hachimi-ak-ioi", contributions: 9 },
  { login: "chenmou2012", contributions: 2 },
  { login: "w1010tdev", contributions: 1 },
]

const repoUrl = "https://github.com/Neuro-OJ/neuro-oj"
</script>

<template>
  <div class="max-w-[860px] mx-auto px-4 py-8 sm:px-6 sm:py-12 flex flex-col gap-10">
    <!-- Hero -->
    <div class="flex flex-col gap-3">
      <h1 class="text-3xl font-extrabold text-text tracking-tight">Neuro OJ</h1>
      <p class="text-lg text-text-secondary leading-relaxed">
        一个面向 AI 时代程序设计与工程能力评测的在线评测系统，
        为 LMCC（CCF 大语言模型能力认证）设计。
      </p>
      <p class="text-sm text-text-muted">
        Neuro OJ 与 CCF 及 LMCC 无任何官方关系，为独立社区项目。
      </p>
    </div>

    <!-- 与传统 OJ 的区别 -->
    <div class="bg-white border border-border rounded-xl overflow-hidden">
      <div class="px-6 py-5 border-b border-border bg-gray-50">
        <h2 class="text-lg font-bold text-text">与传统 OJ 的核心区别</h2>
      </div>
      <div class="px-6 py-6 flex flex-col gap-6">
        <div class="flex gap-4">
          <div class="w-10 h-10 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center shrink-0">
            <Grid :size="20" />
          </div>
          <div class="flex flex-col gap-1.5">
            <h3 class="font-semibold text-text">完全由题目自定义的评测过程</h3>
            <p class="text-sm text-text-secondary leading-relaxed">
              传统 OJ（Hydro、Luogu 等）要求题目遵循固定的评测范式——stdin/stdout 或 filein/fileout。
              Neuro OJ 通过<strong class="text-text">题目支持包（support package）</strong>将评测逻辑完全交给题目自定义。
              每道题自带 <code class="text-purple-700 bg-purple-50 px-1 rounded text-xs font-mono">evaluate.py</code>、
              测试用例和评测脚本，评测方式不受平台约束：可以解析 JSON 输出、调用外部 API、运行多轮对话评估等。
            </p>
          </div>
        </div>

        <div class="flex gap-4">
          <div class="w-10 h-10 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
            <Box :size="20" />
          </div>
          <div class="flex flex-col gap-1.5">
            <h3 class="font-semibold text-text">容器级资源限制，适配 AI 场景</h3>
            <p class="text-sm text-text-secondary leading-relaxed">
              传统 OJ 限制单个进程的 CPU 时间和内存，但在 AI 评测场景中，
              代码可能涉及多进程、GPU 调用、模型加载、网络请求等复杂行为。
              Neuro OJ 的<strong class="text-text">时间和内存限制作用于整个 Docker 容器</strong>，
              而非单个进程，真实反映 AI 应用在复杂依赖环境下的资源消耗。
            </p>
          </div>
        </div>

        <div class="flex gap-4">
          <div class="w-10 h-10 rounded-lg bg-green-100 text-green-700 flex items-center justify-center shrink-0">
            <Monitor :size="20" />
          </div>
          <div class="flex flex-col gap-1.5">
            <h3 class="font-semibold text-text">全面容器化的评测环境</h3>
            <p class="text-sm text-text-secondary leading-relaxed">
              每道题可指定自定义 Docker 镜像（<code class="text-green-700 bg-green-50 px-1 rounded text-xs font-mono">runtime_config</code>），
              意味着评测环境可以预装任意依赖——PyTorch、TensorFlow、NumPy、
              Node.js 包、C++ 库等。平台不再限制语言版本和可用库，
              题目作者自由定义最适合评测的运行时环境。
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- 架构概览 -->
    <div class="bg-white border border-border rounded-xl overflow-hidden">
      <div class="px-6 py-5 border-b border-border bg-gray-50">
        <h2 class="text-lg font-bold text-text flex items-center gap-2">
          <Server :size="18" />
          技术架构
        </h2>
      </div>
      <div class="px-6 py-6">
        <div class="flex flex-col sm:flex-row gap-4 text-sm">
          <div class="flex-1 bg-orange-50 border border-orange-200 rounded-lg px-4 py-3.5">
            <div class="font-semibold text-orange-800 flex items-center gap-1.5 mb-1">
              <Compass :size="16" /> noj-ui
            </div>
            <div class="text-orange-700 text-xs">Nuxt 3 + Vue 3 · 用户界面</div>
          </div>
          <div class="flex-1 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3.5">
            <div class="font-semibold text-blue-800 flex items-center gap-1.5 mb-1">
              <Terminal :size="16" /> noj-core
            </div>
            <div class="text-blue-700 text-xs">Deno + Hono · RESTful API</div>
          </div>
          <div class="flex-1 bg-green-50 border border-green-200 rounded-lg px-4 py-3.5">
            <div class="font-semibold text-green-800 flex items-center gap-1.5 mb-1">
              <Box :size="16" /> noj-judge
            </div>
            <div class="text-green-700 text-xs">Rust + Docker · 评测 Worker</div>
          </div>
        </div>
      </div>
    </div>

    <!-- GitHub & 贡献者 -->
    <div class="bg-white border border-border rounded-xl overflow-hidden">
      <div class="px-6 py-5 border-b border-border bg-gray-50 flex items-center justify-between">
        <h2 class="text-lg font-bold text-text flex items-center gap-2">
          开源社区
        </h2>
        <a
          :href="repoUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1.5 text-sm text-primary no-underline hover:underline"
        >
          Neuro-OJ/neuro-oj
          <ExternalLink :size="12" />
        </a>
      </div>
      <div class="px-6 py-6">
        <p class="text-sm text-text-secondary mb-4">
          本项目在 GitHub 上开源，欢迎 Star、Issue 和 Pull Request。
        </p>

        <h3 class="text-sm font-semibold text-text mb-3">贡献者</h3>
        <div class="flex flex-wrap gap-3">
          <a
            v-for="c in contributors"
            :key="c.login"
            :href="`https://github.com/${c.login}`"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-50 border border-border rounded-full text-sm text-text-secondary no-underline hover:bg-primary-bg hover:text-primary hover:border-primary/30 transition-colors"
          >
            <span class="w-5 h-5 rounded-full bg-primary-bg text-primary flex items-center justify-center text-xs font-bold">
              {{ c.login.charAt(0).toUpperCase() }}
            </span>
            <span class="font-medium">{{ c.login }}</span>
            <span class="text-xs text-text-muted">{{ c.contributions }} commits</span>
          </a>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="text-center text-xs text-text-muted border-t border-border pt-6">
      Neuro OJ — 基于 AGPL 许可证开源。如需商业授权，请联系开发团队。
    </div>
  </div>
</template>
