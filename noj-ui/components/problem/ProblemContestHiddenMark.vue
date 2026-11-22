<script setup lang="ts">
import { CONTEST_HIDDEN_TIP } from '~/utils/contestHidden'

/**
 * 「被公开赛收编」视觉标识（VULN-07）。
 *
 * 后端只对特权用户（管理员 / 题目所有者）在列表中下发 `is_contest_hidden: true`；
 * 普通用户看不到该行。本组件给出统一的悬浮说明，斜纹底由调用方按
 * `contestHiddenRowClass()` 施加在行/卡片本体上（表格 `<tr>` 无法被组件包裹，
 * 故样式与标识分离，而不是把两者硬绑在同一个组件里）。
 *
 * 提示用 Nuxt UI `UTooltip`（键盘聚焦同样可触发），而非原生 `title`：
 * 原生提示无法控制延迟、样式，也不参与无障碍语义。
 */
</script>

<template>
  <UTooltip :text="CONTEST_HIDDEN_TIP" :delay-duration="100">
    <span
      class="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-white/80 px-1.5 py-0.5 text-[10px] font-medium text-text-secondary"
    >
      <UIcon name="i-lucide-eye-off" class="size-3" />
      已收编
    </span>
  </UTooltip>
</template>
