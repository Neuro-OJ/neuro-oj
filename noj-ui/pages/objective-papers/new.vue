<script setup lang="ts">
definePageMeta({ middleware: 'auth', ssr: false })

useHead({ title: '新建客观题套卷 - Neuro OJ' })

const { createPaper } = useObjective()
const { toast } = useToast()
const router = useRouter()

const title = ref('')
const description = ref('')
const submitting = ref(false)

async function onCreate() {
  if (!title.value.trim()) {
    toast.error('标题不能为空')
    return
  }
  submitting.value = true
  try {
    const res = await createPaper({ title: title.value.trim(), description: description.value.trim() })
    toast.success('套卷已创建，开始添加小题')
    router.push(`/objective-papers/${res.data.id}/edit`)
  } catch {
    // useApi 已弹错误
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="min-h-[calc(100vh-64px)] bg-bg-page p-4 lg:p-6">
    <div class="mx-auto flex max-w-[640px] flex-col gap-4">
      <header>
        <h1 class="text-lg font-bold text-text">新建客观题套卷</h1>
        <p class="mt-1 text-sm text-text-secondary">
          创建后可在编辑页添加单选 / 多选 / 判断题
        </p>
      </header>

      <section class="rounded-xl border border-border bg-white p-5">
        <div class="flex flex-col gap-4">
          <UFormGroup label="标题">
            <UInput v-model="title" placeholder="如：LMCC 大模型基本素养模拟卷" />
          </UFormGroup>
          <UFormGroup label="描述">
            <UTextarea v-model="description" :rows="4" placeholder="套卷说明（可选）" />
          </UFormGroup>
          <div class="flex gap-2">
            <UButton color="primary" :loading="submitting" @click="onCreate">创建套卷</UButton>
            <UButton color="neutral" variant="outline" to="/objective-papers">取消</UButton>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
