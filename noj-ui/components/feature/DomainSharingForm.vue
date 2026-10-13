<script setup lang="ts">
import type { DomainShareInput, DomainShareSettings } from '~/composables/useDomainResources';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<
  { slug: string; kind: 'problem' | 'training'; reference: string; initial: DomainShareSettings; writable: boolean }
>();
const api = useDomainResources(), capture = useWorkspaceActionScope(), { dialog } = useDialog();
const enabled = ref(props.initial.enabled), scope = ref(props.initial.scope), revision = ref(props.initial.revision);
const targets = ref(props.initial.target_domains.map((target) => target.slug)),
  entered = ref(''),
  saving = ref(false),
  failure = ref(''),
  success = ref('');
function addTarget() {
  const slug = entered.value.trim().toLowerCase();
  if (slug && !targets.value.includes(slug)) targets.value.push(slug);
  entered.value = '';
}
async function save() {
  if (!props.writable || saving.value) return;
  const current = capture(),
    input: DomainShareInput = {
      enabled: enabled.value,
      scope: scope.value,
      target_domain_slugs: scope.value === 'all' ? [] : [...targets.value],
    };
  if (
    !await dialog.confirm(
      enabled.value
        ? '保存共享范围？获授权域可以建立引用，仍分别使用自己的成绩策略与配置。'
        : '停止共享？引用域将立即停止获取内容和新提交，历史提交与成绩保留。',
      { title: '修改公开资源共享政策' },
    ) || !current.isCurrent()
  ) return;
  saving.value = true;
  failure.value = '';
  success.value = '';
  try {
    const response = await api.share(current.slug, props.kind, props.reference, input, revision.value);
    if (!current.isCurrent()) return;
    revision.value = response.data.revision;
    success.value = '共享政策已保存';
  } catch (error) {
    if (current.isCurrent()) failure.value = `${extractApiError(error).message}。当前共享配置保留。`;
  } finally {
    if (current.isCurrent()) saving.value = false;
  }
}
</script>
<template>
  <section class="space-y-3">
    <h3 class="font-semibold">公开资源跨域共享</h3>
    <p
      class="text-xs text-text-muted">仅公开域中的已发布公开资源可以开放引用。共享题单的授权不代替其中每道源题的授权。</p>
    <fieldset :disabled="!writable || saving" class="space-y-3">
      <UCheckbox v-model="enabled" label="允许其他域引用此公开资源" />
      <USelect v-model="scope" :items="[{ label: '所有域', value: 'all' }, { label: '限定目标域', value: 'selected' }]"
        aria-label="共享范围" />
      <template v-if="scope === 'selected'">
        <div class="flex gap-2">
          <UInput v-model="entered" placeholder="输入目标域网址标识，例如 school" class="grow"
            @keydown.enter.prevent="addTarget" />
          <UButton type="button" variant="outline" @click="addTarget">添加目标域</UButton>
        </div>
        <div v-for="target in targets" :key="target"
          class="flex items-center justify-between gap-3 text-sm"><span>{{ initial.target_domains.find((item) => item.slug === target)?.name ?? target }} <span class="text-text-muted">{{ target }}</span></span><UButton type="button" size="xs" color="error" variant="ghost" @click="targets = targets.filter(item => item !== target)">移除</UButton></div>
      </template>
    </fieldset>
    <UAlert v-if="failure" color="error" :title="failure" />
    <UAlert v-if="success" color="success" :title="success" />
    <UButton :loading="saving" :disabled="!writable || (enabled && scope === 'selected' && !targets.length)"
      @click="save">保存共享政策</UButton>
  </section>
</template>
