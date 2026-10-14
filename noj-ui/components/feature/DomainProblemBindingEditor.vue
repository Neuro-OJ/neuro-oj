<script setup lang="ts">
import type { DomainProblemBinding } from '~/composables/useDomainResources';
import { extractApiError } from '~/utils/apiError';
import { workspaceCacheKey } from '~/utils/workspace';
const props = defineProps<{ slug: string; initial: DomainProblemBinding; writable: boolean; canPolicy: boolean }>();
const emit = defineEmits<{ saved: [] }>();
const api = useDomainResources(),
  problems = useDomainProblems(),
  capture = useWorkspaceActionScope(),
  { user } = useAuth(),
  { dialog } = useDialog();
const reference = props.initial.reference.display_ref;
const revision = ref(props.initial.revision);
const versionPage = ref(1);
const mode = shallowRef(props.initial.effective_version_mode),
  required = shallowRef(props.initial.required_version_id ?? props.initial.answer_version_id ?? '');
const disabled = shallowRef(!!props.initial.disabled_at),
  visibility = shallowRef(props.initial.visibility),
  reason = shallowRef(''),
  busy = shallowRef(''),
  failure = shallowRef('');
const versions = await useAsyncData(
  () =>
    workspaceCacheKey(
      props.slug,
      user.value?.id ?? null,
      'binding-versions',
      props.initial.binding_id,
      String(versionPage.value),
    ),
  () =>
    props.initial.resource_available
      ? problems.versions(props.slug, reference, versionPage.value)
      : Promise.resolve(null),
);
const versionItems = computed(() =>
  versions.data.value?.items.map((version) => ({
    label: `V${version.version}${version.change_note ? ` · ${version.change_note}` : ''}`,
    value: version.version_id,
  })) ?? []
);
async function save(operation: 'policy' | 'state') {
  if (!props.writable || busy.value || !reason.value.trim()) return;
  const current = capture();
  if (
    !await dialog.confirm(
      operation === 'policy'
        ? '修改使用域有效版本策略？已有作业和有效成绩将按新口径重算，并保留变化依据。'
        : '保存本域展示范围和上下架状态？停用会拒绝新的内容访问及提交。',
      { title: '修改题库配置' },
    ) || !current.isCurrent()
  ) return;
  busy.value = operation;
  failure.value = '';
  try {
    const response = operation === 'policy'
      ? await api.policy(current.slug, reference, revision.value, {
        mode: mode.value,
        ...(mode.value === 'exact' ? { version_id: required.value } : {}),
      }, reason.value.trim())
      : await api.state(current.slug, reference, revision.value, {
        disabled: disabled.value,
        visibility: visibility.value,
        reason: reason.value.trim(),
      });
    if (!current.isCurrent()) return;
    revision.value = response.data.revision;
    emit('saved');
  } catch (error) {
    if (current.isCurrent()) failure.value = `${extractApiError(error).message}。当前配置与原 revision 保留。`;
  } finally {
    if (current.isCurrent()) busy.value = '';
  }
}
</script>
<template>
  <div class="space-y-4">
    <UAlert v-if="failure" color="error" :title="failure" />
    <AdminFormField label="变更理由" required>
      <UTextarea v-model="reason" :disabled="!writable || !!busy" placeholder="说明策略、展示范围或上下架调整原因" />
    </AdminFormField>
    <section v-if="canPolicy" class="space-y-3">
      <h3 class="font-semibold">本域有效成绩策略</h3>
      <USelect v-model="mode" :disabled="!writable || !!busy || !initial.resource_available"
        :items="[{ label: '任一已发布版本有效（any）', value: 'any' }, { label: '指定版本有效（exact）', value: 'exact' }]" />
      <USelect v-if="mode === 'exact'" v-model="required" :items="versionItems" :disabled="!writable || !!busy"
        placeholder="选择本题已发布版本" />
      <UAlert v-if="versions.error.value" color="error" :title="extractApiError(versions.error.value).message" />
      <PaginationNav v-if="mode === 'exact' && versions.data.value" :current-page="versionPage"
        :total-pages="Math.ceil(versions.data.value.total / 20)" @page-change="versionPage = $event" />
      <p
        class="text-xs text-text-muted">共享题策略只影响当前使用域；any 跟随源题最新默认作答版本，exact 使用所选版本。</p>
      <UButton :loading="busy === 'policy'"
        :disabled="!writable || !!busy || !initial.resource_available || !reason.trim() || (mode === 'exact' && !required)"
        @click="save('policy')">保存有效策略</UButton>
    </section>
    <section v-if="initial.can_change_state"
      class="space-y-3 border-t border-border pt-4">
      <h3 class="font-semibold">展示与上下架</h3>
      <USelect v-model="visibility" :disabled="!writable || !!busy"
        :items="[{ label: '仅域成员', value: 'members' }, { label: '公开展示', value: 'public' }]" />
      <UCheckbox v-model="disabled" :disabled="!writable || !!busy" label="暂停此题在本域的内容访问和新提交" />
      <p class="text-xs text-text-muted">下架保留题目、版本和历史提交。恢复共享引用时重新检查源域当前授权。</p>
      <UButton :loading="busy === 'state'" :disabled="!writable || !!busy || !reason.trim()"
        @click="save('state')">保存展示与上下架</UButton>
    </section>
  </div>
</template>
