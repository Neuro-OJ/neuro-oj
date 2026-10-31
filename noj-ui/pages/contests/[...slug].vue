<script setup lang="ts">
/**
 * 旧比赛入口的兼容跳转。
 *
 * 0.11 起比赛只存在于使用域（Domain）内：`/d/:slug/contests/**`。旧的无域路径
 * （`/contests`、`/contests/:id`、`/contests/:id/ranking`、
 * `/contests/:id/problems/:label`）在上一轮已由全局中间件
 * `default-workspace.global.ts` 301 到 `main` 域。
 *
 * 本轮删除了这些页面本身，Nuxt 不再有路由能匹配它们——没有这个兜底文件时，旧链接
 * 会直接 404 而不是跳到目标页。这里只做**最小重定向**：保持既有 301 语义，不恢复
 * 任何旧界面逻辑。
 */
definePageMeta({ layout: false });

const route = useRoute();
const rest = computed(() =>
  Array.isArray(route.params.slug) ? route.params.slug.join('/') : String(route.params.slug ?? '')
);
const target = computed(() =>
  `/d/main/contests${rest.value ? `/${rest.value}` : ''}`
);

await navigateTo({ path: target.value, query: route.query, hash: route.hash }, {
  redirectCode: 301,
  replace: true,
});
</script>

<template>
  <div class="mx-auto max-w-prose px-6 py-16 text-center text-sm text-text-secondary" role="status">
    正在前往 <NuxtLink :to="target" class="text-primary underline">域内比赛页面</NuxtLink>…
  </div>
</template>
