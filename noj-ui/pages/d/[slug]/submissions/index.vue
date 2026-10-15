<script setup lang="ts">
import {workspaceCacheKey,workspacePath,workspaceProblemPath} from '~/utils/workspace';
import {extractApiError} from '~/utils/apiError';
import {formatDateTime,languageLabels} from '~/utils/submissionFormat';
definePageMeta({layout:'workspace',middleware:['auth','workspace-context']});
const route=useRoute(),router=useRouter(),{slug}=useWorkspace(),{user}=useAuth(),api=useDomainSubmissions();
const page=computed({get:()=>Math.max(1,Number(route.query.page)||1),set:value=>{void router.push({query:{...route.query,page:value>1?String(value):undefined}});}});
const filters=computed(()=>({
  problem_id:typeof route.query.problem_id==='string'?route.query.problem_id:undefined,
  contest_id:typeof route.query.contest_id==='string'?route.query.contest_id:undefined,
}));
const key=computed(()=>workspaceCacheKey(slug.value!,user.value?.id??null,'submissions',String(page.value),JSON.stringify(filters.value)));
const {data,status,error,refresh}=await useAsyncData(key,()=>api.list(slug.value!,page.value,filters.value));
watch([()=>filters.value.problem_id,()=>filters.value.contest_id],()=>{page.value=1;});
const columns=[
  {accessorKey:'id',header:'#'},
  {accessorKey:'problem',header:'题目',meta:{class:{th:'w-full',td:'min-w-36 whitespace-normal'}}},
  {accessorKey:'result',header:'评测结果'},
  {accessorKey:'language',header:'语言',meta:{class:{th:'hidden sm:table-cell',td:'hidden sm:table-cell'}}},
  {accessorKey:'version',header:'版本',meta:{class:{th:'hidden md:table-cell',td:'hidden md:table-cell'}}},
  {accessorKey:'created_at',header:'提交时间',meta:{class:{th:'hidden lg:table-cell',td:'hidden lg:table-cell'}}},
];
useSeoMeta({title:'我的提交'});
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="我的提交" description="当前域的代码、LLM、产物及预测提交" icon="i-lucide-file-code-2">
      <template #actions>
        <UButton :to="workspacePath(slug!,'objective-submissions')" color="neutral" variant="outline">客观题历史</UButton>
        <UButton color="neutral" variant="ghost" icon="i-lucide-refresh-cw" aria-label="刷新提交" :loading="status==='pending'" @click="refresh()" />
      </template>
    </AdminPageHeader>
    <div v-if="filters.problem_id || filters.contest_id" class="flex flex-wrap items-center gap-3 text-sm text-text-muted">
      <span>{{ filters.problem_id?'已按题目筛选':'' }} {{ filters.contest_id?'已按比赛筛选':'' }}</span>
      <UButton :to="workspacePath(slug!,'submissions')" size="xs" color="neutral" variant="ghost" icon="i-lucide-x">清除筛选</UButton>
    </div>
    <AsyncContent :status="error?'error':data?.data.length?'data':status==='pending'?'loading':'empty'" :error="error?extractApiError(error).message:undefined" empty-text="此域暂无你的提交" @retry="refresh()">
      <div class="overflow-x-auto rounded border border-border bg-bg-panel shadow-card">
        <UTable :data="data?.data ?? []" :columns="columns" :ui="{th:'px-3 py-3 text-xs',td:'px-3 py-3 text-sm'}">
          <template #id-cell="{row}"><NuxtLink :to="workspacePath(slug!,`submissions/${row.original.public_id||row.original.id}`)" class="font-mono text-xs text-primary">{{ row.original.public_id||row.original.id.slice(0,8) }}</NuxtLink></template>
          <template #problem-cell="{row}">
            <NuxtLink v-if="row.original.resource_available" :to="workspaceProblemPath(slug!,row.original.reference.display_ref)" class="break-words font-medium text-text no-underline hover:text-primary"><span class="mr-2 font-mono text-xs text-primary">{{ row.original.reference.display_ref }}</span>{{ row.original.problem?.title }}</NuxtLink>
            <span v-else class="text-text-muted">资源不可用</span>
          </template>
          <template #result-cell="{row}"><DomainSubmissionStatus :submission="row.original" /></template>
          <template #language-cell="{row}"><span class="whitespace-nowrap text-xs text-text-secondary">{{ languageLabels[row.original.language??''] ?? row.original.language }}</span></template>
          <template #version-cell="{row}"><span class="whitespace-nowrap text-xs tabular-nums text-text-muted">{{ row.original.submitted_version==null?'版本未知':`V${row.original.submitted_version}` }}</span></template>
          <template #created_at-cell="{row}"><span class="whitespace-nowrap text-xs tabular-nums text-text-muted">{{ formatDateTime(row.original.created_at) }}</span></template>
        </UTable>
      </div>
    </AsyncContent>
    <PaginationNav v-if="data && data.pagination.total_pages>1" :current-page="page" :total-pages="data.pagination.total_pages" @page-change="page=$event" />
  </div>
</template>
