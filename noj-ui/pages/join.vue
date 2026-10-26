<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { useToast } from '~/composables/useToast';
import { useApi } from '~/composables/useApi';
import { authCookieNames } from '~/utils/auth-cookies';
import { extractApiError } from '~/utils/apiError';
import {
  formatInvitationCode,
  isInvitationCredential,
  normalizeInvitationCredential,
  workspaceInvitationLink,
  workspaceInvitationToken,
  workspacePath,
} from '~/utils/workspace';
import type { WorkspaceInvitationPreview } from '~/utils/workspace';

definePageMeta({ layout: 'auth' });

const route = useRoute();
const auth = useAuth();
const { api } = useApi();
const { toast } = useToast();

const preview = ref<WorkspaceInvitationPreview | null>(null);
const error = ref('');
const pending = ref(false);
const accepting = ref(false);
const token = ref('');
const inputCredential = ref('');
const credentials = reactive({ login: '', password: '', code: '' });
const tfaRequired = ref(false);
const signingIn = ref(false);
const registrationLink = ref('');
const session = useCookie(authCookieNames(useRuntimeConfig().public.authCookiePrefix).session);
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

async function loadPreview(credential: string) {
  if (!isInvitationCredential(credential)) {
    error.value = '邀请码或令牌格式无效';
    return;
  }
  const normalized = normalizeInvitationCredential(credential);
  token.value = normalized;
  registrationLink.value = workspaceInvitationLink('', normalized, true);
  pending.value = true;
  error.value = '';

  try {
    if (session.value) await auth.fetchUser();
    const res = await api.post<{ data: WorkspaceInvitationPreview }>(
      '/api/v1/auth/domain-invitation',
      { token: normalized },
      { silent: true, redirectOnUnauthorized: false },
    );
    preview.value = res.data;
    if (res.data.email) {
      credentials.login = res.data.email;
    }
  } catch (cause) {
    preview.value = null;
    error.value = extractApiError(cause).message;
  } finally {
    pending.value = false;
  }
}

function lookupCode() {
  const raw = inputCredential.value.trim();
  if (!raw) {
    error.value = '请输入邀请码或令牌';
    return;
  }
  if (!isInvitationCredential(raw)) {
    error.value = '邀请码须为 12 位短码（如 XXXX-XXXX-XXXX）或完整令牌';
    return;
  }
  const normalized = normalizeInvitationCredential(raw);
  if (import.meta.client) {
    window.location.hash = `#token=${encodeURIComponent(normalized)}`;
  }
  loadPreview(normalized);
}

