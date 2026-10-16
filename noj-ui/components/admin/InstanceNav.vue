<script setup lang="ts">
const route = useRoute();

interface NavItem {
  label: string;
  to: string;
  icon: string;
}

const items: NavItem[] = [
  { label: '访问与注册', to: '/admin/instance/access', icon: 'i-lucide-door-open' },
  { label: '空间创建', to: '/admin/instance/creation', icon: 'i-lucide-plus-circle' },
  { label: '模块许可', to: '/admin/instance/modules', icon: 'i-lucide-blocks' },
  { label: '资源额度', to: '/admin/instance/limits', icon: 'i-lucide-gauge' },
  { label: 'LLM 上限', to: '/admin/instance/llm-limits', icon: 'i-lucide-bot' },
  { label: '空间目录', to: '/admin/instance/domains', icon: 'i-lucide-building-2' },
  { label: '创建申请', to: '/admin/instance/requests', icon: 'i-lucide-clipboard-check' },
];

const current = computed(() => {
  return items.find((item) => route.path === item.to)?.to ?? route.path;
});

function select(val: string) {
  return navigateTo(val);
}
</script>

<template>
  <div class="space-y-4">
    <!-- 移动端下拉选择 -->
    <USelect
      :model-value="current"
      :items="items.map(item => ({ label: item.label, value: item.to, icon: item.icon }))"
      class="w-full sm:hidden"
      aria-label="实例设置与治理导航"
      @update:model-value="select"
    />

    <!-- 桌面端横向分组 Tab 导航（近直角、细边框、品牌天青蓝激活） -->
    <nav aria-label="实例治理导航" class="hidden sm:flex items-center gap-1.5 overflow-x-auto border-b border-border pb-2">
      <NuxtLink
        v-for="item in items"
        :key="item.to"
        :to="item.to"
        class="flex items-center gap-2 rounded px-3 py-1.5 text-sm no-underline transition-colors shrink-0"
        :class="route.path === item.to
          ? 'bg-primary-bg font-semibold text-primary'
          : 'text-text-secondary hover:bg-primary-hover-bg hover:text-text'"
        :aria-current="route.path === item.to ? 'page' : undefined"
      >
        <UIcon :name="item.icon" class="size-4 shrink-0" />
        <span>{{ item.label }}</span>
      </NuxtLink>
    </nav>
  </div>
</template>
