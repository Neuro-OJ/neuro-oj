<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/domain/workspace/workspace';
import { extractApiError } from '~/utils/server/apiError';
const props = defineProps<{
  slug: string;
  reference: string;
  selected: string;
  version: number;
  current: string;
  mode: 'any' | 'exact';
  required?: string | null;
}>();
const emit = defineEmits<{ select: [id: string] }>();
const { user } = useAuth(), api = useDomainProblems(), page = ref(1), open = ref(false);
const key = computed(() =>
  workspaceCacheKey(props.slug, user.value?.id ?? null, 'version-selector', props.reference, String(page.value))
);
const { data, status, error, refresh } = await useAsyncData(
  key,
  () => api.versions(props.slug, props.reference, page.value),
  { immediate: false },
);
watch([open, page], ([isOpen]) => {
  if (isOpen) void refresh();
});
watch(() => props.reference, () => {
  page.value = 1;
  open.value = false;
});
const recognized = (id: string) => props.mode === 'any' || id === props.required;
function select(id: string) {
  emit('select', id);
  open.value = false;
}
</script>
<template>
  <UPopover v-model:open="open">
    <UButton color="neutral" variant="outline" size="xs" trailing-icon="i-lucide-chevron-down"
      :class="recognized(selected) ? 'text-success-text' : 'text-text-muted'"
      aria-label="选择作答版本">v{{ version }}</UButton>
    <template #content>
      <div class="w-72 space-y-2 p-3">
        <p class="px-2 text-xs text-text-muted">绿色版本的正式成绩计入当前题库成绩。</p>
        <p v-if="error"
          class="px-2 text-sm text-error-text">{{ extractApiError(error).message }} <UButton type="button" variant="link" color="primary" size="xs" class="p-0 underline" @click="refresh()">重试</UButton></p>
        <p v-else-if="status === 'pending'" class="px-2 text-sm text-text-muted">加载版本…</p>
        <div v-else class="max-h-72 overflow-y-auto" role="listbox" aria-label="作答版本">
          <UButton v-for="item in data?.items" :key="item.version_id" type="button" role="option" block
            variant="ghost" color="neutral"
            :aria-selected="item.version_id === selected"
            class="flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left font-normal hover:bg-bg-sunken"
            :class="recognized(item.version_id) ? 'text-success-text' : 'text-text-muted'"
            @click="select(item.version_id)">
            <span>v{{ item.version }}{{ item.version_id === current ? '（当前版本）' : '' }}</span>
            <UIcon v-if="item.version_id === selected" name="i-lucide-check" class="size-4" />
          </UButton>
        </div>
        <UPagination v-if="data && data.total > data.limit" v-model:page="page" :total="data.total"
          :items-per-page="data.limit" :sibling-count="0" size="xs" />
      </div>
    </template>
  </UPopover>
</template>
