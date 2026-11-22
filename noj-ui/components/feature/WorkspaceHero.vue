<script setup lang="ts">
/** 域首页头部：展示域名称与简介（轮播已于 2026-11 下线，#698）。 */
defineProps<{ title?: string; description?: string | null }>();
</script>

<template>
  <div
    class="flex-1 min-w-0 min-h-[320px] p-8 lg:p-12 flex flex-col justify-center text-text bg-gradient-to-br from-[#e0f2fe] via-[#f0f9ff] to-[#ffffff]"
    data-testid="workspace-hero"
  >
    <h2 class="text-2xl lg:text-3xl font-bold mb-3">{{ title || 'Neuro OJ' }}</h2>
    <p class="text-sm lg:text-base text-text-secondary max-w-[480px] leading-relaxed">
      {{ description || '面向 AI 领域认证与竞赛的在线评测平台。' }}
    </p>
  </div>
</template>
