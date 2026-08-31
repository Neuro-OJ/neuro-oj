<script setup lang="ts">
definePageMeta({
  ssr: false,
})

useHead({ title: '创建题目 - Neuro OJ' })
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[860px] mx-auto">
    <h1 class="text-2xl font-bold text-text mb-1">创建题目</h1>
    <p class="mb-6 text-sm text-text-secondary">选择要创建的题目类型</p>

    <div class="grid gap-4 sm:grid-cols-2">
      <!-- 客观题套卷 -->
      <NuxtLink
        to="/problems/new/objective"
        class="group flex flex-col gap-3 rounded-xl border border-border bg-white p-6 no-underline transition-all duration-150 hover:border-signal/50 hover:shadow-md"
      >
        <span class="flex size-11 items-center justify-center rounded-lg bg-green-100 text-green-700">
          <UIcon name="i-lucide-clipboard-list" class="size-5" />
        </span>
        <div>
          <h2 class="text-base font-semibold text-text group-hover:text-primary">客观题套卷</h2>
          <p class="mt-1 text-sm text-text-secondary leading-relaxed">
            单选 / 多选 / 判断小题，服务端即时判定，无需评测环境配置。
          </p>
        </div>
        <span class="mt-auto inline-flex items-center gap-1 text-sm font-medium text-primary">
          创建套卷
          <UIcon name="i-lucide-arrow-right" class="size-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </NuxtLink>

      <!-- Coding 编程题 -->
      <NuxtLink
        to="/problems/new/coding"
        class="group flex flex-col gap-3 rounded-xl border border-border bg-white p-6 no-underline transition-all duration-150 hover:border-signal/50 hover:shadow-md"
      >
        <span class="flex size-11 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
          <UIcon name="i-lucide-code-2" class="size-5" />
        </span>
        <div>
          <h2 class="text-base font-semibold text-text group-hover:text-primary">Coding 编程题</h2>
          <p class="mt-1 text-sm text-text-secondary leading-relaxed">
            代码提交评测，双容器沙箱，需配置评测环境与支持包。
          </p>
        </div>
        <span class="mt-auto inline-flex items-center gap-1 text-sm font-medium text-primary">
          创建编程题
          <UIcon name="i-lucide-arrow-right" class="size-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </NuxtLink>
    </div>
  </div>
</template>
