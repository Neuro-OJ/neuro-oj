<script setup lang="ts">
import { instancePolicyDraft, instanceSettingValue } from '~/utils/instance-governance';
import type { InstancePolicyDraft, InstanceSetting } from '~/utils/instance-governance';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ initial: InstanceSetting[] }>();
const api = useInstanceAdmin();
const draft = reactive(instancePolicyDraft(props.initial));
const saved = ref([...props.initial]), saving = ref<string | null>(null), errors = ref<Record<string, string>>({});
const notices = ref<Record<string, string>>({});
const policies = [
  {
    key: 'instance_access',
    label: '实例访问',
    options: [{ label: '公开访问', value: 'public' }, { label: '仅已登录账号', value: 'authenticated' }],
  },
  {
    key: 'instance_registration_mode',
    label: '账号注册',
    options: [{ label: '开放注册', value: 'open' }, { label: '邀请注册', value: 'invite' }, {
      label: '仅平台管理员开户',
      value: 'admin_only',
    }],
  },
  {
    key: 'domain_creation_policy',
    label: '工作空间创建',
    options: [{ label: '仅平台管理员', value: 'admin' }, { label: '申请审核', value: 'approval' }, {
      label: '用户直接创建',
      value: 'open',
    }],
  },
] as const;
const modules = [{ key: 'community', label: '社区' }, { key: 'classroom', label: '班级' }, {
  key: 'assignment',
  label: '作业',
}, { key: 'analytics', label: '学情与域排行' }] as const;
function dependencies() {
  if (!draft.instance_allowed_modules.classroom) draft.instance_allowed_modules.assignment = false;
  if (!draft.instance_allowed_modules.assignment) draft.instance_allowed_modules.analytics = false;
}
async function save(key: keyof InstancePolicyDraft) {
  if (saving.value) return;
  saving.value = key;
  errors.value[key] = notices.value[key] = '';
  const setting = saved.value.find((row) => row.key === key)!;
  try {
    const result = await api.saveSetting(setting, instanceSettingValue(draft, key));
    saved.value = saved.value.map((row) => row.key === key ? result.data : row);
    notices.value[key] = '已保存';
  } catch (error) {
    errors.value[key] = extractApiError(error).message;
  } finally {
    saving.value = null;
  }
}
</script>
<template>
  <div class="space-y-5">
    <UCard>
      <h2 class="mb-4 font-semibold">访问、注册与创建政策</h2>
      <div class="space-y-4">
        <form v-for="policy in policies" :key="policy.key" class="space-y-2" @submit.prevent="save(policy.key)">
          <AdminFormField :label="policy.label">
            <USelect v-model="draft[policy.key]" :items="[...policy.options]" :aria-label="policy.label" />
          </AdminFormField>
          <UButton type="submit" :loading="saving === policy.key"
            :disabled="saving !== null">保存{{ policy.label }}</UButton>
          <p v-if="errors[policy.key]" class="text-sm text-error-text"
            role="alert">{{ errors[policy.key] }} 未保存的选择仍保留。</p>
          <p v-if="notices[policy.key]" class="text-xs text-success-text">{{ notices[policy.key] }}</p>
        </form>
        <form class="space-y-2" @submit.prevent="save('default_domain_slug')">
          <AdminFormField label="默认工作空间" hint="填写已有空间的网址标识；旧业务兼容链接始终属于 main。">
            <UInput v-model="draft.default_domain_slug" required aria-label="默认工作空间" />
          </AdminFormField>
          <UButton type="submit" :loading="saving === 'default_domain_slug'"
            :disabled="saving !== null">保存默认空间</UButton>
          <p v-if="errors.default_domain_slug" class="text-sm text-error-text"
            role="alert">{{ errors.default_domain_slug }}</p>
          <p v-if="notices.default_domain_slug" class="text-xs text-success-text">{{ notices.default_domain_slug }}</p>
        </form>
        <form class="space-y-2" @submit.prevent="save('domain_creation_limit')">
          <AdminFormField label="每个用户可负责的空间数">
            <UInputNumber v-model="draft.domain_creation_limit" :min="0" :max="1000"
              aria-label="每个用户可负责的空间数" />
          </AdminFormField>
          <UButton type="submit" :loading="saving === 'domain_creation_limit'"
            :disabled="saving !== null">保存创建数量</UButton>
          <p v-if="errors.domain_creation_limit" class="text-sm text-error-text"
            role="alert">{{ errors.domain_creation_limit }}</p>
          <p v-if="notices.domain_creation_limit"
            class="text-xs text-success-text">{{ notices.domain_creation_limit }}</p>
        </form>
        <form class="space-y-2" @submit.prevent="save('allow_domain_registration_invites')">
          <UCheckbox v-model="draft.allow_domain_registration_invites" label="允许域管理员签发新账号注册邀请" />
          <p class="text-xs text-text-muted">仅适用于实例邀请注册政策；域管理员仍不能绕过仅平台管理员开户政策。</p>
          <UButton type="submit" :loading="saving === 'allow_domain_registration_invites'"
            :disabled="saving !== null">保存邀请注册政策</UButton>
          <p v-if="errors.allow_domain_registration_invites" class="text-sm text-error-text"
            role="alert">{{ errors.allow_domain_registration_invites }}</p>
          <p v-if="notices.allow_domain_registration_invites"
            class="text-xs text-success-text">{{ notices.allow_domain_registration_invites }}</p>
        </form>
      </div>
    </UCard>
    <UCard>
      <form class="space-y-4" @submit.prevent="save('instance_allowed_modules')">
        <h2 class="font-semibold">实例允许的可选模块</h2>
        <p class="text-sm text-text-secondary">各域只能启用这里许可的模块；停用教学保留获授权历史读取。</p>
        <UCheckbox v-for="module in modules" :key="module.key" v-model="draft.instance_allowed_modules[module.key]"
          :label="module.label"
          :disabled="module.key === 'assignment' && !draft.instance_allowed_modules.classroom || module.key === 'analytics' && !draft.instance_allowed_modules.assignment"
          @update:model-value="dependencies" />
        <UButton type="submit" :loading="saving === 'instance_allowed_modules'"
          :disabled="saving !== null">保存模块许可</UButton>
        <p v-if="errors.instance_allowed_modules" class="text-sm text-error-text"
          role="alert">{{ errors.instance_allowed_modules }}</p>
        <p v-if="notices.instance_allowed_modules"
          class="text-xs text-success-text">{{ notices.instance_allowed_modules }}</p>
      </form>
    </UCard>
    <UCard
      v-for="group in ([{ key: 'domain_default_limits', title: '新空间默认额度', help: '仅在新空间创建时复制，不覆盖现有域配置。' }, { key: 'domain_limit_caps', title: '各空间资源上限', help: '实时约束所有域。降低上限保留已有资源，超额时拒绝新增。' }] as const)"
      :key="group.key">
      <form class="space-y-4" @submit.prevent="save(group.key)">
        <h2 class="font-semibold">{{ group.title }}</h2>
        <p class="text-sm text-text-secondary">{{ group.help }}</p>
        <WorkspaceLimitFields v-model="draft[group.key]" />
        <UButton type="submit" :loading="saving === group.key"
          :disabled="saving !== null">保存{{ group.title }}</UButton>
        <p v-if="errors[group.key]" class="text-sm text-error-text" role="alert">{{ errors[group.key] }}</p>
        <p v-if="notices[group.key]" class="text-xs text-success-text">{{ notices[group.key] }}</p>
      </form>
    </UCard>
    <UCard>
      <form class="space-y-4" @submit.prevent="save('domain_llm_quota_caps')">
        <h2 class="font-semibold">各空间 LLM 额度上限</h2>
        <p
          class="text-sm text-text-secondary">域管理员只能在实例上限内降低额度；费用整数与 Provider 单价采用同一单位。</p>
        <fieldset v-for="window in (['day', 'month'] as const)" :key="window" class="space-y-3">
          <legend class="font-medium">{{ window === 'day' ? '每日' : '每月' }}</legend>
          <div
            v-for="field in ([{ key: 'max_calls', label: '调用次数' }, { key: 'max_tokens', label: 'Token' }, { key: 'max_cost', label: '费用整数' }] as const)"
            :key="field.key" class="flex flex-wrap items-center gap-3">
            <UCheckbox :model-value="draft.domain_llm_quota_caps[window][field.key] === null"
              :label="`${field.label}不额外限制`"
              @update:model-value="draft.domain_llm_quota_caps[window][field.key] = $event ? null : 0" />
            <UInputNumber v-if="draft.domain_llm_quota_caps[window][field.key] !== null"
              v-model="draft.domain_llm_quota_caps[window][field.key]" :min="0" :max="2147483647"
              :aria-label="`${window === 'day' ? '每日' : '每月'}${field.label}上限`" />
          </div>
        </fieldset>
        <UButton type="submit" :loading="saving === 'domain_llm_quota_caps'"
          :disabled="saving !== null">保存 LLM 上限</UButton>
        <p v-if="errors.domain_llm_quota_caps" class="text-sm text-error-text"
          role="alert">{{ errors.domain_llm_quota_caps }}</p>
        <p v-if="notices.domain_llm_quota_caps"
          class="text-xs text-success-text">{{ notices.domain_llm_quota_caps }}</p>
      </form>
    </UCard>
  </div>
</template>
