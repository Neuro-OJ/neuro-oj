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

  // 题务教务
  { id: "prob", label: "题目管理", to: "/admin/problems", icon: "i-lucide-book-open", group: "题务教务", keywords: ["timu", "problem", "create", "testcase"] },
  { id: "tags", label: "标签管理", to: "/admin/tags", icon: "i-lucide-tags", group: "题务教务", keywords: ["biaoqian", "tag", "category"] },
  { id: "contests", label: "竞赛管理", to: "/admin/contests", icon: "i-lucide-trophy", group: "题务教务", keywords: ["jingsai", "contest", "match", "bisai"] },
  { id: "trainings", label: "题单管理", to: "/admin/trainings", icon: "i-lucide-list-todo", group: "题务教务", keywords: ["tidan", "training", "roadmap"] },

  // 评测与算力
  { id: "subs", label: "提交记录", to: "/admin/submissions", icon: "i-lucide-files", group: "评测与算力", keywords: ["tijiao", "submission", "judge", "rejudge"] },
  { id: "images", label: "评测镜像", to: "/admin/judge-images", icon: "i-lucide-container", group: "评测与算力", keywords: ["jingxiang", "docker", "image", "sandbox"] },
  { id: "providers", label: "LLM Provider", to: "/admin/llm/providers", icon: "i-lucide-server", group: "评测与算力", keywords: ["llm", "ai", "model", "apikey", "gateway"] },
  { id: "llmusage", label: "LLM 用量统计", to: "/admin/llm/usage", icon: "i-lucide-bar-chart-3", group: "评测与算力", keywords: ["token", "cost", "usage", "xiaohao"] },
  { id: "llmquotas", label: "LLM 配额", to: "/admin/llm/quotas", icon: "i-lucide-gauge", group: "评测与算力", keywords: ["llm", "quota", "limit", "peie", "xianliang"] },

  // 社区与风控
  { id: "comm", label: "社区管理", to: "/admin/community", icon: "i-lucide-messages-square", group: "社区与风控", keywords: ["shequ", "community", "post", "comment"] },
  { id: "review", label: "内容审查", to: "/admin/content-review", icon: "i-lucide-shield-alert", group: "社区与风控", keywords: ["shenhe", "review", "audit", "moderation"] },
  { id: "reports", label: "举报中心", to: "/admin/reports", icon: "i-lucide-flag", group: "社区与风控", keywords: ["jubao", "report", "violation"] },
  { id: "announce", label: "全站公告", to: "/admin/announcements", icon: "i-lucide-megaphone", group: "社区与风控", keywords: ["gonggao", "announcement", "notice"] },
  { id: "carousel", label: "轮播管理", to: "/admin/carousel", icon: "i-lucide-gallery-horizontal", group: "社区与风控", keywords: ["lunbo", "banner", "carousel"] },

  // 用户与安全
  { id: "users", label: "用户管理", to: "/admin/users", icon: "i-lucide-users", group: "用户与安全", keywords: ["yonghu", "user", "account", "member"] },
  { id: "roles", label: "角色权限", to: "/admin/roles", icon: "i-lucide-shield-check", group: "用户与安全", keywords: ["jiaose", "role", "rbac", "permission"] },
  { id: "blacklist", label: "黑名单管理", to: "/admin/blacklist", icon: "i-lucide-ban", group: "用户与安全", keywords: ["heimingdan", "ban", "ip", "block"] },
  { id: "legal", label: "法律与合规", to: "/admin/legal", icon: "i-lucide-scale", group: "用户与安全", keywords: ["falv", "privacy", "terms", "compliance"] },

  // 系统运维
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
