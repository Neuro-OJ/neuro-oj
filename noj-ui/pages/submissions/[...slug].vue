<script setup lang="ts">
/**
 * 旧实例级提交入口的兜底路由（#698 N3）。
 *
 * 0.11 起提交只存在于使用域内：`/d/:slug/submissions/**`。全局中间件
 * `default-workspace.global.ts` 在页面 setup 前把 `/submissions/**` 301 到 `main` 域；
 * 这个文件只保证旧链接有路由可匹配，不再保留旧界面逻辑。
 */
definePageMeta({ layout: false });
</script>

<template>
  <div class="mx-auto max-w-prose px-6 py-16 text-center text-sm text-text-secondary" role="status">
    正在前往 <NuxtLink to="/d/main/submissions" class="text-primary underline">域内提交页面</NuxtLink>…
  </div>
</template>
