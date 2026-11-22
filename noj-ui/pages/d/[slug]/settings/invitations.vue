<script setup lang="ts">
import { computed } from 'vue';
import InvitationManager from '~/components/workspace/InvitationManager.vue';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });

const context = useWorkspace();
const domainSlug = computed(() => context.slug.value ?? '');
const permitted = computed(() => context.can('domain:invitations'));

const errorStatus = computed(() => {
  if (!context.error.value) return undefined;
  return extractApiError(context.error.value).status;
});

const isUnauthorized = computed(() => {
  if (errorStatus.value === 401 || errorStatus.value === 403) return true;
  if (context.status.value === 'success' && !permitted.value) return true;
  if (context.domain.value && !permitted.value) return true;
  return false;
});

const writable = computed(() =>
  permitted.value &&
  context.domain.value?.status === 'active' &&
  context.status.value === 'success'
);

useSeoMeta({ title: '邀请管理 - 域设置' });
</script>

<template>
  <DomainSettingsShell>
    <div v-if="!isUnauthorized" class="space-y-6">
      <AdminPageHeader
        title="邀请管理"
        description="管理空间的成员邀请凭据，支持通用邀请、指定邮箱与一次性邀请。"
        icon="i-lucide-mail"
      />
      <p v-if="context.error.value" class="text-sm text-error-text" role="alert">
        {{ extractApiError(context.error.value).message }}
      </p>
      <InvitationManager
        v-if="domainSlug"
        :domain-slug="domainSlug"
        :writable="writable"
      />
    </div>
    <UAlert
      v-else
      color="neutral"
      variant="subtle"
      title="你没有管理此空间邀请的权限"
    />
  </DomainSettingsShell>
</template>

