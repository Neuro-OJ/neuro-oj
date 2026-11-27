<script setup lang="ts">
// 显式导入项目 useToast：避免与 @nuxt/ui 自动导入的同名 useToast 混淆
import { useToast } from '~/composables/useToast';
import { getAvatarUploadError } from '~/utils/auth/avatarUpload';
import { extractApiError } from '~/utils/server/apiError';

const { user, isLoggedIn } = useAuth();
const { api } = useApi();
const { dialog } = useDialog();
const { toast } = useToast();

// Bio 编辑
const bio = ref('');
const saving = ref(false);
const saveSuccess = ref(false);
const saveError = ref('');

// 头像管理（issue #229）
const avatarUploading = ref(false);
const avatarInput = ref<HTMLInputElement | null>(null);
const avatarPreviewKey = ref(Date.now()); // 上传/删除后破缓存
const avatarError = ref(''); // issue #314：超过 2MB 等校验错误内联展示，避免“没有反应”

// 上传头像（前端预校验类型/大小，与后端阈值一致）
async function handleAvatarUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  avatarError.value = '';
  const validationError = getAvatarUploadError(file);
  if (validationError) {
    avatarError.value = validationError;
    toast.error(validationError);
    input.value = '';
    return;
  }
  avatarUploading.value = true;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post<{ data: { avatar_url: string } }>(
      '/api/v1/users/me/avatar',
      fd,
      { silent: true },
    );
    if (user.value) user.value.avatar_url = res.data.avatar_url;
    avatarPreviewKey.value = Date.now();
    avatarError.value = '';
    toast.success('头像已更新');
  } catch (err: unknown) {
    const message = extractApiError(err).message;
    avatarError.value = message;
    toast.error(message);
  } finally {
    avatarUploading.value = false;
    input.value = '';
  }
}

// 删除头像（弹确认框）
async function handleAvatarDelete() {
  const ok = await dialog.confirm('确定删除头像吗？将恢复为默认头像。');
  if (!ok) return;
  await api.delete('/api/v1/users/me/avatar');
  if (user.value) user.value.avatar_url = null;
  avatarPreviewKey.value = Date.now();
  toast.success('头像已删除');
}

// 加载当前用户 bio（等 user 就绪后再请求，避免 fetchUser 未完成）
watch(
  user,
  async (u) => {
    if (!u?.id) return;
    try {
      const res = await api.get<{ data: { user: { bio: string } } }>(
        `/api/v1/users/${u.username}/profile`,
        { silent: true },
      );
      bio.value = res.data.user.bio || '';
    } catch {
      // 静默失败
    }
  },
  { immediate: true },
);

async function handleSave() {
  if (!isLoggedIn.value) return;
  saving.value = true;
  saveSuccess.value = false;
  saveError.value = '';
  try {
    await api.put('/api/v1/users/me', { bio: bio.value });
    saveSuccess.value = true;
    setTimeout(() => {
      saveSuccess.value = false;
    }, 3000);
  } catch (err: unknown) {
    saveError.value = extractApiError(err).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section
    id="settings-profile"
    aria-labelledby="profile-title"
    class="scroll-mt-32 overflow-hidden rounded border border-border bg-bg-panel"
  >
    <div class="px-6 py-5 border-b border-border">
      <h2 id="profile-title" class="text-lg font-semibold flex items-center gap-2">
        <UIcon name="i-lucide-edit-3" class="size-5" />
        个人资料编辑
      </h2>
    </div>

    <div class="px-6 py-6 flex flex-col gap-6">
      <!-- 头像管理（issue #229） -->
      <div class="flex items-center gap-6 pb-4 border-b border-border">
        <span
          class="relative inline-block rounded-full overflow-hidden shrink-0"
          :style="{ width: '64px', height: '64px' }"
        >
          <img
            v-if="user?.avatar_url"
            :src="`/api/v1/users/${user.username}/avatar?t=${avatarPreviewKey}`"
            alt="当前头像"
            class="size-full object-cover"
          />
          <span
            v-else
            class="size-full flex items-center justify-center text-xl font-bold bg-bg-sunken text-text-secondary"
          >{{ user?.username?.charAt(0).toUpperCase() || '?' }}</span>
        </span>
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-3">
            <UButton color="primary" variant="outline" :loading="avatarUploading" @click="avatarInput?.click()">
              <UIcon name="i-lucide-upload" class="size-4" />
              上传头像
            </UButton>
            <UButton v-if="user?.avatar_url" color="error" variant="outline" @click="handleAvatarDelete">
              <UIcon name="i-lucide-trash-2" class="size-4" />
              删除头像
            </UButton>
            <input
              ref="avatarInput"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              class="hidden"
              @change="handleAvatarUpload"
            />
          </div>
          <p class="text-xs text-text-muted">支持 png / jpeg / webp，最大 2MB</p>
          <p v-if="avatarError" class="text-xs text-error-text">{{ avatarError }}</p>
        </div>
      </div>

      <!-- 基本信息（只读） -->
      <div class="flex items-center gap-3 pb-4 border-b border-border">
        <div
          class="w-12 h-12 rounded-full bg-primary-bg flex items-center justify-center text-primary text-xl font-bold shrink-0"
        >
          {{ user?.username?.charAt(0).toUpperCase() || '?' }}
        </div>
        <div class="flex flex-col">
          <span class="font-semibold text-text">{{ user?.username }}</span>
          <span class="text-xs text-text-muted">{{ user?.email }}</span>
        </div>
      </div>

      <!-- Bio 编辑区 -->
      <div class="flex flex-col gap-3">
        <label class="text-sm font-semibold text-text">个人简介</label>
        <MarkdownEditor
          v-model="bio"
          default-mode="edit"
          height="220px"
          :maxlength="5000"
          aria-label="个人简介"
          placeholder="用 Markdown 介绍自己..."
        />
      </div>

      <!-- 保存按钮与反馈 -->
      <div class="flex flex-wrap items-center gap-3">
        <UButton
          color="primary"
          class="flex items-center justify-center gap-2 py-2.5 px-6 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="saving"
          @click="handleSave"
        >
          <UIcon name="i-lucide-save" class="size-4" />
          <span>{{ saving ? '保存中...' : '保存' }}</span>
        </UButton>
        <span v-if="saveSuccess" class="text-sm text-success-text">已保存</span>
        <span v-if="saveError" class="text-sm text-error-text">{{ saveError }}</span>
      </div>
    </div>
  </section>
</template>
