<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { credentialsCsv, parseAccountCsv } from '~/utils/adminAccountsCsv';

const props = defineProps<{ resetUser: { id: string; username: string } | null }>();
const emit = defineEmits<{ changed: []; 'reset-closed': [] }>();
const { api } = useApi();
const mode = ref<'create' | 'import' | 'reset'>('create');
const open = ref(false);
const busy = ref(false);
const error = ref('');
const rowErrors = ref<{ row: number; reason: string }[]>([]);
const form = reactive({ username: '', email: '', password: '', role: '__default__' });
const csv = ref('username,email,password\n');
const roles = ref<{ id: string; name: string }[]>([]);
const roleError = ref('');
const errorSummary = ref<HTMLElement | null>(null);
interface Credential {
  id: string;
  username: string;
  email: string;
  password: string;
}
// 凭据只存在当前组件内存；关闭结果弹窗即清空，不进入全局状态或浏览器存储。
const credentials = ref<Credential[]>([]);
const resultOpen = ref(false);
const title = computed(() =>
  mode.value === 'create'
    ? '新建用户'
    : mode.value === 'import'
    ? '批量导入账号'
    : `重置密码：${props.resetUser?.username ?? ''}`
);

async function start(nextMode: 'create' | 'import' | 'reset') {
  mode.value = nextMode;
  error.value = '';
  rowErrors.value = [];
  roleError.value = '';
  Object.assign(form, { username: '', email: '', password: '', role: '__default__' });
  csv.value = 'username,email,password\n';
  open.value = true;
  if (nextMode !== 'reset') {
    try {
      const response = await api.get<{ data: { id: string; name: string }[] }>('/api/v1/admin/identity/roles', {
        silent: true,
      });
      roles.value = response.data.filter((role) => role.name !== 'root');
    } catch {
      roleError.value = '角色加载失败；仍可使用默认普通用户角色。';
    }
  }
}

