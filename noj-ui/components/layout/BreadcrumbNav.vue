<script setup lang="ts">
import type { BreadcrumbItem } from '~/utils/breadcrumb'

/**
 * 全站面包屑导航（#512）。
 *
 * - 覆盖 `layouts/default.vue` 下的内容页；`/admin/*` 与认证页不在注册表内，
 *   解析结果为空数组，组件整体不渲染（对现有页面零行为改变）。
 * - 层级来源为集中注册表（`utils/breadcrumb.ts`），不是每页手写，
 *   避免「有的页面有、有的没有」。
 * - 动效与配色遵守 NOJ 暖纸 token：`text-text-muted` → 悬停 `text-primary`。
 */

const items = useBreadcrumbItems()
const route = useRoute()

/**
 * 面包屑由布局渲染（保证新页面默认就有），但每个内容页的容器宽度并不一致
 * （`max-w-[860px]` / `960px` / `4xl` / `7xl` …）。若不跟随，
 * 面包屑会与页面标题错位。
 *
 * 因此页面用可序列化的 `definePageMeta({ breadcrumbWidth })` 声明容器宽度，
 * 未声明时用既有最普遍的 `960px`。`route.meta` 在 SSR 首帧即可读，
 * 不需要额外状态或中间件。
 */
const maxWidth = computed(() => (route.meta.breadcrumbWidth as string | undefined) ?? '960px')

/** 末层为当前页，不可点击并带 aria-current="page"。 */
const crumbs = computed(() =>
  items.value.map((item, index) => ({
    ...item,
    active: index === items.value.length - 1,
  })),
)
</script>

<template>
  <!-- 单层（如「题库」）没有回跳价值，隐藏以免占据首屏 -->
  <nav
    v-if="items.length > 1"
    aria-label="面包屑"
    class="mx-auto w-full px-4 pt-4 sm:px-6"
    :style="{ maxWidth }"
  >
    <ol class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      <li v-for="(crumb, index) in crumbs" :key="`${crumb.label}-${index}`" class="flex min-w-0 items-center gap-x-1.5">
        <NuxtLink
          v-if="!crumb.active && crumb.to"
          :to="crumb.to"
          class="max-w-[16rem] truncate text-text-muted no-underline transition-colors hover:text-primary"
          :title="crumb.label"
        >
          {{ crumb.label }}
        </NuxtLink>
        <span
          v-else
          class="max-w-[16rem] truncate font-medium text-text-secondary"
          :aria-current="crumb.active ? 'page' : undefined"
          :title="crumb.label"
        >
          {{ crumb.label }}
        </span>
        <UIcon
          v-if="index < crumbs.length - 1"
          name="i-lucide-chevron-right"
          class="size-3 shrink-0 text-text-muted"
          aria-hidden="true"
        />
      </li>
    </ol>
  </nav>
</template>
