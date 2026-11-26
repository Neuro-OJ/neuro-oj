<script setup lang="ts">
import { workspacePath } from '~/utils/domain/workspace/workspace';

/** 域首页紧凑命令头：展示域名称、简介与直达核心业务的行动入口。 */
const props = defineProps<{ title?: string; description?: string | null; slug?: string }>();
const navSlug = useNavigationDomain();
const activeSlug = computed(() => props.slug || navSlug.value);
</script>

<template>
  <div
    class="flex flex-1 min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 bg-bg-panel px-4 py-3"
    data-testid="workspace-hero"
  >
    <div class="min-w-0 max-w-3xl">
      <h1 class="text-lg font-semibold text-text">
        {{ title || 'Neuro OJ' }}
      </h1>
      <p class="mt-0.5 truncate text-xs text-text-muted">
        {{ description || '面向 AI 领域认证与竞赛的在线评测平台。' }}
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      <UButton
        :to="workspacePath(activeSlug, 'problems')"
        color="primary"
        size="xs"
      >
        进入题库
      </UButton>
      <UButton
        :to="workspacePath(activeSlug, 'contests')"
        color="neutral"
        variant="outline"
        size="xs"
      >
        查看比赛
      </UButton>
      <UButton
        :to="workspacePath(activeSlug, 'trainings')"
        color="neutral"
        variant="ghost"
        size="xs"
      >
        题单
      </UButton>
    </div>
  </div>
</template>
