<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue"

interface PaletteItem {
  id: string
  label: string
  to: string
  icon: string
  group: string
  keywords: string[]
}

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  "update:open": [value: boolean]
}>()

const router = useRouter()
const query = ref("")
const selectedIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)

const allItems: PaletteItem[] = [
  // 概览监控
  { id: "dash", label: "仪表盘", to: "/admin", icon: "i-lucide-layout-dashboard", group: "概览监控", keywords: ["yibiaopan", "home", "stats", "queue", "zhibiao"] },

  // 公共分类
  { id: "tags", label: "标签管理", to: "/admin/tags", icon: "i-lucide-tags", group: "公共分类", keywords: ["biaoqian", "tag", "category"] },

  // 主空间（旧 /admin 题务教务入口的最终落点）
  { id: "prob", label: "主空间 · 题库资源", to: "/d/main/problem-bindings", icon: "i-lucide-book-open", group: "主空间", keywords: ["timu", "problem", "binding", "testcase"] },
  { id: "contests", label: "主空间 · 比赛", to: "/d/main/contests", icon: "i-lucide-trophy", group: "主空间", keywords: ["jingsai", "contest", "match", "bisai"] },
  { id: "trainings", label: "主空间 · 题单", to: "/d/main/trainings", icon: "i-lucide-list-todo", group: "主空间", keywords: ["tidan", "training", "roadmap"] },
  { id: "subs", label: "主空间 · 提交记录", to: "/d/main/submissions", icon: "i-lucide-files", group: "主空间", keywords: ["tijiao", "submission", "judge", "rejudge"] },
  { id: "llm", label: "主空间 · LLM", to: "/d/main/llm", icon: "i-lucide-server", group: "主空间", keywords: ["llm", "ai", "model", "apikey", "gateway", "token", "usage", "xiaohao"] },

  // 评测与算力
  { id: "images", label: "评测镜像", to: "/admin/judge-images", icon: "i-lucide-container", group: "评测与算力", keywords: ["jingxiang", "docker", "image", "sandbox"] },
  { id: "llmquotas", label: "LLM 配额", to: "/admin/llm/quotas", icon: "i-lucide-gauge", group: "评测与算力", keywords: ["llm", "quota", "limit", "peie", "xianliang"] },

  // 社区与风控
  { id: "comm", label: "社区管理", to: "/admin/community", icon: "i-lucide-messages-square", group: "社区与风控", keywords: ["shequ", "community", "post", "comment"] },
  { id: "reports", label: "举报中心", to: "/admin/reports", icon: "i-lucide-flag", group: "社区与风控", keywords: ["jubao", "report", "violation"] },
  { id: "announce", label: "全站公告", to: "/admin/announcements", icon: "i-lucide-megaphone", group: "社区与风控", keywords: ["gonggao", "announcement", "notice"] },

  // 用户与安全
  { id: "users", label: "用户管理", to: "/admin/users", icon: "i-lucide-users", group: "用户与安全", keywords: ["yonghu", "user", "account", "member"] },
  { id: "blacklist", label: "黑名单管理", to: "/admin/blacklist", icon: "i-lucide-ban", group: "用户与安全", keywords: ["heimingdan", "ban", "ip", "block"] },
  { id: "legal", label: "法律与合规", to: "/admin/legal", icon: "i-lucide-scale", group: "用户与安全", keywords: ["falv", "privacy", "terms", "compliance"] },

  // 系统运维
  { id: "instance", label: "实例与空间治理", to: "/admin/instance", icon: "i-lucide-building-2", group: "系统运维", keywords: ["instance", "domain", "workspace", "空间", "审核", "额度"] },
  { id: "settings", label: "系统设置", to: "/admin/settings", icon: "i-lucide-settings", group: "系统运维", keywords: ["shezhi", "config", "settings", "env"] },
  { id: "audit", label: "审计日志", to: "/admin/audit-logs", icon: "i-lucide-scroll-text", group: "系统运维", keywords: ["shenji", "audit", "log", "security"] },
]

const filteredItems = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return allItems
  return allItems.filter((item) =>
    item.label.toLowerCase().includes(q) ||
    item.group.toLowerCase().includes(q) ||
    item.to.toLowerCase().includes(q) ||
    item.keywords.some((k) => k.toLowerCase().includes(q))
  )
})

