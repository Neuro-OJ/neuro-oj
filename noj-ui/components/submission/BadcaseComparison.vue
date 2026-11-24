<script setup lang="ts">
import { computed, ref } from 'vue';
import { computeLineDiff, type FeedbackBadcase, isBadcaseFailedStatus } from '~/utils/aiFeedback';
import { formatMemory, formatScore, formatTime } from '~/utils/submissionFormat';

const props = defineProps<{
  badcases: FeedbackBadcase[];
}>();

type FilterMode = 'all' | 'failed' | 'partial';

const filterMode = ref<FilterMode>('all');
const selectedErrorType = ref<string>('all');
const keyword = ref('');
const diffOnlyMap = ref<Record<string, boolean>>({});

const failedCount = computed(() => props.badcases.filter((item) => isBadcaseFailedStatus(item.status)).length);
const partialCount = computed(() => props.badcases.filter((item) => !isBadcaseFailedStatus(item.status)).length);

const errorTypes = computed(() => {
  const set = new Set<string>();
  for (const item of props.badcases) {
    if (item.error_type) set.add(item.error_type);
  }
  return [...set];
});

const filteredBadcases = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  return props.badcases.filter((item) => {
    if (filterMode.value === 'failed' && !isBadcaseFailedStatus(item.status)) return false;
    if (filterMode.value === 'partial' && isBadcaseFailedStatus(item.status)) return false;
    if (selectedErrorType.value !== 'all' && item.error_type !== selectedErrorType.value) {
      return false;
    }
    if (!query) return true;
    return [item.case_id, item.status, item.error_type ?? '', item.reasoning ?? '']
      .some((field) => field.toLowerCase().includes(query));
  });
});

function toggleDiffOnly(caseId: string) {
  diffOnlyMap.value = {
    ...diffOnlyMap.value,
    [caseId]: !diffOnlyMap.value[caseId],
  };
}

function getDiffLines(item: FeedbackBadcase) {
  const lines = computeLineDiff(item.expected_output, item.actual_output);
  if (!diffOnlyMap.value[item.case_id]) return lines;
  return lines.filter((line) => line.type !== 'equal');
}

async function copyOutput(text: string | null) {
  if (text == null || typeof navigator === 'undefined' || !navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 剪贴板权限受限时静默降级
  }
}
</script>

