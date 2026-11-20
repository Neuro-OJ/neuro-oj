<script setup lang="ts">
import { teachingLocalTime, teachingUtcTime } from '~/utils/education';
import type { AssignmentDetail } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; task: AssignmentDetail; writable: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const education = useEducationApi(), capture = useWorkspaceActionScope(), { dialog } = useDialog();
const open = ref(false), action = ref<'schedule' | 'extend' | 'end' | 'archive'>('schedule');
const originalRevision = ref(0), date = ref(''), reason = ref(''), saving = ref(false), error = ref('');
function choose(value: typeof action.value) {
  action.value = value;
  originalRevision.value = props.task.revision;
  reason.value = '';
  error.value = '';
  date.value = value === 'extend' ? teachingLocalTime(props.task.deadline_at) : '';
  open.value = true;
}
async function publish() {
  if (saving.value || !props.writable) return;
  const scope = capture(), id = props.task.id, revision = props.task.revision;
  if (!await dialog.confirm('发布后题目集合和达标要求固定。版本与有效成绩仍跟随本域题库，是否发布？')) return;
  if (!scope.isCurrent() || props.task.id !== id || !props.writable) return;
  saving.value = true;
  error.value = '';
  try {
    await education.publish(scope.slug, id, revision, `publish:${id}:${revision}`);
    if (scope.isCurrent() && props.task.id === id) emit('changed');
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}
async function change() {
  if (saving.value || !props.writable) return;
  const scope = capture(), id = props.task.id;
  saving.value = true;
  error.value = '';
  try {
    if (action.value === 'schedule') {
      const time = teachingUtcTime(date.value);
      if (!time) throw new Error('请填写未来的发布时间');
      await education.schedule(scope.slug, id, originalRevision.value, time);
    } else {
      await education.lifecycle(scope.slug, id, originalRevision.value, action.value, {
        reason: reason.value,
        ...(action.value === 'extend' ? { deadline_at: teachingUtcTime(date.value) } : {}),
      });
    }
    if (scope.isCurrent() && props.task.id === id) {
      open.value = false;
      emit('changed');
    }
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    saving.value = false;
  }
}
watch([() => props.slug, () => props.task.id], () => {
  open.value = false;
  error.value = '';
});
</script>
<template>
  <div v-if="writable" class="space-y-3">
    <UAlert v-if="error && !open" color="error" :title="error" />
    <div class="flex flex-wrap gap-2">
      <template v-if="task.state === 'draft'">
        <UButton :to="workspacePath(slug, `assignments/${task.id}/edit`)" variant="outline">编辑草稿</UButton>
        <UButton :loading="saving" @click="publish">发布作业</UButton>
        <UButton variant="outline" @click="choose('schedule')">定时发布</UButton>
      </template>
      <template v-if="task.state === 'published' && !task.ended_at">
        <UButton v-if="task.deadline_at" variant="outline" @click="choose('extend')">延长截止</UButton>
        <UButton color="warning" variant="outline" @click="choose('end')">提前结束</UButton>
      </template>
      <UButton v-if="task.state !== 'archived'" color="neutral" variant="outline"
        @click="choose('archive')">归档作业</UButton>
    </div>
    <UModal v-model:open="open"
      :title="({ schedule: '定时发布', extend: '延长截止', end: '提前结束', archive: '归档作业' })[action]">
      <template #body>
        <form class="space-y-4" @submit.prevent="change">
          <UAlert v-if="error" color="error" :title="error" />
          <AdminFormField v-if="action === 'schedule' || action === 'extend'"
            :label="action === 'schedule' ? '发布时间（当地时间）' : '新的截止时间（当地时间）'">
            <UInput v-model="date" type="datetime-local" :required="action === 'schedule'" aria-label="作业变更时间" />
          </AdminFormField>
          <p v-if="action === 'extend'"
            class="text-xs text-text-muted">留空可以取消截止限制；已有按时成绩会按新的窗口重算。</p>
          <AdminFormField v-if="action !== 'schedule'" label="变更理由" required>
            <UTextarea v-model="reason" class="w-full" :maxlength="2000" required aria-label="作业变更理由" />
          </AdminFormField>
          <p v-if="action === 'schedule'"
            class="text-sm text-text-muted">到时再次检查资源与权限；失败时保留原因并回到草稿，不会部分发布。</p>
          <UButton type="submit"
            :loading="saving">确认{{ ({ schedule: '预约', extend: '延长', end: '结束', archive: '归档' })[action] }}</UButton>
        </form>
      </template>
    </UModal>
  </div>
</template>
