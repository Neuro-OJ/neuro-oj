<script setup lang="ts">
import { ArrowLeft, Moon, Sun, Settings, Sidebar, Loader2, Send } from '@lucide/vue'
import type { EditorTheme } from '~/composables/useEditorTheme'

interface Problem {
  id: string
  display_id: string
  title: string
  type: 'U' | 'P'
}

interface LanguageOption {
  value: string
  label: string
}

const props = defineProps<{
  problem: Problem
  language: string
  languages: LanguageOption[]
  themeMode: EditorTheme
  canSubmit: boolean
  submitting: boolean
  sidebarVisible: boolean
}>()

const emit = defineEmits<{
  'update:language': [value: string]
  'update:themeMode': [value: EditorTheme]
  'toggle-sidebar': []
  'open-settings': []
  submit: []
  back: []
}>()

function toggleTheme() {
  emit('update:themeMode', props.themeMode === 'dark' ? 'light' : 'dark')
}
</script>

<template>
  <div class="h-12 flex-shrink-0 bg-white border-b border-border flex items-center px-3 gap-3">
    <!-- 左：返回 + 题目标题 -->
    <button
      class="inline-flex items-center gap-1 text-text-secondary hover:text-text transition-colors text-sm"
      aria-label="返回题目详情"
      @click="emit('back')"
    >
      <ArrowLeft :size="16" />
    </button>
    <div class="flex items-center gap-2 min-w-0">
      <span
        class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0"
        :class="problem.type === 'U' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'"
      >
        {{ problem.display_id }}
      </span>
      <span class="text-sm font-medium text-text truncate">{{ problem.title }}</span>
    </div>

    <!-- 中部 spacer -->
    <div class="flex-1" />

    <!-- 右：语言 + 主题 + 侧栏 + 设置 + 提交 -->
    <div class="flex items-center gap-1.5">
      <select
        :value="language"
        class="text-xs px-2 py-1 border border-border rounded-md bg-white text-text focus:outline-none focus:border-primary"
        @change="emit('update:language', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="opt in languages" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>

      <button
        class="size-8 inline-flex items-center justify-center rounded-md hover:bg-bg-page text-text-secondary transition-colors"
        :aria-label="themeMode === 'dark' ? '切换到亮色' : '切换到暗色'"
        :title="themeMode === 'dark' ? '切换到亮色' : '切换到暗色'"
        @click="toggleTheme"
      >
        <Moon v-if="themeMode === 'dark'" :size="16" />
        <Sun v-else :size="16" />
      </button>

      <button
        class="size-8 inline-flex items-center justify-center rounded-md hover:bg-bg-page text-text-secondary transition-colors"
        :class="sidebarVisible ? 'bg-bg-page text-primary' : ''"
        aria-label="切换侧栏"
        title="切换侧栏"
        @click="emit('toggle-sidebar')"
      >
        <Sidebar :size="16" />
      </button>

      <button
        class="size-8 inline-flex items-center justify-center rounded-md hover:bg-bg-page text-text-secondary transition-colors"
        aria-label="设置"
        title="设置"
        @click="emit('open-settings')"
      >
        <Settings :size="16" />
      </button>

      <button
        class="ml-1 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-primary text-white hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        :disabled="!canSubmit || submitting"
        @click="emit('submit')"
      >
        <Loader2 v-if="submitting" :size="14" class="animate-spin" />
        <Send v-else :size="14" />
        <span>{{ submitting ? '提交中...' : '提交评测' }}</span>
      </button>
    </div>
  </div>
</template>