<template>
  <section
    v-if="badcases.length > 0"
    class="rounded-lg border border-border bg-bg-panel p-4 shadow-card"
    aria-label="Badcase 对比"
  >
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-git-compare-arrows" class="size-4 text-error-text" />
        <h3 class="text-sm font-semibold text-text">可见 Badcase 对比</h3>
        <UBadge size="xs" color="error" variant="subtle">{{ badcases.length }} 条待改进</UBadge>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <UButton
          size="xs"
          :color="filterMode === 'all' ? 'primary' : 'neutral'"
          :variant="filterMode === 'all' ? 'solid' : 'outline'"
          @click="filterMode = 'all'"
        >
          全部 ({{ badcases.length }})
        </UButton>
        <UButton
          v-if="failedCount > 0"
          size="xs"
          :color="filterMode === 'failed' ? 'error' : 'neutral'"
          :variant="filterMode === 'failed' ? 'solid' : 'outline'"
          @click="filterMode = 'failed'"
        >
          未通过 ({{ failedCount }})
        </UButton>
        <UButton
          v-if="partialCount > 0"
          size="xs"
          :color="filterMode === 'partial' ? 'warning' : 'neutral'"
          :variant="filterMode === 'partial' ? 'solid' : 'outline'"
          @click="filterMode = 'partial'"
        >
          未满分 ({{ partialCount }})
        </UButton>
      </div>
    </div>

    <!-- 错误归因筛选与搜索 -->
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <UInput
        v-model="keyword"
        size="xs"
        placeholder="搜索用例 ID / 归因说明..."
        class="w-full sm:w-64"
        aria-label="筛选 Badcase"
      />
      <div v-if="errorTypes.length > 0" class="flex flex-wrap items-center gap-1.5">
        <UButton
          size="xs"
          :color="selectedErrorType === 'all' ? 'primary' : 'neutral'"
          :variant="selectedErrorType === 'all' ? 'soft' : 'ghost'"
          @click="selectedErrorType = 'all'"
        >
          全部错误类型
        </UButton>
        <UButton
          v-for="errType in errorTypes"
          :key="errType"
          size="xs"
          :color="selectedErrorType === errType ? 'error' : 'neutral'"
          :variant="selectedErrorType === errType ? 'soft' : 'ghost'"
          @click="selectedErrorType = errType"
        >
          {{ errType }}
        </UButton>
      </div>
    </div>

    <p v-if="filteredBadcases.length === 0" class="py-4 text-center text-xs text-text-muted">
      当前筛选条件下没有匹配的 Badcase。
    </p>

    <div v-else class="space-y-4">
      <article
        v-for="item in filteredBadcases"
        :key="item.case_id"
        class="rounded border border-border bg-bg-page/40 p-3.5"
      >
        <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-xs font-semibold text-text">{{ item.case_id }}</span>
            <UBadge size="xs" :color="isBadcaseFailedStatus(item.status) ? 'error' : 'warning'" variant="subtle">
              {{ item.status }}
            </UBadge>
            <UBadge v-if="item.error_type" size="xs" color="error" variant="outline">
              {{ item.error_type }}
            </UBadge>
          </div>

          <div class="flex flex-wrap items-center gap-3 text-xs text-text-secondary tabular-nums">
            <span v-if="item.score != null">
              得分 {{ formatScore(item.score) }}<template v-if="item.max_score != null"> / {{ formatScore(item.max_score) }}</template>
            </span>
            <span v-if="item.time_ms != null">{{ formatTime(item.time_ms) }}</span>
            <span v-if="item.memory_kb != null">{{ formatMemory(item.memory_kb) }}</span>
            <UButton
              v-if="item.expected_output !== null || item.actual_output !== null"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="toggleDiffOnly(item.case_id)"
            >
              {{ diffOnlyMap[item.case_id] ? '显示全部行' : '仅看差异行' }}
            </UButton>
          </div>
        </div>

        <!-- 裁判归因说明 -->
        <div
          v-if="item.reasoning"
          class="mb-3 rounded border border-warning-border bg-warning-bg px-3 py-2 text-xs text-text"
        >
          <span class="font-semibold text-warning-text">归因分析：</span>{{ item.reasoning }}
        </div>

        <!-- 输入预览 -->
        <div v-if="item.input !== null" class="mb-3">
          <p class="mb-1 text-[11px] font-semibold text-text-muted">测试输入</p>
          <pre
            class="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-sunken p-2.5 font-mono text-[11px] text-text">{{
            item.input
          }}</pre>
        </div>

        <!-- 左右分栏对比 + 行级 Diff 高亮 -->
        <div
          v-if="item.expected_output !== null || item.actual_output !== null"
          class="grid gap-3 lg:grid-cols-2"
        >
          <!-- 期望输出 -->
          <div class="min-w-0">
            <div class="mb-1 flex items-center justify-between">
              <p class="text-[11px] font-semibold text-text-muted">期望输出 (Expected)</p>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy"
                @click="copyOutput(item.expected_output)">
                复制
              </UButton>
            </div>
            <div
              class="max-h-56 overflow-auto rounded bg-bg-dark p-2 font-mono text-[11px] leading-relaxed text-text-on-dark">
              <template v-for="(line, lIdx) in getDiffLines(item)" :key="`exp-${item.case_id}-${lIdx}`">
                <div
                  v-if="line.type !== 'added'"
                  class="flex gap-2 whitespace-pre-wrap break-all px-1.5 py-0.5"
                  :class="line.type === 'removed' ? 'border-l-2 border-rose-400 bg-rose-500/20 text-rose-100' : ''"
                >
                  <span class="w-7 shrink-0 select-none text-right text-slate-500 tabular-nums">
                    {{ line.expectedLineNo ?? '' }}
                  </span>
                  <span class="min-w-0 flex-1">{{ line.text || ' ' }}</span>
                </div>
              </template>
              <p v-if="item.expected_output === null" class="px-1.5 text-slate-400">--</p>
            </div>
          </div>

          <!-- 实际输出 -->
          <div class="min-w-0">
            <div class="mb-1 flex items-center justify-between">
              <p class="text-[11px] font-semibold text-text-muted">实际输出 (Actual)</p>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy"
                @click="copyOutput(item.actual_output)">
                复制
              </UButton>
            </div>
            <div
              class="max-h-56 overflow-auto rounded bg-bg-dark p-2 font-mono text-[11px] leading-relaxed text-text-on-dark">
              <template v-for="(line, lIdx) in getDiffLines(item)" :key="`act-${item.case_id}-${lIdx}`">
                <div
                  v-if="line.type !== 'removed'"
                  class="flex gap-2 whitespace-pre-wrap break-all px-1.5 py-0.5"
                  :class="line.type === 'added' ? 'border-l-2 border-amber-400 bg-amber-500/20 text-amber-100' : ''"
                >
                  <span class="w-7 shrink-0 select-none text-right text-slate-500 tabular-nums">
                    {{ line.actualLineNo ?? '' }}
                  </span>
                  <span class="min-w-0 flex-1">{{ line.text || ' ' }}</span>
                </div>
              </template>
              <p v-if="item.actual_output === null" class="px-1.5 text-slate-400">--</p>
            </div>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
