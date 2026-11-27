<script setup lang="ts">
import { userUrl } from '~/utils/publicIdentifiers';

definePageMeta({});

const { user, isLoggedIn, loading, fetchUser } = useAuth();
const router = useRouter();
const route = useRoute();

const settingsGroups = [
  { label: '个人资料', value: 'settings-profile' },
  { label: '密码与安全', value: 'settings-security' },
  { label: '第三方账号', value: 'settings-connections' },
  { label: '自带模型', value: 'settings-byok' },
  { label: '数据与隐私', value: 'settings-privacy' },
  { label: '账号注销', value: 'settings-delete' },
];
const currentGroup = computed({
  get: () =>
    settingsGroups.some((group) => `#${group.value}` === route.hash) ? route.hash!.slice(1) : 'settings-profile',
  set: (value: string) => {
    void navigateTo({ path: route.path, query: route.query, hash: `#${value}` });
  },
});

// 认证守卫：loading 就绪后检查登录状态；已登录时向 /auth/me 同步真实 TFA/密码状态
watch(
  loading,
  async (loadingVal) => {
    if (loadingVal) return;
    if (!isLoggedIn.value) {
      router.replace('/login');
      return;
    }
    try {
      await fetchUser();
    } catch {
      // fetchUser 内部已处理 401 登出，其余错误静默保留本地会话
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="mx-auto max-w-[1120px] px-4 py-6 sm:px-6 sm:py-8">
    <header class="mb-6">
      <h1 class="text-2xl font-bold text-text">账号设置</h1>
      <p class="mt-2 text-sm text-text-secondary">管理个人资料、登录安全与关联账号。各项修改分别保存。</p>
    </header>
    <div class="grid items-start gap-6 lg:grid-cols-[180px_minmax(0,1fr)]">
      <aside class="hidden lg:sticky lg:top-24 lg:block">
        <nav aria-label="账号设置分组" class="space-y-1">
          <NuxtLink
            v-for="group in settingsGroups"
            :key="group.value"
            :to="{ path: route.path, query: route.query, hash: `#${group.value}` }"
            :aria-current="currentGroup === group.value ? 'location' : undefined"
            class="block rounded px-3 py-3 text-sm font-medium"
            :class="currentGroup === group.value ? 'bg-primary-bg text-primary' : 'text-text-secondary hover:bg-primary-hover-bg hover:text-text'"
          >{{ group.label }}</NuxtLink>
        </nav>
      </aside>
      <div class="min-w-0 space-y-6">
        <div class="sticky top-[var(--header-h)] z-20 border-b border-border bg-bg-page py-3 lg:hidden">
          <USelect v-model="currentGroup" :items="settingsGroups" aria-label="账号设置分组" class="w-full" />
        </div>
        <!--
          返回个人主页（评审修正）：/settings 在面包屑注册表中是**单层**，
          而 BreadcrumbNav 对单层不渲染（避免占用首屏）。因此本页若删掉该链接，
          就会**完全没有返回导航**。单层页面的返回入口与面包屑不构成重复，故保留。
        -->
        <NuxtLink
          v-if="user?.id"
          :to="userUrl(user?.username ?? '')"
          class="inline-flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-primary"
        >
          <UIcon name="i-lucide-arrow-left" class="size-4" />
          返回个人主页
        </NuxtLink>

        <AuthProfileSettingsSection />
        <AuthSecuritySettingsSection />
        <AuthOAuthSettingsSection />
        <UserByokSettings />
        <AuthPrivacySettingsSection />
        <AuthDeleteAccountSection />
      </div>
    </div>
  </div>
</template>
