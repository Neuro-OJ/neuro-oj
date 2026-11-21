<script setup lang="ts">
import { workspacePath } from '~/utils/workspace';

/** 域首页紧凑命令头：展示域名称、简介与直达核心业务的行动入口。 */
const props = defineProps<{ title?: string; description?: string | null; slug?: string }>();
const navSlug = useNavigationDomain();
const activeSlug = computed(() => props.slug || navSlug.value);
</script>

<template>
  <div
    class="flex min-h-[172px] flex-1 min-w-0 flex-col justify-between gap-5 bg-bg-panel p-6 lg:p-8"
    data-testid="workspace-hero"
  >
    <div class="max-w-2xl space-y-2">
      <h1 class="text-2xl font-bold tracking-tight text-text lg:text-[26px]">
        {{ title || 'Neuro OJ' }}
      </h1>
      <p class="text-sm leading-relaxed text-text-secondary">
        {{ description || '面向 AI 领域认证与竞赛的在线评测平台。' }}
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2.5">
      <UButton
        :to="workspacePath(activeSlug, 'problems')"
        color="primary"
        size="sm"
        icon="i-lucide-book-open"
      >
        进入题库
      </UButton>
      <UButton
        :to="workspacePath(activeSlug, 'contests')"
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-trophy"
      >
        查看比赛
      </UButton>
      <UButton
        :to="workspacePath(activeSlug, 'trainings')"
        color="neutral"
        variant="ghost"
        size="sm"
        icon="i-lucide-list-ordered"
      >
        题单
      </UButton>
    </div>
  </div>
</template>