function resetManualInput() {
  token.value = '';
  inputCredential.value = '';
  preview.value = null;
  error.value = '';
  if (import.meta.client) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

onMounted(() => {
  window.addEventListener('focus', refreshAccount);
  const foundToken = workspaceInvitationToken(route.hash);
  if (foundToken) {
    inputCredential.value = formatInvitationCode(foundToken);
    loadPreview(foundToken);
  }
});

onUnmounted(() => window.removeEventListener('focus', refreshAccount));

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
  if (accepting.value || !token.value) return;
  accepting.value = true;
  error.value = '';
  try {
    const response = await api.post<{ data: { domain_slug: string; classroom_id?: string } }>(
      '/api/v1/domain-invitations/accept',
      { token: token.value },
      { silent: true },
    );
    toast.success(preview.value?.classroom_id ? '已加入班级与所属空间' : '已加入空间');
    const targetClassroomId = response.data.classroom_id || preview.value?.classroom_id;
    const dest = targetClassroomId
      ? workspacePath(response.data.domain_slug, `classrooms/${targetClassroomId}`)
      : workspacePath(response.data.domain_slug);
    await navigateTo(dest, { replace: true });
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
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold text-text">
        {{ preview?.classroom_id ? '接受班级邀请' : '接受空间邀请' }}
      </h1>
      <UButton
        v-if="preview || token"
        variant="ghost"
        color="neutral"
        size="xs"
        @click="resetManualInput"
      >
        更换邀请码
      </UButton>
    </div>

    <p v-if="pending" class="mt-4 text-sm text-text-muted">正在检查邀请…</p>
    <UAlert v-if="error" class="mt-4" color="error" :title="error" />

    <!-- 手工邀请码输入表单（无有效预览时展示） -->
    <form v-if="!preview && !pending" class="mt-4 space-y-4" @submit.prevent="lookupCode">
      <AdminFormField label="邀请码或邀请令牌" hint="支持 12 位短码（如 XXXX-XXXX-XXXX，不区分大小写）或完整邀请令牌">
        <div class="flex gap-2">
          <UInput
            v-model="inputCredential"
            placeholder="例如 XXXX-XXXX-XXXX"
            class="grow font-mono"
            autocomplete="off"
            aria-label="邀请码输入"
            :disabled="pending"
          />
          <UButton type="submit" :loading="pending" :disabled="!inputCredential.trim()">查询邀请</UButton>
        </div>
      </AdminFormField>
    </form>

    <!-- 预览信息与接受逻辑 -->
    <div v-if="preview">
      <p class="mt-4 text-text-secondary">邀请你加入 <strong class="text-text">{{ preview.domain_name }}</strong>。</p>
      <p v-if="preview.classroom_name" class="mt-2 text-text-secondary">
        班级：<strong class="text-text">{{ preview.classroom_name }}</strong>。接受后会同时成为该空间的基础成员。
      </p>

      <div class="mt-3 space-y-1 text-sm text-text-muted">
        <p v-if="preview.mode === 'email'">
          邀请类型：<span class="text-text font-medium">指定邮箱（限 1 人）</span>
        </p>
        <p v-else-if="preview.mode === 'once'">
          邀请类型：<span class="text-text font-medium">一次性邀请（限 1 人）</span>
        </p>
        <p v-else>
          邀请类型：<span class="text-text font-medium">通用邀请（已使用 {{ preview.used_count }} / {{ preview.max_uses ?? '不限人数' }}）</span>
        </p>
        <p v-if="preview.email">受邀邮箱：<span class="font-mono text-text">{{ preview.email }}</span></p>
        <p class="text-xs tabular-nums">{{ new Date(preview.expires_at).toLocaleString() }} 到期</p>
      </div>

      <!-- 已登录 -->
      <template v-if="auth.isLoggedIn.value">
        <p class="mt-4 text-sm text-text-secondary">
          当前账号：{{ auth.user.value?.username }} · {{ auth.user.value?.email }}
        </p>
        <p
          v-if="auth.user.value?.must_change_password"
          class="mt-3 text-sm text-text-secondary"
        >
          此账号需要先更新初始密码。<NuxtLink to="/change-password" target="_blank" class="text-primary">设置密码</NuxtLink>后回到此页继续。
        </p>
        <UAlert
          v-if="preview.mode === 'email' && preview.email && auth.user.value?.email?.toLowerCase() !== preview.email.toLowerCase()"
          color="warning"
          class="mt-3"
          title="账号邮箱与受邀邮箱不符"
          description="此邀请指定受邀邮箱为 "
        >
          <template #description>
            此邀请指定受邀邮箱为 <strong class="font-mono">{{ preview.email }}</strong>，与当前登录账号不一致。
          </template>
        </UAlert>
        <div class="mt-4 flex items-center gap-2">
          <UButton
            :loading="accepting"
            :disabled="auth.user.value?.must_change_password"
            @click="accept"
          >
            接受邀请
          </UButton>
          <UButton variant="ghost" color="neutral" @click="resetManualInput">
            输入其他邀请码
          </UButton>
        </div>
      </template>

      <!-- 未登录 -->
      <form v-else class="mt-5 space-y-3" @submit.prevent="signIn">
        <AdminFormField label="已有账号登录">
          <UInput
            v-model="credentials.login"
            class="w-full"
            autocomplete="username"
            aria-label="账号或邮箱"
            required
          />
        </AdminFormField>
        <UInput
          v-model="credentials.password"
          class="w-full"
          type="password"
          autocomplete="current-password"
          aria-label="登录密码"
          required
        />
        <UInput
          v-if="tfaRequired"
          v-model="credentials.code"
          class="w-full"
          autocomplete="one-time-code"
          placeholder="两步验证码或恢复码"
          aria-label="两步验证码"
        />
        <div class="flex flex-wrap items-center gap-2">
          <UButton type="submit" :loading="signingIn">登录后接受</UButton>
          <UButton
            v-if="preview.can_register"
            :to="registrationLink"
            color="neutral"
            variant="outline"
          >
            没有账号，注册加入
          </UButton>
        </div>
        <p v-if="!preview.can_register" class="text-sm text-text-muted">
          此实例限制新账号注册（仅管理员开设账号），请使用已有账号登录加入。
        </p>
        <div class="flex flex-wrap items-center gap-2 pt-1 text-sm">
          <UButton
            color="neutral"
            variant="link"
            :loading="checkingAccount"
            @click="refreshAccount"
          >
            已在其他页面登录，重新检查
          </UButton>
          <UButton to="/login" target="_blank" color="neutral" variant="link">使用其他登录方式</UButton>
        </div>
      </form>
    </div>
  </UCard>
</template>

