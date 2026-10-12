<script setup lang="ts">
import { useToast } from '~/composables/useToast';
import { extractApiError } from '~/utils/apiError';
import { workspaceInvitationLink, workspaceInvitationToken, workspacePath } from '~/utils/workspace';
import type { WorkspaceInvitationPreview } from '~/utils/workspace';
definePageMeta({ layout: 'auth' });
const route = useRoute();
const auth = useAuth();
const { api } = useApi();
const { toast } = useToast();
const preview = ref<WorkspaceInvitationPreview | null>(null);
const error = ref('');
const pending = ref(true);
const accepting = ref(false);
const token = ref('');
const credentials = reactive({ login: '', password: '', code: '' });
const tfaRequired = ref(false);
const signingIn = ref(false);
const registrationLink = ref('');
const session = useCookie('noj:session');
const checkingAccount = ref(false);
async function refreshAccount() {
  if (checkingAccount.value || !preview.value) return;
  checkingAccount.value = true;
  try {
    const response = await api.get<{ data: NonNullable<Awaited<ReturnType<typeof auth.fetchUser>>> }>(
      '/api/v1/auth/me',
      { silent: true, redirectOnUnauthorized: false },
    );
    auth.user.value = response.data;
  } catch (cause) {
    if (extractApiError(cause).status === 401) auth.user.value = null;
    else error.value = extractApiError(cause).message;
  } finally {
    checkingAccount.value = false;
  }
}
onMounted(() => window.addEventListener('focus', refreshAccount));
onUnmounted(() => window.removeEventListener('focus', refreshAccount));
onMounted(async () => {
  token.value = workspaceInvitationToken(route.hash) ?? '';
  if (!token.value) {
    error.value = '邀请链接不完整或无效';
    pending.value = false;
    return;
  }
  registrationLink.value = workspaceInvitationLink('', token.value, true);
  try {
    if (session.value) await auth.fetchUser();
    preview.value =
      (await api.post<{ data: WorkspaceInvitationPreview }>('/api/v1/auth/domain-invitation', { token: token.value }, {
        silent: true,
        redirectOnUnauthorized: false,
      })).data;
    credentials.login = preview.value.email;
  } catch (cause) {
    error.value = extractApiError(cause).message;
  } finally {
    pending.value = false;
  }
});
async function signIn() {
  if (signingIn.value) return;
  signingIn.value = true;
  error.value = '';
  try {
    await auth.login(credentials.login, credentials.password, credentials.code || undefined);
    credentials.password = '';
  } catch (cause) {
    const info = extractApiError(cause);
    error.value = info.message;
    tfaRequired.value = info.code === 'TFA_REQUIRED' || tfaRequired.value;
  } finally {
    signingIn.value = false;
  }
}
async function accept() {
  if (accepting.value) return;
  accepting.value = true;
  error.value = '';
  try {
    const response = await api.post<{ data: { domain_slug: string } }>('/api/v1/domain-invitations/accept', {
      token: token.value,
    }, { silent: true });
    toast.success('已加入空间');
    await navigateTo(workspacePath(response.data.domain_slug), { replace: true });
  } catch (cause) {
    error.value = extractApiError(cause).message;
  } finally {
    accepting.value = false;
  }
}
useSeoMeta({ title: '接受空间邀请' });
</script>

<template>
  <UCard class="w-full max-w-lg rounded">
    <h1 class="text-xl font-bold text-text">接受空间邀请</h1>
    <p v-if="pending" class="mt-4 text-sm text-text-muted">正在检查邀请…</p>
    <UAlert v-if="error" class="mt-4" color="error" :title="error" />
    <template v-if="preview">
      <p class="mt-4 text-text-secondary">邀请你加入 <strong class="text-text">{{ preview.domain_name }}</strong>。</p>
      <p class="mt-2 text-sm text-text-muted">受邀邮箱：{{ preview.email }}</p>
      <p class="mt-1 text-xs text-text-muted">{{ new Date(preview.expires_at).toLocaleString() }} 到期</p>
      <template v-if="auth.isLoggedIn.value">
        <p
          class="mt-4 text-sm text-text-secondary">当前账号：{{ auth.user.value?.username }} · {{ auth.user.value?.email }}</p>
        <p v-if="auth.user.value?.must_change_password"
          class="mt-3 text-sm text-text-secondary">此账号需要先更新初始密码。<NuxtLink to="/change-password" target="_blank" class="text-primary">设置密码</NuxtLink>后回到此页继续。</p>
        <UButton class="mt-4" :loading="accepting" :disabled="auth.user.value?.must_change_password"
          @click="accept">接受邀请</UButton>
      </template>
      <form v-else class="mt-5 space-y-3" @submit.prevent="signIn">
        <AdminFormField label="已有账号登录">
          <UInput v-model="credentials.login" class="w-full" autocomplete="username" aria-label="账号或邮箱" required />
        </AdminFormField>
        <UInput v-model="credentials.password" class="w-full" type="password" autocomplete="current-password"
          aria-label="登录密码" required />
        <UInput v-if="tfaRequired" v-model="credentials.code" class="w-full" autocomplete="one-time-code"
          placeholder="两步验证码或恢复码" aria-label="两步验证码" />
        <UButton type="submit" :loading="signingIn">登录后接受</UButton>
        <UButton v-if="preview.can_register" :to="registrationLink" color="neutral" variant="outline"
          class="ml-2">没有账号，注册加入</UButton>
        <p v-else class="text-sm text-text-muted">此实例限制新账号注册，请使用已有账号或联系平台管理员。</p>
        <UButton color="neutral" variant="link" :loading="checkingAccount"
          @click="refreshAccount">已在其他页面登录，重新检查</UButton>
        <UButton to="/login" target="_blank" color="neutral" variant="link">使用其他登录方式</UButton>
      </form>
    </template>
  </UCard>
</template>
