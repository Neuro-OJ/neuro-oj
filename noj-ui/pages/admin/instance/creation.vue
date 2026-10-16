<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { useToast } from '~/composables/useToast';
import InstanceNav from '~/components/admin/InstanceNav.vue';

definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false });

const api = useInstanceAdmin();
const { user } = useAuth();
const { toast } = useToast();
const { dialog } = useDialog();

const key = computed(() => `instance-settings-creation:${user.value?.id}`);
const { data, status, error, refresh } = await useAsyncData(key, () => api.getSection('creation'));

const draft = reactive({
  domain_creation_policy: 'admin' as 'admin' | 'approval' | 'open',
  domain_creation_limit: 3,
});

const revision = ref('');
const savedSnapshot = ref('');
const saveError = ref('');
const saving = ref(false);

function initDraft() {
  const section = data.value?.data;
  if (!section) return;
  const vals = section.values;
  draft.domain_creation_policy = (vals.domain_creation_policy as 'admin' | 'approval' | 'open') ?? 'admin';
  draft.domain_creation_limit = Number(vals.domain_creation_limit ?? 3);
  revision.value = section.revision ?? '';
  savedSnapshot.value = JSON.stringify(draft);
  saveError.value = '';
}

const dirty = computed(() => !!savedSnapshot.value && JSON.stringify(draft) !== savedSnapshot.value);

watch(data, () => {
  if (!savedSnapshot.value || !revision.value || !dirty.value) initDraft();
}, { immediate: true });

useUnsavedChanges(() => dirty.value);

async function reload() {
  if (dirty.value && !await dialog.confirm('重新读取会替换本页尚未保存的修改。确认重新读取？', { title: '重新读取政策' })) {
    return;
  }
  await refresh();
  if (!error.value) initDraft();
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    const payload = {
      domain_creation_policy: draft.domain_creation_policy,
      domain_creation_limit: draft.domain_creation_limit,
    };
    const res = await api.updateSection('creation', payload, revision.value);
    revision.value = res.data.revision;
    savedSnapshot.value = JSON.stringify(draft);
    toast.success('空间创建政策已保存');
    await refresh();
  } catch (err: unknown) {
    const apiErr = extractApiError(err);
    saveError.value = apiErr.message;
    toast.error(apiErr.message);
  } finally {
    saving.value = false;
  }
}

useSeoMeta({ title: '空间创建政策 - 实例设置' });
</script>

<template>
  <div class="space-y-6">
    <AdminPageHeader title="实例与域治理" description="管理实例全局政策、可选模块与各空间资源上限。" icon="i-lucide-building-2">
      <template #actions>
        <UButton variant="outline" @click="reload">重新读取政策</UButton>
      </template>
    </AdminPageHeader>

    <InstanceNav />

    <div class="max-w-[768px]">
      <AsyncContent
        :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
        :error="error ? extractApiError(error).message : undefined"
        @retry="refresh()"
      >
        <UCard class="rounded border border-border bg-bg-panel shadow-xs">
          <form class="space-y-6" @submit.prevent="save">
            <h2 class="text-base font-semibold text-text">工作空间创建政策</h2>

            <!-- 创建模式 -->
            <div class="space-y-1.5">
              <label class="block text-sm font-medium text-text">空间创建审批政策</label>
              <USelect
                v-model="draft.domain_creation_policy"
                :items="[
                  { label: '仅平台管理员创建', value: 'admin' },
                  { label: '用户申请审核', value: 'approval' },
                  { label: '用户直接创建', value: 'open' }
                ]"
                class="w-full max-w-[400px]"
                aria-label="空间创建审批政策"
              />
              <p class="text-xs text-text-secondary leading-relaxed">
                仅管理员模式下普通用户无法新建空间；申请审核模式下用户需提交申请由管理员在后台审批；直接创建模式允许注册用户自主开通。
              </p>
            </div>

            <!-- 每个用户可负责的空间数 -->
            <div class="space-y-1.5">
              <label class="block text-sm font-medium text-text">每个用户可负责的空间数上限</label>
              <UInputNumber
                v-model="draft.domain_creation_limit"
                :min="0"
                :max="1000"
                class="w-[200px]"
                aria-label="每个用户可负责的空间数"
              />
              <p class="text-xs text-text-secondary leading-relaxed">
                限制单个用户账户最多能够作为负责人拥有多少个工作空间。输入 0 表示禁止普通用户创建新空间。
              </p>
            </div>

            <UAlert v-if="saveError" color="error" :title="saveError" description="未保存的修改仍保留在表单中，请核对后重试。" />

            <div class="pt-2">
              <UButton type="submit" color="primary" :loading="saving">保存政策</UButton>
            </div>
          </form>
        </UCard>
      </AsyncContent>
    </div>
  </div>
</template>
