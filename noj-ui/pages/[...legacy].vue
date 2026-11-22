<script setup lang="ts">
/**
 * 未匹配路径的唯一兜底页。
 *
 * 旧无域入口（`/problems/**`、`/contests/**`、`/search` 等）由全局中间件
 * `default-workspace.global.ts` 在页面 setup 前 301 到 `main` 域；这个文件只
 * 保证这些旧路径有路由可匹配。能走到 setup 的都不是已知旧入口，直接 404。
 */
definePageMeta({ layout: false });
throw createError({ statusCode: 404, statusMessage: '页面不存在', fatal: true });
</script>

<template>
  <div />
</template>
