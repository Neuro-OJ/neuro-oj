<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import type { DomainLlmQuota } from '~/composables/useDomainLlm';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug, can, domain } = useWorkspace();
const { user } = useAuth();
const capture = useWorkspaceActionScope();
const api = useDomainLlm();
const workspaces = useWorkspaceApi();
const problems = useDomainProblems();

const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'llm-quotas'));
const { data, error, refresh } = await useAsyncData(key, async () => {
  if (!can('llm:manage')) return null;
  const quotas = await api.quotas(slug.value!);
  return { quotas: quotas.data, caps: quotas.caps };
});

const writable = computed(() => domain.value?.status === 'active' && can('llm:manage'));
const busy = ref(false);
const failure = ref('');

const quota = reactive({
  id: undefined as string | undefined,
  revision: 0,
  scope_type: 'domain' as DomainLlmQuota['scope_type'],
  user: 'none',
  problem: 'none',
  window_type: 'day' as DomainLlmQuota['window_type'],
  calls: '',
  tokens: '',
  cost: '',
});

const memberPage = ref(1);
const problemPage = ref(1);
const problemSearch = ref('');
const problemKeyword = ref('');

const members = await useAsyncData(
  () => `${key.value}:members:${memberPage.value}`,
  () =>
    can('llm:manage') && can('domain:members')
      ? workspaces.members(slug.value!, memberPage.value)
      : Promise.resolve(null),
);

const problemChoices = await useAsyncData(
  () => `${key.value}:problems:${problemPage.value}:${problemKeyword.value}`,
  () => can('llm:manage') ? problems.list(slug.value!, problemPage.value, problemKeyword.value) : Promise.resolve(null),
);

watch(problemKeyword, () => {
  problemPage.value = 1;
});

const needsUser = computed(() => ['user', 'user_problem'].includes(quota.scope_type));
const needsProblem = computed(() => ['problem', 'user_problem'].includes(quota.scope_type));

const userOptions = computed(() => {
  const options = (members.data.value?.data ?? []).filter((member) => member.status === 'active').map((member) => ({
    label: member.username,
    value: member.user_id,
  }));
  if (quota.user !== 'none' && !options.some((option) => option.value === quota.user)) {
    options.push({ label: '此前选择的用户（当前页之外）', value: quota.user });
  }
  return [{ label: '选择域内用户', value: 'none' }, ...options];
});

const problemOptions = computed(() => {
  const options = (problemChoices.data.value?.items ?? []).map((problem) => ({
    label: `${problem.reference.display_ref} · ${problem.title}`,
    value: problem.reference.problem_id,
  }));
  if (quota.problem !== 'none' && !options.some((option) => option.value === quota.problem)) {
    options.push({ label: '此前选择的题目（当前页之外）', value: quota.problem });
  }
  return [{ label: '选择域内绑定题目', value: 'none' }, ...options];
});

function quotaTarget(item: DomainLlmQuota) {
  if (item.scope_type === 'domain') return '全域';
  if (!item.scope_id) {
    return {
      user: '用户额度参考值',
      problem: '题目额度参考值',
      user_problem: '用户 × 题目额度参考值',
    }[item.scope_type];
  }
  const [userId, problemId] = item.scope_type === 'user_problem' ? item.scope_id.split(':') : [
    item.scope_type === 'user' ? item.scope_id : undefined,
    item.scope_type === 'problem' ? item.scope_id : undefined,
  ];
  const username = members.data.value?.data.find((member) => member.user_id === userId)?.username;
  const reference = problemChoices.data.value?.items.find((p) => p.reference.problem_id === problemId)?.reference.display_ref;
  return [userId ? username ?? `用户 ${userId}` : null, problemId ? reference ?? `题目 ${problemId}` : null]
    .filter(Boolean).join(' × ');
}

const activeQuotas = computed(() =>
  data.value?.quotas.filter((item) => item.scope_type === 'domain' || !!item.scope_id) ?? []
);
const referenceQuotas = computed(() =>
  data.value?.quotas.filter((item) => item.scope_type !== 'domain' && !item.scope_id) ?? []
);

function limit(value: string) {
  return value.trim() ? Number(value) : null;
}

function editQuota(value: DomainLlmQuota) {
  const reference = value.scope_type !== 'domain' && !value.scope_id;
  const [userId, problemId] = value.scope_type === 'user_problem'
    ? value.scope_id.split(':')
    : [value.scope_type === 'user' ? value.scope_id : 'none', value.scope_type === 'problem' ? value.scope_id : 'none'];
  Object.assign(quota, {
    id: reference ? undefined : value.id,
    revision: reference ? 0 : value.revision,
    scope_type: value.scope_type,
    user: userId || 'none',
    problem: problemId || 'none',
    window_type: value.window_type,
    calls: value.max_calls == null ? '' : String(value.max_calls),
    tokens: value.max_tokens == null ? '' : String(value.max_tokens),
    cost: value.max_cost == null ? '' : String(value.max_cost),
  });
}

