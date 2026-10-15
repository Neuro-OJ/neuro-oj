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
  { value: allFilterValue, label: '全部' },
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'hard', label: '困难' },
];

const kinds = [
  { value: allFilterValue, label: '全部' },
  { value: 'oi', label: 'OI 题' },
  { value: 'ai', label: 'AI / LLM / 产物' },
  { value: 'objective', label: '客观题' },
];
const judgeBackends = [
  { value: allFilterValue, label: '全部' },
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
      label: `${t.kind === 'algorithm' ? '算法标签' : '题目标签'}: ${t.name}`,
      value: t.id,
    })),
]);
</script>

<template>
  <UCard class="mb-5 rounded-md shadow-none" :ui="{ body: 'p-4 sm:p-4' }" aria-label="题库筛选">
    <form class="flex items-center gap-3" @submit.prevent="emit('update:keyword', searchInput)">
      <UInput v-model="searchInput" icon="i-lucide-search" type="search" size="md"
        placeholder="题号、来源题号或标题" aria-label="搜索题目" class="min-w-0 flex-1" />
      <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-filter-x" class="shrink-0"
        @click="emit('reset')">清空筛选</UButton>
    </form>
    <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <UFormField label="难度" class="min-w-0">
        <USelect :model-value="difficulty || allFilterValue" :items="difficulties" size="sm" class="w-full"
          aria-label="难度"
          @update:model-value="emit('update:difficulty', filterValue($event))" />
      </UFormField>
      <UFormField label="题目类型" class="min-w-0">
        <USelect :model-value="kind || allFilterValue" :items="kinds" size="sm" class="w-full"
          aria-label="题目类型"
          @update:model-value="emit('update:kind', filterValue($event))" />
      </UFormField>
      <UFormField label="评测后端" class="min-w-0">
        <USelect :model-value="judgeBackend || allFilterValue" :items="judgeBackends" size="sm" class="w-full"
          aria-label="评测后端"
          @update:model-value="emit('update:judgeBackend', filterValue($event))" />
      </UFormField>
      <UFormField v-if="signedIn" label="我的进度" class="min-w-0">
        <USelect :model-value="progress || allFilterValue" :items="[{value:allFilterValue,label:'全部'},{value:'solved',label:'已通过'},{value:'attempted',label:'尝试未通过'},{value:'unseen',label:'未尝试'}]" size="sm" class="w-full" aria-label="筛选本人状态" @update:model-value="emit('update:progress', filterValue($event))" />
      </UFormField>
      <UFormField label="标签" class="min-w-0">
        <USelect :model-value="tagId || allFilterValue" :items="tagItems" size="sm" class="w-full" aria-label="标签"
          @update:model-value="emit('update:tagId', filterValue($event) || null)" />
      </UFormField>
    </div>
  </UCard>
</template>
