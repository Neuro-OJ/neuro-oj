<script setup lang="ts">
import type { EditorTheme } from '~/composables/useEditorTheme';
import type { DraftState } from '~/composables/useDraftStorage';

interface Problem {
  id: string;
  display_id: string;
  title: string;
  type?: 'U' | 'P';
}

interface LanguageOption {
  value: string;
  label: string;
}

const props = defineProps<{
  problem: Problem;
  language: string;
  languages: LanguageOption[];
  themeMode: EditorTheme;
  canSubmit: boolean;
  submitting: boolean;
  canSelfTest: boolean;
  selfTesting: boolean;
  canResetTemplate: boolean;
  templateLoading: boolean;
  sidebarVisible: boolean;
  draftState: DraftState;
  draftSavedAt: Date | null;
  /** 竞赛题号徽标（如 A/B/C），非竞赛场景缺省 */
  badge?: string;
  /** 工具栏副标题（如竞赛标题），非竞赛场景缺省 */
  subtitle?: string;
}>();

const emit = defineEmits<{
  'update:language': [value: string];
  'update:themeMode': [value: EditorTheme];
  'toggle-sidebar': [];
  'open-settings': [];
  submit: [];
  'self-test': [];
  'reset-template': [];
  back: [];
}>();

function toggleTheme() {
  emit('update:themeMode', props.themeMode === 'dark' ? 'light' : 'dark');
}

// 保存状态实时显示
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  if (!import.meta.client) return;
  nowTimer = setInterval(() => {
    now.value = Date.now();
  }, 5000);
});
onBeforeUnmount(() => {
  if (nowTimer) clearInterval(nowTimer);
});

const draftLabel = computed(() => {
  if (!props.draftSavedAt) return '未保存';
  const diff = Math.floor((now.value - props.draftSavedAt.getTime()) / 1000);
  if (diff < 2) return '刚刚已保存';
  if (diff < 60) return `${diff}s 前已保存`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前已保存`;
  return props.draftSavedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 已保存';
});

const draftDotClass = computed(() => {
  switch (props.draftState) {
    case 'dirty':
      return 'bg-orange-500';
    case 'saving':
      return 'bg-blue-500 animate-pulse';
    case 'error':
      return 'bg-red-500';
    case 'saved':
      return 'bg-green-500';
    default:
      return 'bg-text-muted';
  }
});
</script>

<template>
  <div role="toolbar" aria-label="代码工具栏"
    class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-bg-panel px-3 py-2 sm:h-12 sm:flex-nowrap sm:py-0">
    <!-- 左：返回 + 题目标题 -->
    <button
      class="inline-flex items-center gap-1 text-text-secondary hover:text-text transition-colors text-sm"
      aria-label="返回题目详情"
      @click="emit('back')"
    >
      <UIcon name="i-lucide-arrow-left" class="size-4" />
    </button>
    <div class="flex items-center gap-2 min-w-0">
      <span
        v-if="badge"
        class="inline-flex size-7 items-center justify-center rounded-md bg-primary-bg font-mono text-xs font-bold text-primary border border-primary/20 flex-shrink-0"
      >
        {{ badge }}
      </span>
      <span
        class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0 bg-primary/10 text-primary"
      >
        {{ problem.display_id }}
      </span>
      <div class="min-w-0">
        <span class="block text-sm font-medium text-text truncate">{{ problem.title }}</span>
        <span v-if="subtitle" class="block text-[11px] leading-tight text-text-muted truncate">{{ subtitle }}</span>
      </div>
    </div>

    <!-- 中部 spacer -->
    <div class="hidden flex-1 sm:block" />

    <!-- 保存状态（右侧） -->
    <div class="ml-auto flex items-center gap-1.5 text-xs text-text-secondary" :title="draftLabel">
      <span class="size-1.5 rounded-full" :class="draftDotClass" />
      <span class="hidden sm:inline">{{ draftLabel }}</span>
    </div>

    <!-- 右：语言 + 主题 + 侧栏 + 设置 + 提交 -->
    <div class="flex w-full min-w-0 items-center gap-1.5 overflow-x-auto sm:w-auto sm:overflow-visible">
      <slot name="actions" />

      <USelect
        :model-value="language"
        :items="languages"
        size="xs"
        class="min-w-24" aria-label="提交语言"
        @update:model-value="(v) => emit('update:language', v as string)"
      />

      <button
        class="size-8 inline-flex items-center justify-center rounded-md hover:bg-bg-page text-text-secondary transition-colors"
        :aria-label="themeMode === 'dark' ? '切换到亮色' : '切换到暗色'"
        :title="themeMode === 'dark' ? '切换到亮色' : '切换到暗色'"
        @click="toggleTheme"
      >
        <UIcon name="i-lucide-moon" class="size-4" v-if="themeMode === 'dark'" />
        <UIcon name="i-lucide-sun" class="size-4" v-else />
      </button>

      <button
        class="size-8 inline-flex items-center justify-center rounded-md hover:bg-bg-page text-text-secondary transition-colors"
        :class="sidebarVisible ? 'bg-bg-page text-primary' : ''"
        aria-label="切换侧栏"
        title="切换侧栏"
        @click="emit('toggle-sidebar')"
      >
        <UIcon name="i-lucide-sidebar" class="size-4" />
      </button>

      <button
        class="hidden size-8 items-center justify-center rounded-md hover:bg-bg-page text-text-secondary transition-colors sm:inline-flex"
        aria-label="设置"
        title="设置"
        @click="emit('open-settings')"
      >
        <UIcon name="i-lucide-settings" class="size-4" />
      </button>

      <UButton
        v-if="canResetTemplate"
        color="neutral"
        variant="outline"
        size="md"
        class="ml-1 shrink-0 whitespace-nowrap font-medium"
        :disabled="templateLoading" aria-label="重置为模板" title="重置为模板"
        @click="emit('reset-template')"
      >
        <UIcon name="i-lucide-loader-2" class="animate-spin size-3.5" v-if="templateLoading" />
        <UIcon name="i-lucide-rotate-ccw" class="size-3.5" v-else />
        <span class="hidden sm:inline">重置</span>
      </UButton>

      <UButton
        v-if="canSelfTest"
        color="neutral"
        variant="outline"
        size="md"
        class="ml-1 shrink-0 whitespace-nowrap font-medium"
        :disabled="!canSelfTest || selfTesting" aria-label="运行自测" title="运行自测"
        @click="emit('self-test')"
      >
        <UIcon name="i-lucide-loader-2" class="animate-spin size-3.5" v-if="selfTesting" />
        <UIcon name="i-lucide-flask-conical" class="size-3.5" v-else />
        <span class="hidden sm:inline">{{ selfTesting ? '自测中...' : '自测' }}</span>
      </UButton>

      <UButton color="primary" size="md" class="ml-1 shrink-0 whitespace-nowrap font-medium"
        :disabled="!canSubmit || submitting" aria-label="提交评测"
        @click="emit('submit')">
        <UIcon name="i-lucide-loader-2" class="animate-spin size-3.5" v-if="submitting" />
        <UIcon name="i-lucide-send" class="size-3.5" v-else />
        <span class="hidden sm:inline">{{ submitting ? '提交中...' : '提交评测' }}</span><span class="sm:hidden">{{ submitting ? '提交中' : '提交' }}</span>
      </UButton>
    </div>
  </div>
</template>
