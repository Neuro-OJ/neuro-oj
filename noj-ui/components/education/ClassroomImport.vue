<script setup lang="ts">
import { CLASSROOM_IMPORT_LABELS, classroomImportResultCsv } from '~/utils/education-enrollment';
import type { ClassroomImportPreview, ClassroomImportResult } from '~/utils/education-enrollment';
import { workspaceInvitationLink } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; classroomId: string; writable: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const education = useEducationApi(), capture = useWorkspaceActionScope();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const csv = ref(''), replace = ref(false), busy = ref(false), error = ref('');
const preview = ref<ClassroomImportPreview | null>(null),
  result = ref<ClassroomImportResult | null>(null),
  key = ref(crypto.randomUUID());
watch([csv, replace], () => {
  preview.value = null;
  result.value = null;
  key.value = crypto.randomUUID();
});
watch([() => props.slug, () => props.classroomId, () => actor.value?.id], () => {
  csv.value = '';
  error.value = '';
  preview.value = null;
  result.value = null;
});
async function readFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const scope = capture(), id = props.classroomId;
  error.value = '';
  try {
    if (file.size > 512 * 1024) throw new Error('CSV 不能超过 512 KiB');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    if (scope.isCurrent() && props.classroomId === id) csv.value = text;
  } catch (e) {
    error.value = extractApiError(e).message;
  }
}
async function run(execute: boolean) {
  if (busy.value || !props.writable) return;
  const scope = capture(), id = props.classroomId, input = csv.value, mode = replace.value;
  busy.value = true;
  error.value = '';
  try {
    if (execute && preview.value) {
      const response = await education.executeImport(
        scope.slug,
        id,
        { csv: input, replace_pending: mode, preview_hash: preview.value.preview_hash },
        preview.value.revision,
        key.value,
      );
      if (!scope.isCurrent() || props.classroomId !== id || csv.value !== input || replace.value !== mode) return;
      result.value = response.data;
      emit('changed');
    } else {
      const response = await education.previewImport(scope.slug, id, input, mode);
      if (scope.isCurrent() && props.classroomId === id && csv.value === input && replace.value === mode) {
        preview.value = response.data;
      }
    }
  } catch (e) {
    error.value = extractApiError(e).message;
  } finally {
    busy.value = false;
  }
}
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
function exportResult() {
  if (result.value) {
    download(
      classroomImportResultCsv(result.value.rows, (token) => workspaceInvitationLink(window.location.origin, token)),
      'classroom-import-result.csv',
    );
  }
}
</script>
<template>
  <UCard v-if="writable">
    <h2 class="mb-3 font-semibold">批量入班与邀请</h2>
    <p
      class="mb-3 text-sm text-text-muted">每批最多 500 条。CSV 使用 email 或 username 表头；本域已有账号可加入班级，其余通过邮箱邀请。不会创建平台账号。</p>
    <div class="mb-3 flex flex-wrap gap-3">
      <UInput type="file" accept=".csv,text/csv" :disabled="busy" aria-label="学生 CSV 文件" @change="readFile" />
      <UButton variant="ghost"
        @click="download('\uFEFFemail,username\r\n', 'classroom-import-template.csv')">下载空模板</UButton>
    </div>
    <UTextarea v-model="csv" class="w-full" :rows="5" :disabled="busy" placeholder="email,username"
      aria-label="学生导入 CSV" />
    <UCheckbox v-model="replace" class="mt-3" :disabled="busy" label="重签已有有效邀请（旧链接将失效）" />
    <UAlert v-if="error" class="mt-3" color="error" :title="error" />
    <UButton class="mt-3" variant="outline" :loading="busy" :disabled="!csv.trim()"
      @click="run(false)">预览导入</UButton>
    <template v-if="preview">
      <p
        class="mt-4 text-sm tabular-nums">共 {{ preview.summary.total }} 条：加入 {{ preview.summary.join }}，邀请 {{ preview.summary.invite }}，跳过 {{ preview.summary.skipped }}，错误 {{ preview.summary.errors }}。</p>
      <div class="mt-3 max-h-80 overflow-auto rounded border border-border">
        <table class="w-full text-left text-sm" aria-label="导入逐行预览">
          <thead>
            <tr>
              <th class="p-2">行</th>
              <th class="p-2">邮箱／用户名</th>
              <th class="p-2">处理</th>
              <th class="p-2">说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in preview.rows" :key="row.row" class="border-t border-border">
              <td class="p-2 tabular-nums">{{ row.row }}</td>
              <td class="p-2">{{ row.email || row.username }}</td>
              <td class="p-2">{{ CLASSROOM_IMPORT_LABELS[row.action] }}</td>
              <td class="p-2">{{ row.error }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="mt-3 text-xs text-text-muted">错误行不会执行。账号、成员或邀请状态变化时需要重新预览。</p>
      <UButton v-if="!result" class="mt-3" :loading="busy"
        :disabled="preview.summary.join + preview.summary.invite === 0" @click="run(true)">执行已预览的有效行</UButton>
    </template>
    <template v-if="result">
      <UAlert class="mt-4" :color="result.replayed ? 'warning' : 'success'"
        :title="result.replayed ? '操作之前已执行，本次返回原记录' : '有效行已执行完成'"
        :description="result.replayed ? '邀请令牌只在首次响应提供。需要新链接时勾选重签，再重新预览执行。' : '请保存结果 CSV。邀请链接只在本次响应提供，不会保存在编辑草稿中。'" />
      <UButton class="mt-3" variant="outline" @click="exportResult">下载执行结果与首次邀请链接</UButton>
    </template>
  </UCard>
</template>