watch(filteredItems, () => {
  selectedIndex.value = 0
})

watch(() => props.open, (val) => {
  if (val) {
    query.value = ""
    selectedIndex.value = 0
    nextTick(() => {
      inputRef.value?.focus()
    })
  }
})

function close() {
  emit("update:open", false)
}

function navigateToItem(item: PaletteItem) {
  close()
  router.push(item.to)
}

function onKeydown(e: KeyboardEvent) {
  if (!props.open) return

  if (e.key === "ArrowDown") {
    e.preventDefault()
    if (filteredItems.value.length > 0) {
      selectedIndex.value = (selectedIndex.value + 1) % filteredItems.value.length
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault()
    if (filteredItems.value.length > 0) {
      selectedIndex.value = (selectedIndex.value - 1 + filteredItems.value.length) % filteredItems.value.length
    }
  } else if (e.key === "Enter") {
    e.preventDefault()
    const target = filteredItems.value[selectedIndex.value]
    if (target) {
      navigateToItem(target)
    }
  } else if (e.key === "Escape") {
    close()
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown)
})

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown)
})
</script>

<template>
  <UModal :open="open" :ui="{ content: 'sm:max-w-xl' }" @update:open="(val: boolean) => emit('update:open', val)">
    <template #content>
      <div class="flex flex-col overflow-hidden rounded-lg bg-white border border-border shadow-modal">
        <!-- 搜索输入框 -->
        <div class="flex items-center gap-3 px-4 py-3.5 border-b border-border bg-bg-page/40">
          <UIcon name="i-lucide-search" class="size-4.5 text-text-muted shrink-0" />
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            placeholder="搜索管理功能、页面或关键词 (支持拼音与缩写)..."
            class="flex-1 bg-transparent border-none text-sm text-text placeholder:text-text-muted focus:outline-none"
            @keydown="onKeydown"
          />
          <kbd class="px-1.5 py-0.5 text-[10px] font-mono text-text-muted bg-white border border-border rounded shadow-[0_1px_0_rgba(0,0,0,0.06)]">
            ESC 关闭
          </kbd>
        </div>

        <!-- 结果列表 -->
        <div class="max-h-[360px] overflow-y-auto p-2 flex flex-col gap-1">
          <div
            v-if="filteredItems.length === 0"
            class="py-8 text-center text-sm text-text-muted flex flex-col items-center justify-center gap-2"
          >
            <UIcon name="i-lucide-search-x" class="size-6 text-text-muted/60" />
            <span>未找到匹配的管理项</span>
          </div>

          <button
            v-for="(item, idx) in filteredItems"
            :key="item.id"
            type="button"
            class="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-left transition-colors cursor-pointer border border-transparent"
            :class="idx === selectedIndex ? 'bg-primary-bg text-primary border-primary/20 font-medium' : 'text-text hover:bg-bg-page'"
            @mouseenter="selectedIndex = idx"
            @click="navigateToItem(item)"
          >
            <div
              class="flex items-center justify-center size-8 rounded shrink-0 transition-colors"
              :class="idx === selectedIndex ? 'bg-primary/10 text-primary' : 'bg-bg-sunken text-text-secondary'"
            >
              <UIcon :name="item.icon" class="size-4.5" />
            </div>

            <div class="flex-1 min-w-0 flex items-center justify-between gap-2">
              <span class="truncate">{{ item.label }}</span>
              <span class="text-xs text-text-muted font-normal shrink-0">{{ item.group }}</span>
            </div>

            <UIcon
              v-if="idx === selectedIndex"
              name="i-lucide-corner-down-left"
              class="size-3.5 text-primary shrink-0"
            />
          </button>
        </div>

        <!-- 底部快捷提示 -->
        <div class="flex items-center justify-between px-4 py-2 text-[11px] text-text-muted border-t border-border bg-bg-page/50">
          <div class="flex items-center gap-3">
            <span><kbd class="font-mono bg-white px-1 py-0.5 rounded border border-border">↑</kbd> <kbd class="font-mono bg-white px-1 py-0.5 rounded border border-border">↓</kbd> 选择</span>
            <span><kbd class="font-mono bg-white px-1 py-0.5 rounded border border-border">Enter</kbd> 跳转</span>
          </div>
          <span>Neuro OJ 管理工作站</span>
        </div>
      </div>
    </template>
  </UModal>
</template>
