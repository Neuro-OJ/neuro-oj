<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { useToast } from '~/composables/useToast';
import InstanceNav from '~/components/admin/InstanceNav.vue';

definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false });

const api = useInstanceAdmin();
const { user } = useAuth();
const { toast } = useToast();
const { dialog } = useDialog();

const key = computed(() => `instance-settings-access:${user.value?.id}`);
const { data, status, error, refresh } = await useAsyncData(key, () => api.getSection('access'));

// 活跃空间列表供默认域选择（Requirement 4: 默认域搜索现有admin domain列表，只选active）
const domainSearch = ref('');
const domains = await useAsyncData(
  () => `instance-active-domains:${domainSearch.value}`,
  () => api.domains({ page: 1, status: 'active', keyword: domainSearch.value.trim() || undefined }),
  { watch: [domainSearch] },
);

const draft = reactive({
  instance_access: 'public' as 'public' | 'authenticated',
  instance_registration_mode: 'open' as 'open' | 'invite' | 'admin_only',
  allow_domain_registration_invites: false,
  default_domain_slug: 'main',
});

const revision = ref('');
const savedSnapshot = ref('');
const saveError = ref('');
const saving = ref(false);

function parseBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val === 'true' || val === '1';
  return false;
}

function initDraft() {
  const section = data.value?.data;
  if (!section) return;
  const vals = section.values;
  draft.instance_access = (vals.instance_access as 'public' | 'authenticated') ?? 'public';
  draft.instance_registration_mode = (vals.instance_registration_mode as 'open' | 'invite' | 'admin_only') ?? 'open';
  draft.allow_domain_registration_invites = parseBool(vals.allow_domain_registration_invites);
  draft.default_domain_slug = String(vals.default_domain_slug ?? 'main');
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
      instance_access: draft.instance_access,
      instance_registration_mode: draft.instance_registration_mode,
      allow_domain_registration_invites: draft.allow_domain_registration_invites,
      default_domain_slug: draft.default_domain_slug.trim(),
    };
    const res = await api.updateSection('access', payload, revision.value);
    revision.value = res.data.revision;
    savedSnapshot.value = JSON.stringify(draft);
    toast.success('访问与注册政策已保存');
    await refresh();
  } catch (err: unknown) {
    const apiErr = extractApiError(err);
    saveError.value = apiErr.message;
    // 409 冲突保留草稿 (Requirement 3: 409冲突保留草稿，428缺版本)
    toast.error(apiErr.message);
  } finally {
    saving.value = false;
  }
}

const activeDomainOptions = computed(() => {
  const list = (domains.data.value?.data ?? []).map((d) => ({
    label: `${d.name} (${d.slug})`,
    value: d.slug,
  }));
  if (draft.default_domain_slug && !list.some((item) => item.value === draft.default_domain_slug)) {
    list.unshift({
      label: `当前默认域: ${draft.default_domain_slug}`,
      value: draft.default_domain_slug,
    });
  }
  return list;
});

useSeoMeta({ title: '访问与注册政策 - 实例设置' });
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
            <h2 class="text-base font-semibold text-text">实例访问与账号注册政策</h2>

            <!-- 实例访问 -->
            <div class="space-y-1.5">
              <label class="block text-sm font-medium text-text">实例访问范围</label>
              <USelect
                v-model="draft.instance_access"
                :items="[
                  { label: '公开访问', value: 'public' },
                  { label: '仅已登录账号', value: 'authenticated' }
                ]"
                class="w-full max-w-[400px]"
                aria-label="实例访问范围"
              />
              <p class="text-xs text-text-secondary leading-relaxed">
                公开访问允许游客浏览公开题目、比赛和动态；仅登录账号模式下所有未认证请求均会被拦截或重定向至登录页。
              </p>
            </div>

            <!-- 账号注册模式 -->
            <div class="space-y-1.5">
              <label class="block text-sm font-medium text-text">账号注册模式</label>
              <USelect
                v-model="draft.instance_registration_mode"
                :items="[
                  { label: '开放注册', value: 'open' },
                  { label: '邀请注册', value: 'invite' },
                  { label: '仅平台管理员开户', value: 'admin_only' }
                ]"
                class="w-full max-w-[400px]"
                aria-label="账号注册模式"
              />
              <p class="text-xs text-text-secondary leading-relaxed">
                开放注册允许任何用户自主注册；邀请注册仅允许持有有效邀请凭据的用户开户；管理员开户则完全禁止公开注册接口。
              </p>
            </div>

            <!-- 允许域管理员签发注册邀请 -->
            <div class="space-y-1.5 pt-1">
              <UCheckbox
                v-model="draft.allow_domain_registration_invites"
                label="允许域管理员签发新账号注册邀请"
              />
              <p class="text-xs text-text-muted leading-relaxed pl-6">
                仅在实例邀请注册模式下生效。若实例设为仅管理员开户，域管理员签发的注册邀请仍无法用于新开户。
              </p>
            </div>

            <!-- 默认工作空间 -->
            <div class="space-y-1.5 pt-1">
              <label class="block text-sm font-medium text-text">默认工作空间</label>
              <div class="flex items-center gap-2 max-w-[400px]">
                <USelectMenu
                  v-model="draft.default_domain_slug"
                  v-model:search-term="domainSearch"
                  :items="activeDomainOptions"
                  value-key="value"
                  :ignore-filter="true"
                  class="flex-1"
                  aria-label="默认工作空间"
                />
              </div>
              <p class="text-xs text-text-secondary leading-relaxed">
                用于未指定空间时的默认入口。旧题目、提交等兼容链接始终指向 main；只能选择状态正常的现有空间。
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
