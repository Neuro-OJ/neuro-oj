<script setup lang="ts">
import { computed } from "vue"

/**
 * 统一状态徽标。`status` 为状态码，`label` 缺省时自动映射或直接显示 status。
 */
const props = withDefaults(
  defineProps<{
    status: string
    label?: string
    dot?: boolean
  }>(),
  {
    label: undefined,
    dot: false,
  },
)

interface StatusDef {
  classes: string
  dotClass: string
  defaultLabel?: string
}

const STATUS_MAP: Record<string, StatusDef> = {
  // 绿色 / 成功 / 正常
  published: { classes: "bg-green-50 text-success-600 border-green-200", dotClass: "bg-success-600", defaultLabel: "已发布" },
  active: { classes: "bg-green-50 text-success-600 border-green-200", dotClass: "bg-success-600", defaultLabel: "正常" },
  enabled: { classes: "bg-green-50 text-success-600 border-green-200", dotClass: "bg-success-600", defaultLabel: "启用" },
  public: { classes: "bg-green-50 text-success-600 border-green-200", dotClass: "bg-success-600", defaultLabel: "公开" },
  resolved: { classes: "bg-green-50 text-success-600 border-green-200", dotClass: "bg-success-600", defaultLabel: "已处理" },
  approved: { classes: "bg-green-50 text-success-600 border-green-200", dotClass: "bg-success-600", defaultLabel: "已通过" },
  ac: { classes: "bg-green-50 text-success-600 border-green-200", dotClass: "bg-success-600", defaultLabel: "通过 (AC)" },
  accepted: { classes: "bg-green-50 text-success-600 border-green-200", dotClass: "bg-success-600", defaultLabel: "通过 (AC)" },
  passed: { classes: "bg-green-50 text-success-600 border-green-200", dotClass: "bg-success-600", defaultLabel: "通过" },

  // 黄色 / 警告 / 等待
  pending: { classes: "bg-amber-50 text-amber-700 border-amber-200", dotClass: "bg-amber-500", defaultLabel: "待处理" },
  pending_review: { classes: "bg-amber-50 text-amber-700 border-amber-200", dotClass: "bg-amber-500", defaultLabel: "待审查" },
  wait: { classes: "bg-amber-50 text-amber-700 border-amber-200", dotClass: "bg-amber-500", defaultLabel: "等待中" },
  waiting: { classes: "bg-amber-50 text-amber-700 border-amber-200", dotClass: "bg-amber-500", defaultLabel: "等待中" },
  ce: { classes: "bg-amber-50 text-amber-700 border-amber-200", dotClass: "bg-amber-500", defaultLabel: "编译错误 (CE)" },
  compile_error: { classes: "bg-amber-50 text-amber-700 border-amber-200", dotClass: "bg-amber-500", defaultLabel: "编译错误" },

  // 红色 / 危险 / 失败 / 封禁
  rejected: { classes: "bg-red-50 text-error-text border-red-200", dotClass: "bg-error-text", defaultLabel: "已拒绝" },
  deleted: { classes: "bg-red-50 text-error-text border-red-200", dotClass: "bg-error-text", defaultLabel: "已删除" },
  error: { classes: "bg-red-50 text-error-text border-red-200", dotClass: "bg-error-text", defaultLabel: "异常" },
  failed: { classes: "bg-red-50 text-error-text border-red-200", dotClass: "bg-error-text", defaultLabel: "失败" },
  banned: { classes: "bg-red-50 text-error-text border-red-200", dotClass: "bg-error-text", defaultLabel: "已封禁" },
  wa: { classes: "bg-red-50 text-error-text border-red-200", dotClass: "bg-error-text", defaultLabel: "答案错误 (WA)" },
  wrong_answer: { classes: "bg-red-50 text-error-text border-red-200", dotClass: "bg-error-text", defaultLabel: "答案错误 (WA)" },
  tle: { classes: "bg-red-50 text-amber-800 border-amber-300", dotClass: "bg-amber-600", defaultLabel: "超时 (TLE)" },
  time_limit_exceeded: { classes: "bg-red-50 text-amber-800 border-amber-300", dotClass: "bg-amber-600", defaultLabel: "超时 (TLE)" },
  mle: { classes: "bg-red-50 text-purple-700 border-purple-200", dotClass: "bg-purple-600", defaultLabel: "超内存 (MLE)" },
  re: { classes: "bg-red-50 text-error-text border-red-200", dotClass: "bg-error-text", defaultLabel: "运行错误 (RE)" },
  runtime_error: { classes: "bg-red-50 text-error-text border-red-200", dotClass: "bg-error-text", defaultLabel: "运行错误" },
  se: { classes: "bg-red-50 text-error-text border-red-200", dotClass: "bg-error-text", defaultLabel: "系统错误 (SE)" },

  // 蓝色 / 信息 / 进行中
  judging: { classes: "bg-primary-bg text-primary border-primary/20", dotClass: "bg-primary animate-pulse", defaultLabel: "评测中" },
  running: { classes: "bg-primary-bg text-primary border-primary/20", dotClass: "bg-primary animate-pulse", defaultLabel: "运行中" },
  invite: { classes: "bg-primary-bg text-primary border-primary/20", dotClass: "bg-primary", defaultLabel: "邀请" },
  reviewed: { classes: "bg-primary-bg text-primary border-primary/20", dotClass: "bg-primary", defaultLabel: "已审核" },

  // 灰色 / 隐藏 / 停用
  hidden: { classes: "bg-bg-sunken text-text-muted border-border", dotClass: "bg-text-muted", defaultLabel: "已隐藏" },
  disabled: { classes: "bg-bg-sunken text-text-muted border-border", dotClass: "bg-text-muted", defaultLabel: "已禁用" },
  dismissed: { classes: "bg-bg-sunken text-text-muted border-border", dotClass: "bg-text-muted", defaultLabel: "已忽略" },
  private: { classes: "bg-bg-sunken text-text-muted border-border", dotClass: "bg-text-muted", defaultLabel: "私有" },
}

const currentDef = computed(() => {
  const s = props.status?.toLowerCase() ?? ""
  return STATUS_MAP[s] ?? {
    classes: "bg-bg-sunken text-text-secondary border-border",
    dotClass: "bg-text-muted",
    defaultLabel: props.status,
  }
})

const displayLabel = computed(() => {
  if (props.label !== undefined && props.label !== null && props.label !== "") {
    return props.label
  }
  return currentDef.value.defaultLabel ?? props.status
})
</script>

<template>
  <span
    :class="[
      'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium border whitespace-nowrap tabular-nums leading-none',
      currentDef.classes,
    ]"
  >
    <span v-if="dot" class="size-1.5 rounded-full shrink-0" :class="currentDef.dotClass" />
    <span>{{ displayLabel }}</span>
  </span>
</template>
