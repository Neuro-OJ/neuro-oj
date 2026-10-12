<script setup lang="ts">
import type { OiWorkspaceCase, ProblemSample } from "~/utils/oiWorkspace"
import { extractApiError } from "~/utils/apiError"
const props = defineProps<{problemId: string; code: string; language: string; samples: ProblemSample[]; backend?: string | null}>()
const { api } = useApi()
const { user } = useAuth()
const customs = ref<OiWorkspaceCase[]>([])
const selfTestId = ref<string | null>(null)
const { selfTest, isPolling, start, stop } = useSelfTestPolling(selfTestId)
const error = ref("")
const sending = ref(false)
const activeIds = ref<string[]>([])
const sampleEnabled = ref<Record<string, boolean>>({})
const storageKey = computed(() => user.value?.id ? `noj:oi-cases:${user.value.id}:${props.problemId}` : null)
const official = computed<OiWorkspaceCase[]>(() => props.samples.map((sample) => ({id:`sample_${sample.id}`,input:sample.input,expected_output:sample.output,origin:"sample",enabled:sampleEnabled.value[sample.id]!==false})))
const cases = computed(() => [...official.value,...customs.value])
watch(storageKey, (key) => {
  stop(); selfTest.value=null; customs.value=[]; sampleEnabled.value={}; activeIds.value=[]; selfTestId.value=null
  if(!key || !import.meta.client)return
  try {
    const saved=JSON.parse(localStorage.getItem(key)??"[]")
    if(Array.isArray(saved)) customs.value=saved.filter((item)=>item && typeof item.id==="string" && typeof item.input==="string" && (item.expected_output===undefined || typeof item.expected_output==="string")).slice(0,30).map((item)=>({...item,origin:"custom",enabled:item.enabled!==false}))
  } catch { error.value="自测草稿无法读取，请重新添加用例" }
}, {immediate:true})
watch(customs, (value) => {
  if(!storageKey.value || !import.meta.client)return
  try {localStorage.setItem(storageKey.value,JSON.stringify(value))} catch {error.value="本地空间不足，自测草稿未保存"}
}, {deep:true})
const results = computed(() => {
  const oi=selfTest.value?.details?.oi as {subtasks?: {cases?: {case_id:string;status:string;stdout?:string;stderr?:string;stdout_truncated?:boolean;stderr_truncated?:boolean;time_ms?:number;memory_kb?:number}[]}[]} | undefined
  const completed = (selfTest.value?.progress?.completed_cases ?? []) as {case_id:string;status:string;stdout?:string;stderr?:string;stdout_truncated?:boolean;stderr_truncated?:boolean;time_ms?:number;memory_kb?:number}[];
  return new Map([...completed,...(oi?.subtasks??[]).flatMap((subtask)=>subtask.cases??[])].map((item)=>[item.case_id,item]))
})
function add(source?: OiWorkspaceCase) { customs.value.push({id:`custom_${crypto.randomUUID()}`,input:source?.input??"",...(source?.expected_output!==undefined?{expected_output:source.expected_output}:{}),enabled:true,origin:"custom"}) }
function compareToggle(item:OiWorkspaceCase, enabled:boolean) { if(enabled)item.expected_output=""; else delete item.expected_output }
function enable(item:OiWorkspaceCase, value:boolean) { if(item.origin==="sample")sampleEnabled.value[item.id.slice(7)]=value;else item.enabled=value }
function move(id:string,delta:number) {const index=customs.value.findIndex(item=>item.id===id);const target=index+delta;if(index<0 || target<0 || target>=customs.value.length)return;[customs.value[index],customs.value[target]]=[customs.value[target]!,customs.value[index]!]}
async function run(selected?:OiWorkspaceCase[]) {
  if(sending.value || isPolling.value)return
  const enabled=selected??cases.value.filter((item)=>item.enabled)
  if(!enabled.length){error.value="请添加或启用至少一个用例";return}
  if(!props.code.trim()){error.value="请先编写代码";return}
  const ownerKey=storageKey.value
  sending.value=true;error.value=""
  try {
    const response=await api.post<{data:{id:string}}>(`/api/v1/problems/${props.problemId}/self-test`,{language:props.language,code:props.code,cases:enabled.map((item)=>({id:item.id,input:item.input,...(item.expected_output!==undefined?{expected_output:item.expected_output}:{})}))})
    if(storageKey.value!==ownerKey)return
    activeIds.value=enabled.map(item=>item.id);start(response.data.id)
  } catch(err){error.value=extractApiError(err).message} finally {sending.value=false}
}
async function cancel() {if(!selfTestId.value)return;try{await api.post(`/api/v1/self-tests/${selfTestId.value}/cancel`,{})}catch(err){error.value=extractApiError(err).message}}
function copy(text:string) {navigator.clipboard.writeText(text).catch(()=>{error.value="复制失败，请手动选择文本"})}
defineExpose({runAll:()=>run()})
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2"><h3 class="mr-auto font-semibold">测试用例</h3><UButton size="xs" variant="outline" icon="i-lucide-plus" @click="add()">添加</UButton><UButton size="xs" :loading="sending" :disabled="isPolling" icon="i-lucide-play" @click="run()">运行全部</UButton><UButton v-if="isPolling" size="xs" color="error" variant="outline" icon="i-lucide-square" @click="cancel">停止</UButton></div>
    <p class="text-xs text-text-muted">只运行公开样例及自定义用例，忽略行末空白。未提供预期输出时仅运行。</p>
    <UAlert v-if="error" color="error" :description="error" />
    <p v-if="!cases.length" class="rounded-md border border-dashed border-border p-4 text-center text-xs text-text-muted">题目暂无结构化样例，可自行添加用例。</p>
    <details v-for="(item,index) in cases" :key="item.id" open class="rounded-md border border-border bg-panel p-3">
      <summary class="flex cursor-pointer items-center gap-2 text-sm"><UCheckbox :model-value="item.enabled" aria-label="启用用例" @click.stop @update:model-value="enable(item,!!$event)" /><span>用例 {{ index+1 }}</span><UBadge size="sm" color="neutral" variant="subtle">{{item.origin==='sample'?'题目样例':'自定义'}}</UBadge><UBadge v-if="results.get(item.id)" size="sm" :color="results.get(item.id)?.status==='AC'?'success':'error'">{{item.expected_output===undefined && results.get(item.id)?.status==='AC'?'运行完成':results.get(item.id)?.status}}</UBadge><span v-else-if="isPolling && activeIds.includes(item.id)" class="text-xs text-text-muted">等待／运行中</span></summary>
      <div class="mt-3 space-y-3">
        <UFormField label="输入"><UTextarea v-if="item.origin==='custom'" v-model="item.input" class="w-full font-mono" :rows="3" /><pre v-else class="overflow-auto whitespace-pre-wrap rounded bg-sunken p-2 text-xs">{{item.input}}</pre></UFormField>
        <UCheckbox v-if="item.origin==='custom'" :model-value="item.expected_output!==undefined" label="提供预期输出" @update:model-value="compareToggle(item,!!$event)" />
        <UFormField v-if="item.expected_output!==undefined" label="预期输出"><UTextarea v-if="item.origin==='custom'" v-model="item.expected_output" class="w-full font-mono" :rows="3" /><pre v-else class="overflow-auto whitespace-pre-wrap rounded bg-sunken p-2 text-xs">{{item.expected_output}}</pre></UFormField>
        <div class="flex flex-wrap gap-1"><UButton size="xs" variant="soft" :disabled="isPolling || sending" @click="run([item])">运行此例</UButton><UButton size="xs" variant="ghost" @click="add(item)">{{item.origin==='sample'?'修改副本':'复制'}}</UButton><template v-if="item.origin==='custom'"><UButton size="xs" variant="ghost" @click="move(item.id,-1)">上移</UButton><UButton size="xs" variant="ghost" @click="move(item.id,1)">下移</UButton><UButton size="xs" color="error" variant="ghost" @click="customs=customs.filter(test=>test.id!==item.id)">删除</UButton></template></div>
        <div v-if="results.get(item.id)" class="space-y-2 border-t border-border pt-3">
          <p class="text-xs tabular-nums">{{backend==='oi-wasm'?'参考时间':'运行时间'}}：{{results.get(item.id)?.time_ms??'—'}} ms · 内存：{{results.get(item.id)?.memory_kb??'—'}} KiB</p>
          <div class="flex items-center justify-between text-xs font-medium"><span>实际输出 · stdout</span><UButton size="xs" variant="ghost" @click="copy(results.get(item.id)?.stdout??'')">复制</UButton></div>
          <pre class="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-sunken p-2 font-mono text-xs">{{results.get(item.id)?.stdout??''}}</pre><p v-if="results.get(item.id)?.stdout_truncated" class="text-xs text-warning-text">stdout 已截断</p>
          <div v-if="results.get(item.id)?.status==='WA' && item.expected_output!==undefined" class="rounded border border-error-text/30 p-2 text-xs"><p class="mb-1 font-medium text-error-text">输出差异（行内空白参与比较）</p><div v-for="(line,lineIndex) in (results.get(item.id)?.stdout??'').split('\n')" :key="lineIndex" :class="line.trimEnd()!==item.expected_output.split('\n')[lineIndex]?.trimEnd()?'bg-error-text/10 text-error-text':''" class="whitespace-pre-wrap font-mono"><span class="mr-2 text-text-muted">{{lineIndex+1}}</span>{{line}}</div></div>
          <details v-if="results.get(item.id)?.stderr || results.get(item.id)?.stderr_truncated" class="rounded border border-warning-text/30 p-2"><summary class="cursor-pointer text-xs font-medium text-warning-text">标准错误 · stderr</summary><UButton size="xs" variant="ghost" @click="copy(results.get(item.id)?.stderr??'')">复制</UButton><pre class="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs">{{results.get(item.id)?.stderr}}</pre><p v-if="results.get(item.id)?.stderr_truncated" class="text-xs text-warning-text">stderr 已截断</p></details>
        </div>
      </div>
    </details>
    <details v-if="selfTest?.details?.oi && (selfTest.details.oi as {compile_error?:string}).compile_error" open class="rounded border border-error-text/30 p-3"><summary class="text-sm text-error-text">编译诊断</summary><pre class="overflow-auto whitespace-pre-wrap text-xs">{{(selfTest.details.oi as {compile_error?:string}).compile_error}}</pre></details>
  </div>
</template>
