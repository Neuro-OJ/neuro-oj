<script setup lang="ts">
/**
 * 题面展示组件（#511）。
 *
 * 同时服务两种形态：
 * - 独立题目页：`editable` + `editor-to`，工具条含「在编辑器打开」与「编辑」；
 * - 竞赛做题页：`editor-to` 为 null（受 `canUseEditor`/报名状态门控），
 *   仅保留复制/展开收起，避免出现越权的编辑器入口。
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
  /** 「在编辑器打开」目标；null 时不渲染该入口。 */
  editorTo?: string | null
  /** 「编辑」目标；null 时不渲染该入口。 */
  editTo?: string | null
  /** 是否可展开/收起（题面过短时隐藏该按钮）。 */
  collapsible?: boolean
  /** 是否提供「复制题面」（客观题为作答表单，无题面可复制）。 */
  copyable?: boolean
}>(), {
  title: '题面',
  anchor: 'statement',
  editorTo: null,
  editTo: null,
  collapsible: true,
  copyable: true,
})

const expanded = defineModel<boolean>('expanded', { default: false })

// 复用既有复制封装（含成功/失败提示），避免在此重复实现剪贴板逻辑
const { copyText } = useCopyText()

function copyStatement() {
  return copyText(props.content, '题面')
}
</script>

<template>
  <section :id="anchor" class="scroll-mt-20 rounded-xl border border-border bg-white">
    <div class="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3 lg:px-7">
      <h2 class="text-sm font-semibold text-text">{{ title }}</h2>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <button
          v-if="copyable"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-signal/40 hover:text-primary"
          @click="copyStatement"
        >
          <UIcon name="i-lucide-copy" class="size-3.5" />
          复制题面
        </button>
        <button
          v-if="collapsible"
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-signal/40 hover:text-primary"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          <UIcon :name="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-3.5" />
          {{ expanded ? '收起' : '展开' }}
        </button>
        <NuxtLink
          v-if="editorTo"
          :to="editorTo"
          class="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary no-underline transition-colors hover:border-signal/40 hover:text-primary"
        >
          <UIcon name="i-lucide-code-2" class="size-3.5" />
          在编辑器打开
        </NuxtLink>
        <NuxtLink
          v-if="editTo"
          :to="editTo"
          class="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary no-underline transition-colors hover:border-signal/40 hover:text-primary"
        >
          <UIcon name="i-lucide-pencil" class="size-3.5" />
          编辑
        </NuxtLink>
      </div>
    </div>

    <div class="px-6 py-5 lg:px-7">
      <!-- 自定义正文（客观题作答表单）：不经 Markdown 渲染，也不折叠 -->
      <slot v-if="$slots.body" name="body" />

      <template v-else>
        <div v-if="collapsible && !expanded" class="relative max-h-96 overflow-hidden">
          <MarkdownRenderer :content="content" />
          <div class="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-white to-transparent" />
        </div>
        <MarkdownRenderer v-else :content="content" />
      </template>
      <button
        v-if="!$slots.body && collapsible && !expanded"
        type="button"
        class="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        @click="expanded = true"
      >
        <UIcon name="i-lucide-chevron-down" class="size-3.5" />
        展开完整题面
      </button>
    </div>
  </section>
</template>
