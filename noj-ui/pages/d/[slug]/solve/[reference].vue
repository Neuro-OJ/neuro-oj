<script setup lang="ts">
import {workspaceCacheKey,workspaceProblemPath} from '~/utils/workspace';
import {extractApiError} from '~/utils/apiError';
import type {AssignmentSubmissionOrigin} from '~/utils/education';
definePageMeta({layout:'workspace-editor',middleware:'workspace-context',ssr:false});
const route=useRoute(),router=useRouter(),{slug}=useWorkspace(),{user}=useAuth(),api=useDomainProblems();
const reference=computed(()=>String(route.params.reference));
const key=computed(()=>workspaceCacheKey(slug.value!,user.value?.id??null,'solve',reference.value));
const {data,status,error,refresh}=await useAsyncData(key,()=>api.detail(slug.value!,reference.value));
const backUrl=computed(()=>router.resolve({path:workspaceProblemPath(slug.value!,reference.value),query:route.query}).href);
const origin=computed<AssignmentSubmissionOrigin|undefined>(()=>typeof route.query.assignment_id==='string' && typeof route.query.assignment_item_id==='string'
  ? {assignment_id:route.query.assignment_id,assignment_item_id:route.query.assignment_item_id} : undefined);
const inline=computed(()=>data.value?.content.kind==='objective' || ['artifact','prediction'].includes(data.value?.content.submission_mode??''));
useSeoMeta({title:()=>data.value ? `${data.value.content.title} · 做题` : '做题工作区'});
</script>
<template>
  <AsyncContent :status="error ? 'error' : data ? 'data' : status==='pending' ? 'loading':'empty'" :error="error ? extractApiError(error).message:undefined" @retry="refresh()">
    <template v-if="data">
      <div v-if="inline" class="flex min-h-dvh items-center justify-center"><UButton :to="backUrl">返回题目页作答</UButton></div>
      <div v-else-if="data.content.submission_mode==='ui'" class="mx-auto max-w-[1440px] space-y-4 p-4">
        <div class="flex items-center justify-between gap-3"><h1 class="text-xl font-semibold">{{ data.content.title }}</h1><UButton :to="backUrl" color="neutral" variant="outline">返回题目</UButton></div>
        <DomainProblemAnswer :key="`${key}`" :slug="slug!" :problem="data" :assignment-origin="origin" @refresh="refresh()" />
      </div>
      <DomainCodeWorkspace v-else :key="`${key}`" :slug="slug!" :problem="data" :back-url="backUrl" :assignment-origin="origin" @refresh="refresh()" />
    </template>
  </AsyncContent>
</template>