watch(() => props.resetUser, (value) => {
  if (value) void start('reset');
});
function closeForm() {
  if (busy.value) return;
  open.value = false;
  form.password = '';
  csv.value = '';
  emit('reset-closed');
}
function closeResult(value: boolean) {
  if (!value) {
    resultOpen.value = false;
    credentials.value = [];
  }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    csv.value = await file.text();
  } catch {
    error.value = '无法读取 CSV 文件，请重试或直接粘贴。';
  }
  input.value = '';
}
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  rowErrors.value = [];
  try {
    let result: Credential[];
    // 500 次 bcrypt 哈希可能耗时较长；关闭自动重试，防止重复创建或重置。
    const options = { silent: true, retry: 0, timeout: 600_000 };
    if (mode.value === 'import') {
      const response = await api.post<{ data: Credential[] }>('/api/v1/admin/identity/users/import', {
        users: parseAccountCsv(csv.value),
        role: form.role === '__default__' ? undefined : form.role,
      }, options);
      result = response.data;
    } else {
      const path = mode.value === 'reset'
        ? `/api/v1/admin/identity/users/${props.resetUser!.id}/reset-password`
        : '/api/v1/admin/identity/users';
      const body = mode.value === 'reset' ? { password: form.password || undefined } : {
        username: form.username,
        email: form.email || undefined,
        password: form.password || undefined,
        role: form.role === '__default__' ? undefined : form.role,
      };
      const response = await api.post<{ data: Credential }>(path, body, options);
      result = [response.data];
    }
    credentials.value = result;
    resultOpen.value = true;
    busy.value = false;
    closeForm();
    emit('changed');
  } catch (err) {
    error.value = err instanceof Error && !('data' in err) ? err.message : extractApiError(err).message;
    const data = (err as { data?: { errors?: { row: number; reason: string }[] } })?.data;
    rowErrors.value = data?.errors ?? [];
    await nextTick();
    errorSummary.value?.focus();
  } finally {
    busy.value = false;
  }
}
function download() {
  const url = URL.createObjectURL(new Blob([credentialsCsv(credentials.value)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `noj-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <UButton icon="i-lucide-user-plus" @click="start('create')">新建用户</UButton>
    <UButton icon="i-lucide-upload" variant="outline" @click="start('import')">批量导入</UButton>
  </div>
  <UModal :open="open" :title="title" :dismissible="!busy" :close="!busy" :ui="{ content: 'sm:max-w-2xl rounded-md' }"
    @update:open="(value) => { if (!value) closeForm() }">
    <template #body>
      <UForm :state="form" class="space-y-4" @submit="submit">
        <div v-if="error" ref="errorSummary" role="alert" tabindex="-1" class="text-sm text-error-text space-y-1">
          <p>{{ error }}</p>
          <ul v-if="rowErrors.length" class="list-disc pl-5 max-h-48 overflow-y-auto">
            <li v-for="(item, index) in rowErrors" :key="index">第 {{ item.row }} 行：{{ item.reason }}</li>
          </ul>
        </div>
        <p
          class="text-sm text-text-secondary">{{ mode === 'reset' ? '重置后全部旧会话立即失效，用户下次登录必须修改密码。' : '无需邮件服务。新账号首次登录必须修改密码；留空邮箱时自动使用不可收信的占位邮箱。' }}</p>
        <template v-if="mode === 'create'">
          <UFormField label="用户名" name="username" required help="3-30 位字母、数字或下划线">
            <UInput v-model="form.username" required pattern="[a-zA-Z0-9_]{3,30}" class="w-full" :disabled="busy"
              autocomplete="off" />
          </UFormField>
          <UFormField label="邮箱（可选）" name="email">
            <UInput v-model="form.email" type="email" class="w-full" :disabled="busy" autocomplete="off" />
          </UFormField>
        </template>
        <template v-if="mode === 'import'">
          <UFormField label="上传 CSV 文件" name="file">
            <UInput type="file" accept=".csv,text/csv" :disabled="busy" @change="upload" />
          </UFormField>
          <UFormField label="粘贴或编辑 CSV" name="csv"
            help="首行为 username,email,password，邮箱和密码可空；每次最多 500 行。错误行号从表头后第 1 行开始；任一行有错则整批不创建。">
            <UTextarea v-model="csv" :rows="8" class="w-full font-mono" :disabled="busy" />
          </UFormField>
        </template>
        <UFormField v-else label="初始密码（可选）" name="password"
          help="留空自动生成；自设密码至少 8 位，包含大小写字母和数字，且不能与用户名或邮箱前缀相同。">
          <UInput v-model="form.password" type="password" autocomplete="new-password" class="w-full" :disabled="busy" />
        </UFormField>
        <UFormField v-if="mode !== 'reset'" label="角色" name="role"
          :help="roleError || '默认与公开注册一致，使用普通用户角色。'">
          <USelect v-model="form.role"
            :items="[{ label: '默认普通用户（user）', value: '__default__' }, ...roles.map(role => ({ label: role.name, value: role.id }))]"
            class="w-full" :disabled="busy" />
        </UFormField>
        <p v-if="busy && mode === 'import'" role="status"
          class="text-sm text-text-secondary">正在校验并创建账号，请等待完成，大批量导入可能需要数分钟。</p>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" :disabled="busy" @click="closeForm">取消</UButton>
          <UButton type="submit"
            :loading="busy">{{ mode === 'reset' ? '确认重置密码' : mode === 'import' ? '校验并导入' : '创建用户' }}</UButton>
        </div>
      </UForm>
    </template>
  </UModal>
  <UModal :open="resultOpen" title="请保存本次初始密码" :ui="{ content: 'sm:max-w-2xl rounded-md' }"
    @update:open="closeResult">
    <template #body>
      <div class="space-y-4">
        <p
          class="text-sm text-warning-text font-medium">密码仅展示这一次，关闭后无法再次查看。请立即下载 CSV 并妥善交付；遗失时只能重新重置密码。</p>
        <div class="overflow-x-auto max-h-80 border border-border rounded">
          <table class="w-full text-sm text-left">
            <thead class="bg-bg-sunken">
              <tr>
                <th class="p-2">用户名</th>
                <th class="p-2">邮箱</th>
                <th class="p-2">初始密码</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in credentials" :key="item.id" class="border-t border-border">
                <td class="p-2">{{ item.username }}</td>
                <td class="p-2">{{ item.email }}</td>
                <td class="p-2 font-mono select-all">{{ item.password }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="flex justify-end gap-2">
          <UButton icon="i-lucide-download" @click="download">下载 CSV</UButton>
          <UButton color="neutral" variant="outline" @click="closeResult(false)">已保存，关闭</UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
