<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug, can } = useWorkspace();
const { user } = useAuth();
const api = useDomainLlm();

const page = ref(1);
const usageUser = ref('');
const usageProblem = ref('');

const key = computed(() =>
  workspaceCacheKey(slug.value!, user.value?.id ?? null, `llm-usage:${page.value}:${usageUser.value}:${usageProblem.value}`)
);

const { data: usage, error: usageError, refresh: refreshUsage } = await useAsyncData(
  key,
  () =>
    can('llm:manage')
      ? api.usage(slug.value!, {
        page: page.value,
        user_id: usageUser.value || undefined,
        problem_id: usageProblem.value || undefined,
      })
      : Promise.resolve(null),
);

useSeoMeta({ title: 'LLM 用量统计 - 域设置' });
</script>

<template>
  <DomainSettingsShell>
    <div v-if="can('llm:manage')" class="space-y-6">
      <AdminPageHeader title="LLM 用量统计" description="查看本域大模型调用历史记录、Token 消耗与费用结算。" icon="i-lucide-bar-chart-3">
        <template #actions>
          <div class="flex items-center gap-2">
            <UButton :to="workspacePath(slug!, 'settings/llm')" variant="outline" icon="i-lucide-bot">
              Provider 管理
            </UButton>
            <UButton :to="workspacePath(slug!, 'settings/llm/quotas')" variant="outline" icon="i-lucide-sliders-horizontal">
              管理额度
            </UButton>
          </div>
        </template>
      </AdminPageHeader>

      <UCard class="rounded">
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <UInput
            v-model="usageUser"
            placeholder="按用户 ID 筛选"
            aria-label="按用户筛选用量"
            class="w-48"
            @update:model-value="page = 1"
          />
          <UInput
            v-model="usageProblem"
            placeholder="按题目 ID 筛选"
            aria-label="按题筛选用量"
            class="w-48"
            @update:model-value="page = 1"
          />
          <UButton variant="ghost" icon="i-lucide-refresh-cw" aria-label="刷新用量" @click="refreshUsage()">
            刷新
          </UButton>
        </div>

        <UAlert v-if="usageError" color="error" :title="extractApiError(usageError).message" class="mb-4" />

        <div v-if="!usage?.data.length" class="py-12 text-center text-sm text-text-muted">
          暂无符合条件的用量记录
        </div>

        <div v-else class="divide-y divide-border">
          <div
            v-for="entry in usage?.data"
            :key="entry.id"
            class="flex flex-wrap items-center justify-between gap-2 py-3 text-sm tabular-nums"
          >
            <div>
              <p class="font-medium text-text">
                {{ entry.model }}
                <UBadge
                  :color="entry.status === 'success' ? 'success' : entry.status === 'failed' ? 'error' : 'neutral'"
                  variant="subtle"
                  class="ml-2"
                >
                  {{ entry.status }}
                </UBadge>
              </p>
              <p class="text-xs text-text-muted mt-1">
                {{ new Date(entry.created_at).toLocaleString() }} · 用户: {{ entry.user_id }} · 题目: {{ entry.problem_id || '直接调用' }}
              </p>
            </div>
            <div class="text-right text-xs text-text-secondary">
              <p>{{ entry.total_tokens.toLocaleString() }} Token</p>
              <p class="mt-0.5 text-text-muted">费用单位：{{ entry.estimated_cost }}</p>
            </div>
          </div>
        </div>

        <!-- 分页 -->
        <div class="mt-4 flex items-center justify-end gap-3 pt-3 border-t border-border text-sm">
          <UButton variant="ghost" size="sm" :disabled="page <= 1" @click="page--">上一页</UButton>
          <span class="tabular-nums text-text-muted">第 {{ page }} 页</span>
          <UButton variant="ghost" size="sm" :disabled="(usage?.data.length ?? 0) < 30" @click="page++">下一页</UButton>
        </div>
      </UCard>
    </div>
    <UAlert v-else color="warning" title="没有当前域 LLM 管理权限" />
  </DomainSettingsShell>
</template>
