<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { useToast } from '~/composables/useToast';
import InstanceNav from '~/components/admin/InstanceNav.vue';

definePageMeta({ layout: 'admin', middleware: 'admin', ssr: false });

const api = useInstanceAdmin();
const { user } = useAuth();
const { toast } = useToast();
const { dialog } = useDialog();

const key = computed(() => `instance-settings-modules:${user.value?.id}`);
const { data, status, error, refresh } = await useAsyncData(key, () => api.getSection('modules'));

const draft = reactive({
  community: true,
  classroom: true,
  assignment: true,
  analytics: true,
});

const revision = ref('');
const savedSnapshot = ref('');
const saveError = ref('');
const saving = ref(false);

const modulesList = [
  { key: 'community' as const, label: '社区模块', desc: '域内讨论区、帖子、评论与动态交流。' },
  { key: 'classroom' as const, label: '班级模块', desc: '教学班级、助教分配与学员名单管理。' },
  { key: 'assignment' as const, label: '作业模块', desc: '班级作业布置、提交与评阅（依赖班级模块，关闭班级时自动关闭）。' },
  { key: 'analytics' as const, label: '学情与排行榜', desc: '域内做题统计分析、学员学情与域内排行榜。' },
];

function onClassroomChange(val: boolean) {
  draft.classroom = val;
  if (!val) {
    draft.assignment = false;
  }
}

function initDraft() {
  const section = data.value?.data;
  if (!section) return;
  const vals = section.values;
  const raw = vals.instance_allowed_modules;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (parsed && typeof parsed === 'object') {
    draft.community = !!parsed.community;
    draft.classroom = !!parsed.classroom;
    draft.assignment = !!parsed.assignment;
    draft.analytics = !!parsed.analytics;
  }
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
      instance_allowed_modules: JSON.stringify(draft),
    };
    const res = await api.updateSection('modules', payload, revision.value);
    revision.value = res.data.revision;
    savedSnapshot.value = JSON.stringify(draft);
    toast.success('可选模块许可已保存');
    await refresh();
  } catch (err: unknown) {
    const apiErr = extractApiError(err);
    saveError.value = apiErr.message;
    toast.error(apiErr.message);
  } finally {
    saving.value = false;
  }
}

useSeoMeta({ title: '模块许可 - 实例设置' });
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
            <div>
              <h2 class="text-base font-semibold text-text">实例允许的可选模块</h2>
              <p class="text-xs text-text-secondary mt-1">
                各工作空间只能在其预设和配置中启用这里许可的模块。若关闭某模块，各空间前台对应功能入口将被隐藏，但已有历史数据完整保留。
              </p>
            </div>

            <div class="space-y-4 divide-y divide-border/60">
              <div v-for="mod in modulesList" :key="mod.key" class="pt-3 first:pt-0">
                <div class="flex items-start gap-3">
                  <UCheckbox
                    v-if="mod.key === 'classroom'"
                    :model-value="draft.classroom"
                    :label="mod.label"
                    class="font-medium"
                    @update:model-value="(val) => onClassroomChange(val === true)"
                  />
                  <UCheckbox
                    v-else-if="mod.key === 'assignment'"
                    v-model="draft.assignment"
                    :label="mod.label"
                    :disabled="!draft.classroom"
                    class="font-medium"
                  />
                  <UCheckbox
                    v-else
                    v-model="draft[mod.key]"
                    :label="mod.label"
                    class="font-medium"
                  />
                </div>
                <p class="text-xs text-text-muted mt-1 pl-6 leading-relaxed">{{ mod.desc }}</p>
              </div>
            </div>

            <UAlert v-if="saveError" color="error" :title="saveError" description="未保存的修改仍保留在表单中，请核对后重试。" />

            <div class="pt-2">
              <UButton type="submit" color="primary" :loading="saving">保存模块许可</UButton>
            </div>
          </form>
        </UCard>
      </AsyncContent>
    </div>
  </div>
</template>