function newQuota() {
  Object.assign(quota, {
    id: undefined,
    revision: 0,
    scope_type: 'domain',
    user: 'none',
    problem: 'none',
    window_type: 'day',
    calls: '',
    tokens: '',
    cost: '',
  });
}

watch(key, () => {
  newQuota();
  failure.value = '';
});

async function saveQuota() {
  if (busy.value || !writable.value) return;
  const scope = capture();
  busy.value = true;
  failure.value = '';
  try {
    const saved = await api.saveQuota(
      scope.slug,
      {
        id: quota.id,
        scope_type: quota.scope_type,
        scope_id: quota.scope_type === 'domain'
          ? ''
          : quota.scope_type === 'user'
          ? quota.user
          : quota.scope_type === 'problem'
          ? quota.problem
          : `${quota.user}:${quota.problem}`,
        window_type: quota.window_type,
        max_calls: limit(quota.calls),
        max_tokens: limit(quota.tokens),
        max_cost: limit(quota.cost),
      },
      quota.revision,
    );
    if (scope.isCurrent()) {
      const row = saved.data;
      quota.id = row.id;
      quota.revision = row.revision;
      const response = await api.quotas(scope.slug);
      if (scope.isCurrent() && data.value) {
        data.value = { ...data.value, quotas: response.data, caps: response.caps };
      }
    }
  } catch (err) {
    if (scope.isCurrent()) failure.value = extractApiError(err).message;
  } finally {
    if (scope.isCurrent()) busy.value = false;
  }
}

async function reloadLists() {
  const scope = capture();
  failure.value = '';
  try {
    const response = await api.quotas(scope.slug);
    if (scope.isCurrent() && data.value) {
      data.value = { ...data.value, quotas: response.data, caps: response.caps };
    }
  } catch (err) {
    if (scope.isCurrent()) failure.value = extractApiError(err).message;
  }
}

useSeoMeta({ title: 'LLM 额度管理 - 域设置' });
</script>

