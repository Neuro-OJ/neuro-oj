<script setup lang="ts">
interface Tag {
  id: string;
  name: string;
  kind: 'problem' | 'algorithm';
}

interface Props {
  keyword: string;
  difficulty: string;
  tagId: string | null;
  kind?: string;
  progress?: string;
  signedIn?: boolean;
  judgeBackend?: string;
  tags: Tag[];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:keyword': [value: string];
  'update:difficulty': [value: string];
  'update:tagId': [value: string | null];
  'update:kind': [value: string];
  'update:progress': [value: string];
  'update:judgeBackend': [value: string];
  reset: [];
}>();

const searchInput = ref(props.keyword);
const advancedOpen = ref(false);
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

watch(searchInput, (val) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    emit('update:keyword', val);
  }, 300);
});

watch(() => props.keyword, (val) => {
  if (val !== searchInput.value) {
    clearTimeout(debounceTimer);
    searchInput.value = val;
  }
});

onUnmounted(() => {
  clearTimeout(debounceTimer);
});

const allFilterValue = '__all__';

function filterValue(value: string | undefined): string {
  return value === allFilterValue ? '' : value ?? '';
}

const difficulties = [
  { value: allFilterValue, label: '全部难度' },
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'hard', label: '困难' },
];

const kinds = [
  { value: allFilterValue, label: '全部类型' },
  { value: 'oi', label: 'OI 题' },
  { value: 'ai', label: 'AI / LLM / 产物' },
  { value: 'objective', label: '客观题' },
];

const progressOptions = [
  { value: allFilterValue, label: '全部进度' },
  { value: 'solved', label: '已通过' },
  { value: 'attempted', label: '尝试未通过' },
  { value: 'unseen', label: '未尝试' },
];

const judgeBackends = [
  { value: allFilterValue, label: '全部后端' },
  { value: 'dual', label: 'dual' },
  { value: 'oi-native', label: 'oi-native' },
  { value: 'oi-wasm', label: 'oi-wasm' },
];

// 标签选项：按 kind 排序（题目标签在前），label 带 kind 前缀区分
const tagItems = computed(() => [
  { label: '全部标签', value: allFilterValue },
  ...[...props.tags]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'problem' ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((t) => ({
      label: `${t.kind === 'algorithm' ? '算法' : '题目'}: ${t.name}`,
      value: t.id,
    })),
]);

const advancedCount = computed(() => (props.tagId ? 1 : 0) + (props.judgeBackend ? 1 : 0));

const activeChips = computed(() => {
  const chips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (props.keyword) {
    chips.push({
      key: 'keyword',
      label: `关键词: ${props.keyword}`,
      clear: () => {
        searchInput.value = '';
        emit('update:keyword', '');
      },
    });
  }
  if (props.difficulty) {
    const label = difficulties.find((d) => d.value === props.difficulty)?.label ?? props.difficulty;
    chips.push({ key: 'difficulty', label: `难度: ${label}`, clear: () => emit('update:difficulty', '') });
  }
  if (props.kind) {
    const label = kinds.find((k) => k.value === props.kind)?.label ?? props.kind;
    chips.push({ key: 'kind', label: `类型: ${label}`, clear: () => emit('update:kind', '') });
  }
  if (props.signedIn && props.progress) {
    const label = progressOptions.find((p) => p.value === props.progress)?.label ?? props.progress;
    chips.push({ key: 'progress', label: `进度: ${label}`, clear: () => emit('update:progress', '') });
  }
  if (props.tagId) {
    const tag = props.tags.find((t) => t.id === props.tagId);
    chips.push({ key: 'tag', label: `标签: ${tag?.name ?? props.tagId}`, clear: () => emit('update:tagId', null) });
  }
  if (props.judgeBackend) {
    chips.push({ key: 'backend', label: `后端: ${props.judgeBackend}`, clear: () => emit('update:judgeBackend', '') });
  }
  return chips;
});
</script>

<template>
  <UCard class="mb-4 rounded-md shadow-none" :ui="{ body: 'p-3 sm:p-4' }" aria-label="题库筛选">
    <!-- 主筛选行：搜索 + 核心筛选项 + 更多筛选切换 -->
    <form class="flex flex-wrap items-center gap-2.5" @submit.prevent="emit('update:keyword', searchInput)">
      <UInput
        v-model="searchInput"
        icon="i-lucide-search"
        type="search"
        size="sm"
        placeholder="搜索题号、来源题号或标题..."
        aria-label="搜索题目"
        class="min-w-48 flex-1"
      />
      <USelect
        :model-value="difficulty || allFilterValue"
        :items="difficulties"
        size="sm"
        class="w-28 sm:w-32"
        aria-label="难度"
        @update:model-value="emit('update:difficulty', filterValue($event))"
      />
      <USelect
        :model-value="kind || allFilterValue"
        :items="kinds"
        size="sm"
        class="w-32 sm:w-36"
        aria-label="题目类型"
        @update:model-value="emit('update:kind', filterValue($event))"
      />
      <USelect
        v-if="signedIn"
        :model-value="progress || allFilterValue"
        :items="progressOptions"
        size="sm"
        class="w-28 sm:w-32"
        aria-label="筛选本人状态"
        @update:model-value="emit('update:progress', filterValue($event))"
      />
      <UButton
        type="button"
        color="neutral"
        :variant="advancedOpen || advancedCount > 0 ? 'soft' : 'outline'"
        size="sm"
        icon="i-lucide-sliders-horizontal"
        :aria-expanded="advancedOpen || advancedCount > 0"
        @click="advancedOpen = !advancedOpen"
      >
        <span>更多</span>
        <span
          v-if="advancedCount > 0"
          class="ml-1 inline-flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-white tabular-nums"
        >
          {{ advancedCount }}
        </span>
      </UButton>
    </form>

    <!-- 可折叠次级筛选行：标签与底层评测后端 -->
    <div v-if="advancedOpen || advancedCount > 0" class="mt-3 grid grid-cols-1 gap-2.5 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-4">
      <UFormField label="标签" class="min-w-0">
        <USelect
          :model-value="tagId || allFilterValue"
          :items="tagItems"
          size="sm"
          class="w-full"
          aria-label="标签"
          @update:model-value="emit('update:tagId', filterValue($event) || null)"
        />
      </UFormField>
      <UFormField label="评测后端" class="min-w-0">
        <USelect
          :model-value="judgeBackend || allFilterValue"
          :items="judgeBackends"
          size="sm"
          class="w-full"
          aria-label="评测后端"
          @update:model-value="emit('update:judgeBackend', filterValue($event))"
        />
      </UFormField>
    </div>

    <!-- 已激活筛选 Chips -->
    <div v-if="activeChips.length > 0" class="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-2.5">
      <span class="text-xs text-text-muted mr-1">已筛选：</span>
      <button
        v-for="chip in activeChips"
        :key="chip.key"
        type="button"
        class="inline-flex items-center gap-1 rounded-sm border border-primary/25 bg-primary-bg px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary-hover-bg"
        @click="chip.clear()"
      >
        <span>{{ chip.label }}</span>
        <UIcon name="i-lucide-x" class="size-3" />
      </button>
      <UButton
        type="button"
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-rotate-ccw"
        class="ml-auto"
        @click="emit('reset')"
      >
        清空筛选
      </UButton>
    </div>
  </UCard>
</template>
