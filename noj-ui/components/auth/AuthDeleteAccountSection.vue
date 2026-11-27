<script setup lang="ts">
import { extractApiError } from '~/utils/server/apiError';

const auth = useAuth();
const router = useRouter();
const { dialog } = useDialog();

// ── 注销账户（issue #230） ──
const deletePassword = ref('');
const deletingAccount = ref(false);
const deleteAccountError = ref('');

async function handleDeleteAccount() {
  if (!deletePassword.value) {
    deleteAccountError.value = '请输入当前密码';
    return;
  }
  const confirmed = await dialog.confirm(
    '注销后将无法恢复登录；公开内容会保留并显示为“已注销用户”。确定继续吗？',
    { title: '永久注销账户', confirmText: '确认注销', danger: true, dataPolicyLink: true },
  );
  if (!confirmed) return;
  deletingAccount.value = true;
  deleteAccountError.value = '';
  try {
    await auth.deleteAccount(deletePassword.value);
    await router.replace('/login?account_deleted=1');
  } catch (error: unknown) {
    deleteAccountError.value = extractApiError(error).message;
  } finally {
    deletingAccount.value = false;
  }
}
</script>

<template>
  <section
    id="settings-delete"
    aria-label="账号注销"
    class="scroll-mt-32 overflow-hidden rounded border border-error-border bg-bg-panel"
  >
    <div class="border-b border-error-border px-6 py-5">
      <h2 class="flex items-center gap-2 text-xl font-bold text-error-text">
        <UIcon name="i-lucide-triangle-alert" class="size-5" />
        危险区域
      </h2>
    </div>
    <div class="flex flex-col gap-3 px-6 py-6">
      <p class="text-sm text-text-secondary">
        注销后无法恢复登录。帖子、评论和题解会保留，但作者统一显示为“已注销用户”。
      </p>
      <UInput
        v-model="deletePassword"
        type="password"
        autocomplete="current-password"
        placeholder="输入当前密码确认"
        class="max-w-sm"
      />
      <NuxtLink to="/data-policy" target="_blank" class="text-sm text-primary underline">
        阅读完整的数据使用、注销保留与反馈说明
      </NuxtLink>
      <p v-if="deleteAccountError" class="text-sm text-error-text">{{ deleteAccountError }}</p>
      <UButton color="error" class="self-start" :loading="deletingAccount" @click="handleDeleteAccount">
        注销账户
      </UButton>
    </div>
  </section>
</template>
