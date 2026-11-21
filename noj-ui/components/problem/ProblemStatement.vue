<script setup lang="ts">
/**
 * 题面展示组件（#511）。
 *
 * 同时服务两种形态：
 * - 独立题目页：工具条含复制、收起与「编辑」；
 * - 竞赛做题页：仅保留复制与收起。
 * 编辑器入口由调用方放在题目抬头，题面工具条不再重复提供（#685）。
 * 折叠时由同一工具条按钮在「收起」与「展开」间原位切换，避免按钮消失导致无法重新展开。
 *
 * 展开/收起状态由调用方通过 `v-model:expanded` 持有，组件本身不保存状态。
 */
const props = withDefaults(defineProps<{
  /** 题面原文（Markdown）。objective 形态下可为空。 */
  content: string
  /** 卡片标题。 */
  title?: string
  /** 锚点 id，便于页内「题面」链接定位。 */
  anchor?: string
  /** 「编辑」目标；null 时不渲染该入口。 */
  editTo?: string | null
  /** 是否可展开/收起（题面过短时隐藏该按钮）。 */
  collapsible?: boolean
  /** 是否提供「复制题面」（客观题为作答表单，无题面可复制）。 */
  copyable?: boolean
}>(), {
  title: '题面',
  anchor: 'statement',
  editTo: null,
  collapsible: true,
  copyable: true,
})

const expanded = defineModel<boolean>('expanded', { default: false })

// 复用既有复制封装（含成功/失败提示），并补充按钮内 1.5s 已复制图标反馈
const { copyText } = useCopyText()
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

async function copyStatement() {
  await copyText(props.content, '题面')
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 1500)
}

onUnmounted(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<template>
  <section :id="anchor" class="scroll-mt-20 rounded-md border border-border bg-bg-panel">
    <div
      class="flex flex-wrap items-center gap-2 px-5 py-3 lg:px-6"
      :class="!collapsible || expanded ? 'border-b border-border' : ''"
    >
      <h2 class="text-sm font-semibold text-text">{{ title }}</h2>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <slot name="toolbar" />
        <button
          v-if="copyable"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg-panel px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-primary/40 hover:text-primary"
          @click="copyStatement"
        >
          <UIcon :name="copied ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3.5" :class="copied ? 'text-signal' : ''" />
          {{ copied ? '已复制' : '复制题面' }}
        </button>
        <button
          v-if="collapsible"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg-panel px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-primary/40 hover:text-primary"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          <UIcon :name="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-3.5" />
          {{ expanded ? '收起' : '展开' }}
        </button>
        <NuxtLink
          v-if="editTo"
          :to="editTo"
          class="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg-panel px-2.5 py-1 text-xs font-medium text-text-secondary no-underline transition-colors hover:border-primary/40 hover:text-primary"
        >
          <UIcon name="i-lucide-pencil" class="size-3.5" />
          编辑
        </NuxtLink>
      </div>
    </div>

    <div v-if="!collapsible || expanded" class="px-5 py-5 lg:px-6">
      <!-- 自定义正文（客观题作答表单）：不经 Markdown 渲染，也不折叠 -->
      <slot v-if="$slots.body" name="body" />

      <template v-else>
        <MarkdownRenderer :content="content" />
        <slot name="after-content" />
      </template>
    </div>
  </section>
</template>