<template>
  <DomainSettingsShell>
    <div v-if="can('llm:manage')" class="space-y-6">
      <AdminPageHeader title="LLM 额度管理" description="按全域、成员或题目配置每日/每月调用次数、Token 与费用上限。" icon="i-lucide-sliders-horizontal">
        <template #actions>
          <div class="flex items-center gap-2">
            <UButton :to="workspacePath(slug!, 'settings/llm')" variant="outline" icon="i-lucide-bot">
              Provider 管理
            </UButton>
            <UButton :to="workspacePath(slug!, 'settings/llm/usage')" variant="outline" icon="i-lucide-bar-chart-3">
              用量统计
            </UButton>
            <UButton variant="outline" :disabled="busy" @click="reloadLists">重新读取</UButton>
          </div>
        </template>
      </AdminPageHeader>

      <UAlert v-if="error" color="error" :title="extractApiError(error).message">
        <template #actions>
          <UButton @click="refresh()">重试</UButton>
        </template>
      </UAlert>

      <UAlert v-if="failure" color="error" :title="failure"
        description="原输入仍保留在表单中；并发冲突时请重新读取列表后再次编辑。" />

      <!-- 额度配置表单 -->
      <UCard v-if="data">
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-sliders" class="size-5 text-primary" />
            <h3 class="font-semibold text-text">{{ quota.id ? '编辑 LLM 资源配额' : '新增 LLM 资源配额' }}</h3>
          </div>
        </template>
        <form class="grid gap-3 sm:grid-cols-3" @submit.prevent="saveQuota">
          <USelect
            v-model="quota.scope_type"
            :items="[
              { value: 'domain', label: '全域' },
              { value: 'user', label: '域内用户' },
              { value: 'problem', label: '域内源题' },
              { value: 'user_problem', label: '用户 × 源题' }
            ]"
            :disabled="!writable || busy"
            aria-label="配额作用域"
          />
          <USelect
            v-if="needsUser"
            v-model="quota.user"
            :items="userOptions"
            :disabled="!writable || busy"
            aria-label="配额用户"
          />
          <USelect
            v-if="needsProblem"
            v-model="quota.problem"
            :items="problemOptions"
            :disabled="!writable || busy"
            aria-label="配额来源题目"
          />
          <USelect
            v-model="quota.window_type"
            :items="[{ value: 'day', label: '每天' }, { value: 'month', label: '每月' }]"
            :disabled="!writable || busy"
            aria-label="配额窗口"
          />
          <UInput
            v-model="quota.calls"
            type="number"
            min="0"
            placeholder="调用次数上限（留空不限，0禁止）"
            :disabled="!writable || busy"
            aria-label="调用次数上限"
          />
          <UInput
            v-model="quota.tokens"
            type="number"
            min="0"
            placeholder="Token 上限（留空不限，0禁止）"
            :disabled="!writable || busy"
            aria-label="Token上限"
          />
          <UInput
            v-model="quota.cost"
            type="number"
            min="0"
            step="1"
            placeholder="费用整数额度（留空不限，0禁止）"
            :disabled="!writable || busy"
            aria-label="费用整数上限"
          />
          <div class="sm:col-span-3 flex items-center gap-3 pt-1">
            <UButton
              type="submit"
              :disabled="!writable || (needsUser && quota.user === 'none') || (needsProblem && quota.problem === 'none')"
              :loading="busy"
            >
              {{ quota.id ? '更新配额' : '新增配额' }}
            </UButton>
            <UButton type="button" variant="ghost" :disabled="busy" @click="newQuota">重置为新增模式</UButton>
          </div>
        </form>

        <div v-if="needsUser" class="mt-3 flex flex-wrap items-center gap-3">
          <UAlert v-if="members.error.value" color="error" :title="extractApiError(members.error.value).message" />
          <UButton variant="ghost" size="xs" :disabled="memberPage <= 1" @click="memberPage--">上一页成员</UButton>
          <span class="text-xs tabular-nums">成员第 {{ memberPage }} 页</span>
          <UButton variant="ghost" size="xs" :disabled="(members.data.value?.data.length ?? 0) < 100" @click="memberPage++">下一页成员</UButton>
        </div>

        <form v-if="needsProblem" class="mt-3 flex flex-wrap items-center gap-2" @submit.prevent="problemKeyword = problemSearch.trim()">
          <UAlert v-if="problemChoices.error.value" color="error" :title="extractApiError(problemChoices.error.value).message" />
          <UInput v-model="problemSearch" placeholder="搜索题号或标题" size="xs" aria-label="搜索配额题目" class="w-48" />
          <UButton type="submit" variant="outline" size="xs">搜索题目</UButton>
          <UButton type="button" variant="ghost" size="xs" :disabled="problemPage <= 1" @click="problemPage--">上一页</UButton>
          <span class="text-xs tabular-nums">第 {{ problemPage }} 页</span>
          <UButton type="button" variant="ghost" size="xs" :disabled="problemPage * 30 >= (problemChoices.data.value?.total ?? 0)" @click="problemPage++">下一页</UButton>
        </form>

        <div class="mt-4 rounded border border-border bg-bg-sunken p-3 text-xs text-text-muted space-y-1">
          <p class="tabular-nums">
            {{ quota.window_type === 'day' ? '每日' : '每月' }}实例允许上限：{{ data.caps[quota.window_type].max_calls ?? '不限' }} 次 / {{ data.caps[quota.window_type].max_tokens ?? '不限' }} Token / {{ data.caps[quota.window_type].max_cost ?? '不限' }} 费用整数。
            域总额度只能降低，提高需平台治理权限。
          </p>
          <p>
            费用额度与 Provider 单价采用同一单位，使用整数；实际用量按上游返回结算，调用前预估与上游账单可能存在差异。0 表示禁止对应新增或调用，但保留历史。
          </p>
        </div>

        <!-- 已生效配额列表 -->
        <div class="mt-5 space-y-2">
          <h4 class="text-sm font-medium text-text">已生效配额规则（{{ activeQuotas.length }}）</h4>
          <div v-if="!activeQuotas.length" class="py-4 text-center text-sm text-text-muted">
            暂无已配置的生效配额
          </div>
          <div
            v-for="item in activeQuotas"
            :key="item.id"
            class="flex items-center justify-between border-t border-border py-2.5 text-sm"
          >
            <span class="text-text">
              <span class="font-medium">{{ quotaTarget(item) }}</span> ·
              {{ item.window_type === 'day' ? '每日' : '每月' }}：
              {{ item.max_calls != null ? `${item.max_calls} 次` : '不限次' }} /
              {{ item.max_tokens != null ? `${item.max_tokens} Token` : '不限 Token' }} /
              {{ item.max_cost != null ? `${item.max_cost} 费用` : '不限费用' }}
            </span>
            <UButton variant="ghost" @click="editQuota(item)">编辑配额</UButton>
          </div>
        </div>

        <!-- 额度参考值 -->
        <details v-if="referenceQuotas.length" class="mt-4 rounded border border-border p-3 text-sm">
          <summary class="cursor-pointer font-medium text-text-secondary">额度参考值（未生效）</summary>
          <p class="mt-2 text-xs text-text-muted">
            以下参考值尚未绑定用户或题目，不限制实际调用。点击按钮选择目标保存后生效。
          </p>
          <div v-for="item in referenceQuotas" :key="item.id" class="mt-2 flex items-center justify-between gap-3 border-t border-border/50 pt-2">
            <span class="text-xs text-text-secondary">
              {{ quotaTarget(item) }} · {{ item.window_type === 'day' ? '每日' : '每月' }}：
              {{ item.max_calls ?? '不限' }} 次 / {{ item.max_tokens ?? '不限' }} Token / {{ item.max_cost ?? '不限' }} 费用
            </span>
            <UButton variant="ghost" @click="editQuota(item)">按此参考值新增</UButton>
          </div>
        </details>
      </UCard>
    </div>
    <UAlert v-else color="warning" title="没有当前域 LLM 管理权限" />
  </DomainSettingsShell>
</template>
