<script setup lang="ts">
definePageMeta({
  middleware: "auth",
})

const { isLoggedIn, loading, user } = useAuth()
const router = useRouter()

watch(loading, (val) => {
  if (!val && !isLoggedIn.value) router.replace("/login")
}, { immediate: true })

interface ProblemItem {
  id: string
  title: string
  difficulty: string
  display_id: string
  number: number
  owner_id: string
  categories: { id: string; name: string }[]
  created_at: string
}

const problems = ref<ProblemItem[]>([])
const pageLoading = ref(true)
const loadError = ref("")
const currentPage = ref(1)
const totalPages = ref(1)
const perPage = 20

const difficultyLabels: Record<string, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难",
}

async function loadProblems(page = 1) {
  if (!isLoggedIn.value || !user.value) return
  pageLoading.value = true
  loadError.value = ""
  currentPage.value = page
  try {
    const res = await $fetch<{ data: ProblemItem[]; total: number }>(
      `/api/v1/problems?type=U&owner_id=${user.value.id}&page=${page}&limit=${perPage}`,
    )
    // 后端已按 type=U + owner_id 过滤，直接使用分页结果
    problems.value = res.data
    totalPages.value = Math.ceil(res.total / perPage)
  } catch (err: unknown) {
    loadError.value = err instanceof Error ? err.message : "加载题目失败"
  } finally {
    pageLoading.value = false
  }
}

watch(isLoggedIn, (val) => {
  if (val) loadProblems()
}, { immediate: true })

function onPageChange(page: number) {
  loadProblems(page)
}
</script>

<template>
  <div class="px-4 py-5 sm:px-7 sm:py-8 max-w-[960px] mx-auto">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-text">我的题目</h1>
        <span class="text-sm text-text-muted">{{ problems.length }} 道用户题</span>
      </div>
      <NuxtLink to="/problems/new" class="inline-flex items-center gap-1.5 text-sm px-4 py-2 bg-primary text-white border-[1.5px] border-primary rounded-md cursor-pointer no-underline transition-all duration-150 hover:bg-primary-dark hover:border-primary-dark">
        创建题目
      </NuxtLink>
    </div>

    <AsyncContent
      :status="pageLoading ? 'loading' : loadError ? 'error' : problems.length === 0 ? 'empty' : 'data'"
      :error="loadError || undefined"
      empty-text="你还没有创建任何题目"
      @retry="loadProblems(currentPage)"
    >
      <template #error>
        <span class="flex items-center justify-center size-11 rounded-full bg-red-100 text-red-800 text-xl font-bold">!</span>
        <p>{{ loadError }}</p>
        <button class="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-md border border-primary text-primary bg-transparent hover:bg-primary hover:text-white transition-colors cursor-pointer" @click="loadProblems(currentPage)">重试</button>
      </template>

      <template #empty>
        <p>你还没有创建任何题目</p>
        <NuxtLink to="/problems/new" class="inline-flex items-center gap-1.5 text-sm px-4 py-2 bg-primary text-white border-[1.5px] border-primary rounded-md cursor-pointer no-underline transition-all duration-150 hover:bg-primary-dark hover:border-primary-dark">
          创建第一道题
        </NuxtLink>
      </template>

      <div class="bg-white border border-border rounded-xl overflow-x-auto">
      <table class="w-full border-collapse">
        <thead>
          <tr>
            <th class="px-4 py-3 text-xs font-semibold text-left bg-gray-50 border-b border-border">题号</th>
            <th class="px-4 py-3 text-xs font-semibold text-left bg-gray-50 border-b border-border">标题</th>
            <th class="px-4 py-3 text-xs font-semibold text-left bg-gray-50 border-b border-border">难度</th>
            <th class="px-4 py-3 text-xs font-semibold text-left bg-gray-50 border-b border-border">创建时间</th>
            <th class="px-4 py-3 text-xs font-semibold text-center bg-gray-50 border-b border-border">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          <tr v-for="problem in problems" :key="problem.id">
            <td class="px-4 py-3.5">
              <ProblemId :display-id="problem.display_id" type="U" />
            </td>
            <td class="px-4 py-3.5">
              <NuxtLink :to="`/problems/${problem.id}`" class="text-text no-underline font-medium hover:text-primary">
                {{ problem.title }}
              </NuxtLink>
            </td>
            <td class="px-4 py-3.5">
              <span class="text-xs text-text-secondary">{{ difficultyLabels[problem.difficulty] || problem.difficulty }}</span>
            </td>
            <td class="px-4 py-3.5 text-xs text-text-secondary">
              {{ new Date(problem.created_at).toLocaleDateString("zh-CN") }}
            </td>
            <td class="px-4 py-3.5 text-center">
              <NuxtLink
                :to="`/problems/${problem.id}/edit`"
                class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-border rounded-md text-text-secondary hover:text-primary hover:border-primary/40 transition-colors"
              >
                编辑
              </NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    </AsyncContent>
  </div>
</template>
