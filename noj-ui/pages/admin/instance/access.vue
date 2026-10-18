<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { useToast } from '~/composables/useToast';
import InstanceNav from '~/components/admin/InstanceNav.vue';

definePageMeta({ layout: 'admin', middleware: 'admin', });

const api = useInstanceAdmin();
const { user } = useAuth();
const { toast } = useToast();
const { dialog } = useDialog();

const key = computed(() => `instance-settings-access:${user.value?.id}`);
const { data, status, error, refresh } = await useAsyncData(key, () => api.getSection('access'));

// 活跃空间列表供默认域选择
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
    toast.error(apiErr.message);
  } finally {
    saving.value = false;
  }
}

// 原始候选数据与空结果判断：按原始 API 候选数量判定，fallback 仅作当前值显示而不冒充搜索结果
const rawDomainCandidates = computed(() => domains.data.value?.data ?? []);
const hasSearch = computed(() => !!domainSearch.value.trim());
const isSearchEmpty = computed(() => {
  return hasSearch.value &&
    domains.status.value !== 'pending' &&
    !domains.error.value &&
    rawDomainCandidates.value.length === 0;
});

const activeDomainOptions = computed(() => {
  const list = rawDomainCandidates.value.map((d) => ({
    label: `${d.name} (${d.slug})`,
    value: d.slug,
  }));
  // fallback 仅用于展示当前选中的默认域，避免未在首屏候选中时丢失展示
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
                公开访问允许游客浏览公开题目、比赛和动态；仅已登录账号模式下，访客必须先登录才能访问站内内容。
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
                开放注册允许任何访客自主注册；邀请注册仅允许凭有效邀请凭据注册；管理员开户则仅允许由平台管理员统一创建账号。
              </p>
            </div>

            <!-- 允许域管理员签发注册邀请（区分生效模式与预设状态） -->
            <div class="space-y-1.5 pt-1">
              <template v-if="draft.instance_registration_mode === 'invite'">
                <label class="block text-sm font-medium text-text">邀请注册政策</label>
                <UCheckbox
                  v-model="draft.allow_domain_registration_invites"
                  label="允许域管理员签发新账号注册邀请"
                />
                <p class="text-xs text-text-secondary leading-relaxed pl-6">
                  启用后，各空间的域管理员可直接生成新账号注册邀请；未勾选时仅平台管理员可签发。
                </p>
              </template>
              <template v-else>
                <label class="block text-sm font-medium text-text">邀请注册时的政策（预设）</label>
                <div class="rounded border border-border bg-bg-sunken p-3 text-xs text-text-secondary space-y-2">
                  <p class="text-text font-medium">
                    当前账号注册模式为“{{ draft.instance_registration_mode === 'open' ? '开放注册' : '仅平台管理员开户' }}”，此项设置仅在注册模式切换为“邀请注册”时才会生效。
                  </p>
                  <UCheckbox
                    v-model="draft.allow_domain_registration_invites"
                    label="邀请注册时允许域管理员签发新账号注册邀请"
                  />
                  <p class="text-text-muted pl-6">
                    预设将在未来切换为“邀请注册”时立即应用；当前模式下不会影响账号注册行为。
                  </p>
                </div>
              </template>
            </div>

            <!-- 默认工作空间 -->
            <div class="space-y-1.5 pt-1">
              <label for="default-domain-select" class="block text-sm font-medium text-text">默认工作空间</label>
              <div class="flex items-center gap-2 max-w-[400px]">
                <USelectMenu
                  id="default-domain-select"
                  v-model="draft.default_domain_slug"
                  v-model:search-term="domainSearch"
                  :items="activeDomainOptions"
                  value-key="value"
                  :ignore-filter="true"
                  :loading="domains.status.value === 'pending'"
                  :aria-busy="domains.status.value === 'pending'"
                  class="flex-1"
                  aria-label="默认工作空间"
                  aria-describedby="domain-select-status"
                />
              </div>
              <div id="domain-select-status">
                <p v-if="domains.status.value === 'pending'" role="status" aria-live="polite" class="text-xs text-text-muted flex items-center gap-1">
                  <UIcon name="i-lucide-loader-2" class="size-3.5 animate-spin" />
                  正在加载候选空间...
                </p>
                <p v-else-if="domains.error.value" role="alert" class="text-xs text-error-text flex items-center gap-1">
                  <span>候选空间加载失败</span>
                  <button
                    type="button"
                    class="underline hover:text-text cursor-pointer ml-1"
                    aria-label="重试加载候选空间"
                    @click="domains.refresh()"
                  >重试</button>
                </p>
                <p v-else-if="isSearchEmpty" role="status" class="text-xs text-text-muted">
                  未找到匹配“{{ domainSearch.trim() }}”的活跃空间
                </p>
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
