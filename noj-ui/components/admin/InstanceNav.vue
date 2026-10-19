<script setup lang="ts">
const route = useRoute();

interface NavItem {
  label: string;
  to: string;
  icon: string;
  group: '基础政策' | '模型与额度' | '治理';
}

const items: NavItem[] = [
  { label: '访问与注册', to: '/admin/instance/access', icon: 'i-lucide-door-open', group: '基础政策' },
  { label: '空间创建', to: '/admin/instance/creation', icon: 'i-lucide-plus-circle', group: '基础政策' },
  { label: '模块许可', to: '/admin/instance/modules', icon: 'i-lucide-blocks', group: '基础政策' },
  { label: '资源额度', to: '/admin/instance/limits', icon: 'i-lucide-gauge', group: '模型与额度' },
  { label: 'LLM 上限', to: '/admin/instance/llm-limits', icon: 'i-lucide-bot', group: '模型与额度' },
  { label: '空间目录', to: '/admin/instance/domains', icon: 'i-lucide-building-2', group: '治理' },
  { label: '创建申请', to: '/admin/instance/requests', icon: 'i-lucide-clipboard-check', group: '治理' },
  { label: '批注查询', to: '/admin/instance/annotations', icon: 'i-lucide-notebook-pen', group: '治理' },
];

const groupedItems = computed(() => {
  const groups: { name: '基础政策' | '模型与额度' | '治理'; items: NavItem[] }[] = [
    { name: '基础政策', items: [] },
    { name: '模型与额度', items: [] },
    { name: '治理', items: [] },
  ];
  for (const item of items) {
    const g = groups.find((grp) => grp.name === item.group);
    if (g) g.items.push(item);
  }
  return groups.filter((g) => g.items.length > 0);
});

const current = computed(() => {
  return items.find((item) => route.path === item.to)?.to ?? route.path;
});

function select(val: string) {
  return navigateTo(val);
}
</script>

<template>
  <div class="space-y-4">
    <!-- 移动端下拉选择（带清晰组名与当前位置） -->
    <USelect
      :model-value="current"
      :items="items.map(item => ({ label: `${item.group} · ${item.label}`, value: item.to, icon: item.icon }))"
      class="w-full sm:hidden"
      aria-label="实例治理导航"
      @update:model-value="select"
    />

    <!-- 桌面端横向任务分组导航（近直角、细边框、分组胶囊、品牌天青蓝激活） -->
    <nav aria-label="实例治理导航" class="hidden sm:flex items-center gap-3 overflow-x-auto border-b border-border pb-2.5">
      <div v-for="grp in groupedItems" :key="grp.name" class="flex items-center gap-1.5 shrink-0">
        <span class="text-xs font-semibold text-text-muted px-1">{{ grp.name }}</span>
        <div class="flex items-center gap-1 rounded bg-bg-sunken/60 p-0.5 border border-border/60">
          <NuxtLink
            v-for="item in grp.items"
            :key="item.to"
            :to="item.to"
            class="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs no-underline transition-colors shrink-0"
            :class="route.path === item.to
              ? 'bg-bg-panel font-semibold text-primary shadow-xs'
              : 'text-text-secondary hover:bg-bg-panel/60 hover:text-text'"
            :aria-current="route.path === item.to ? 'page' : undefined"
          >
            <UIcon :name="item.icon" class="size-3.5 shrink-0" />
            <span>{{ item.label }}</span>
          </NuxtLink>
        </div>
      </div>
    </nav>
  </div>
</template>
