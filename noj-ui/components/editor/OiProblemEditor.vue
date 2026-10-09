<script setup lang="ts">
import { useToast } from "~/composables/useToast"
import { extractApiError } from "~/utils/apiError"
import { caseMaxScores } from "~/utils/oiWorkspace"
interface Case { id: string; input: string; output: string; score?: number; time_limit_ms?: number; memory_limit_mb?: number }
interface Subtask { id: string; score: number; scoring: "min" | "max" | "sum"; depends_on: string[]; time_limit_ms?: number; memory_limit_mb?: number; cases: Case[] }
interface Runtime { backend: "native" | "wasm"; languages: ("c" | "cc")[]; time_limit_ms: number; memory_limit_mb: number; checker: {type: "default" | "strict" | "testlib"; path?: string}; subtasks: Subtask[]; filename?: string; compile_extra_files?: string[]; checker_extra_files?: string[]; user_extra_files?: string[]; scoring_version?: number }
const props = withDefaults(defineProps<{initialType?: "U" | "P"; mode?: "create" | "edit"; problemId?: string}>(), {initialType:"U", mode:"create"})
const emit = defineEmits<{saved:[id:string]}>()
const { api } = useApi()
const { toast } = useToast()
const { title, description, difficulty, samples, tagIds, visibility } = useProblemAuthorFields()
const tagOptions = ref<{label:string;value:string}[]>([])
async function loadTags() { const response=await api.get<{data:{id:string;name:string;kind:string}[]}>("/api/v1/tags");tagOptions.value=response.data.map(tag=>({label:`${tag.kind==='algorithm'?'算法':'题目'} · ${tag.name}`,value:tag.id})) }
onMounted(()=>loadTags().catch(err=>{error.value=extractApiError(err).message}))
const runtime = ref<Runtime>({backend:"wasm",languages:["c","cc"],time_limit_ms:1000,memory_limit_mb:256,checker:{type:"default"},subtasks:[{id:"all",score:100,scoring:"sum",depends_on:[],cases:[newCase()]}]})
const activeSubtask = ref(0)
const loading = ref(false)
const saving = ref(false)
const error = ref("")
const packageFile = shallowRef<File | null>(null)
const uploadInput = ref<HTMLInputElement | null>(null)
const dataInput = ref<HTMLInputElement | null>(null)
const fileList = ref<{path:string;size:number}[]>([])
const addedFiles = shallowRef<{path:string;file:File}[]>([])
const changedFiles = ref<Record<string,string>>({})
const removedFiles = ref<string[]>([])
const updatedAt = ref<string>()
const selectedPath = ref("")
const fileText = ref("")
const originalTexts = ref<Record<string,string>>({})
const previewError = ref("")
const fileEditable = ref(false)
const fileLoading = ref(false)
const pendingImport = shallowRef<{manifest:{title:string;runtime_config:Runtime;samples?:typeof samples.value};description:string;files:{path:string;size:number}[];file:File}|null>(null)
const selectedCases = ref<string[]>([])
const moveTarget = ref("")
const pairs = ref<Case[]>([])
const visibleFiles = computed(()=>fileList.value.filter(item=>!removedFiles.value.includes(item.path)))
async function previewPackage(event:Event) {
  const file=(event.target as HTMLInputElement).files?.[0];if(!file)return
  const form=new FormData();form.append("file",file);if(props.problemId)form.append("problem_id",props.problemId)
  fileLoading.value=true;previewError.value=""
  try {const response=await api.post<{data:{manifest:{title:string;runtime_config:Runtime;samples?:typeof samples.value};description:string;files:{path:string;size:number}[]}}>("/api/v1/problems/oi-author/preview",form);pendingImport.value={...response.data,file}}
  catch(err){previewError.value=extractApiError(err).message}finally{fileLoading.value=false;(event.target as HTMLInputElement).value=""}
}
function applyImport() {
  const imported=pendingImport.value;if(!imported)return
  title.value=imported.manifest.title;description.value=imported.description;samples.value=imported.manifest.samples??[]
  runtime.value={...imported.manifest.runtime_config,subtasks:imported.manifest.runtime_config.subtasks.map((item)=>({...item,scoring:item.scoring??"min",depends_on:item.depends_on??[],cases:item.cases.map((test,index)=>({...test,id:test.id??`${item.id}_${index+1}`}))}))}
  packageFile.value=imported.file;fileList.value=imported.files.filter(item=>!["problem.json","problem.yaml","problem.md","statement.md"].includes(item.path));changedFiles.value={};removedFiles.value=[];addedFiles.value=[];activeSubtask.value=0;pendingImport.value=null
}
function addData(event:Event) {
  const files=Array.from((event.target as HTMLInputElement).files??[])
  for(const file of files){const path=`testdata/${file.name}`;addedFiles.value=[...addedFiles.value.filter(item=>item.path!==path),{path,file}];fileList.value=[...fileList.value.filter(item=>item.path!==path),{path,size:file.size}];removedFiles.value=removedFiles.value.filter(item=>item!==path)}
  ;(event.target as HTMLInputElement).value=""
}
function previewPairs() {
  const names=new Set(visibleFiles.value.map(item=>item.path));pairs.value=[]
  for(const path of Array.from(names).sort((a,b)=>a.localeCompare(b,"en",{numeric:true}))) {
    if(!path.endsWith(".in"))continue
    const base=path.slice(0,-3);const output=names.has(`${base}.out`)?`${base}.out`:names.has(`${base}.ans`)?`${base}.ans`:null
    if(output)pairs.value.push({...newCase(),input:path,output})
  }
}
function applyPairs() {if(!current.value)return;const used=new Set(runtime.value.subtasks.flatMap(item=>item.cases.map(test=>test.input)));current.value.cases=current.value.cases.filter(item=>item.input||item.output);current.value.cases.push(...pairs.value.filter(item=>!used.has(item.input)));pairs.value=[]}
function moveCases() {if(!current.value)return;const target=runtime.value.subtasks.find(item=>item.id===moveTarget.value);if(!target||target===current.value)return;const chosen=current.value.cases.filter(item=>selectedCases.value.includes(item.id));if(chosen.length===current.value.cases.length){error.value="子任务至少保留一个测试点";return}target.cases.push(...chosen);current.value.cases=current.value.cases.filter(item=>!selectedCases.value.includes(item.id));selectedCases.value=[]}
async function editFile(path:string) {
  selectedPath.value=path;fileEditable.value=false;fileLoading.value=true;previewError.value=""
  try {
    if(Object.hasOwn(changedFiles.value,path)){fileText.value=changedFiles.value[path]!;fileEditable.value=true;return}
    const added=addedFiles.value.find(item=>item.path===path)
    if(added){if(added.file.size>1024*1024){previewError.value="文件超过 1 MiB，请下载或替换，不能截断后编辑";return}fileText.value=new TextDecoder("utf-8",{fatal:true}).decode(await added.file.arrayBuffer());originalTexts.value[path]=fileText.value;fileEditable.value=!fileText.value.includes("\0");return}
    let response:{data:{text:string|null;truncated:boolean}}
    if(packageFile.value){const form=new FormData();form.append("file",packageFile.value);form.append("path",path);if(props.problemId)form.append("problem_id",props.problemId);response=await api.post("/api/v1/problems/oi-author/preview",form)}
    else response=await api.get(`/api/v1/problems/oi-author/${props.problemId}/file`,{query:{path}})
    fileEditable.value=response.data.text!==null&&!response.data.truncated;fileText.value=response.data.text??"";originalTexts.value[path]=fileText.value;if(!fileEditable.value)previewError.value="此文件为二进制或超过编辑上限，请下载或上传替换"
  }catch(err){previewError.value=extractApiError(err).message}finally{fileLoading.value=false}
}
function recordEdit(){if(!fileEditable.value || fileLoading.value)return;if(fileText.value===originalTexts.value[selectedPath.value])delete changedFiles.value[selectedPath.value];else changedFiles.value[selectedPath.value]=fileText.value}
function removeFile(path:string){if(runtime.value.subtasks.some(item=>item.cases.some(test=>test.input===path||test.output===path)) || runtime.value.checker.path===path){previewError.value="请先移除配置中对该文件的引用";return}removedFiles.value.push(path);delete changedFiles.value[path]}
const current = computed(() => runtime.value.subtasks[activeSubtask.value])
const maximums = computed(() => current.value ? caseMaxScores(current.value) : [])
const total = computed(() => runtime.value.subtasks.reduce((sum, item) => sum + item.score, 0))
function newCase(): Case { return {id:`case_${crypto.randomUUID()}`,input:"",output:""} }
function addSubtask() { runtime.value.subtasks.push({id:`subtask_${crypto.randomUUID()}`,score:1,scoring:"sum",depends_on:[],cases:[newCase()]}); activeSubtask.value=runtime.value.subtasks.length-1 }
function removeSubtask() { if (runtime.value.subtasks.length<2) return; const id=current.value?.id; if(!id)return; if(runtime.value.subtasks.some((item)=>item.depends_on.includes(id))) {error.value="请先移除引用该子任务的依赖";return} runtime.value.subtasks.splice(activeSubtask.value,1);activeSubtask.value=Math.max(0,activeSubtask.value-1) }
function moveSubtask(delta:number) { const target=activeSubtask.value+delta; if(target<0 || target>=runtime.value.subtasks.length)return; const items=runtime.value.subtasks; [items[target],items[activeSubtask.value]]=[items[activeSubtask.value]!,items[target]!];activeSubtask.value=target }
async function save() {
  if(!title.value.trim() || !description.value.trim()) {error.value="标题和题面不能为空";return}
  saving.value=true;error.value=""
  try {
    const payload={title:title.value.trim(),description:description.value,samples:samples.value,difficulty:difficulty.value,tag_ids:tagIds.value,visibility:visibility.value,judge_type:"oi",runtime_config:{...runtime.value,scoring_version:2}}
    const form=new FormData();form.append("metadata",JSON.stringify({problem:{...payload,type:props.initialType},changes:changedFiles.value,removed:removedFiles.value,updated_at:updatedAt.value,upload_paths:addedFiles.value.map(item=>item.path)}))
    if(packageFile.value)form.append("file",packageFile.value)
    for(const item of addedFiles.value)form.append("data_files",item.file,item.path)
    const res=await api.post<{data:{id:string}}>(`/api/v1/problems/oi-author/${props.mode==="edit"?props.problemId:"new"}/save`,form)
    toast.success("OI 题目已保存");emit("saved",res.data.id)
  } catch(err) {error.value=extractApiError(err).message} finally {saving.value=false}
}
onMounted(async()=> {
  if(props.mode!=="edit" || !props.problemId)return
  loading.value=true
  try {
    const res=await api.get<{data:{title:string;description:string;difficulty:string;samples:typeof samples.value;runtime_config:Runtime;tags:{id:string}[];visibility:"public" | "private"}}>(`/api/v1/problems/${props.problemId}`)
    const filesResponse=await api.get<{data:{updated_at:string;files:{path:string;size:number}[]}}>(`/api/v1/problems/oi-author/${props.problemId}/files`)
    fileList.value=filesResponse.data.files;updatedAt.value=filesResponse.data.updated_at
    const data=res.data;title.value=data.title;description.value=data.description;difficulty.value=data.difficulty;samples.value=data.samples??[];tagIds.value=data.tags.map((tag)=>tag.id);visibility.value=data.visibility
    runtime.value={...data.runtime_config,subtasks:data.runtime_config.subtasks.map((item)=>({...item,scoring:["min","max","sum"].includes(item.scoring)?item.scoring:"min",depends_on:item.depends_on??[],cases:item.cases.map((test,index)=>({...test,id:test.id??`${item.id}_${index+1}`}))}))}
  } catch(err) {error.value=extractApiError(err).message} finally {loading.value=false}
})
</script>

<template>
  <div v-if="loading" class="py-12 text-center text-text-secondary">加载题目…</div>
  <div v-else class="space-y-5 rounded-md border border-border bg-panel p-5">
    <UAlert v-if="error" color="error" :description="error" />
    <UFormField label="标题" required><UInput v-model="title" class="w-full" /></UFormField>
    <div class="grid gap-3 sm:grid-cols-2"><UFormField label="难度"><USelect v-model="difficulty" :items="[{label:'简单',value:'easy'},{label:'中等',value:'medium'},{label:'困难',value:'hard'}]" class="w-full" /></UFormField><UFormField v-if="initialType === 'U'" label="可见性"><USelect v-model="visibility" :items="[{label:'公开',value:'public'},{label:'私有',value:'private'}]" class="w-full" /></UFormField></div>
    <UFormField label="题面" required><MarkdownEditor v-model="description" /></UFormField>
    <UFormField label="标签"><USelectMenu v-model="tagIds" multiple searchable :items="tagOptions" value-key="value" placeholder="选择题目标签或算法标签" class="w-full" /></UFormField>
    <ProblemSampleEditor v-model="samples" v-model:statement="description" />
    <section class="space-y-3 border-t border-border pt-4">
      <div class="flex flex-wrap gap-2"><UButton variant="outline" :loading="fileLoading" @click="uploadInput?.click()">导入 Hydro／NOJ 题目包</UButton><UButton variant="outline" @click="dataInput?.click()">上传数据文件</UButton><UButton variant="ghost" @click="previewPairs">自动配对预览</UButton></div>
      <details class="rounded-md border border-border p-3 text-xs text-text-secondary"><summary class="cursor-pointer font-medium text-text">题目包格式说明</summary><div class="mt-3 grid gap-3 sm:grid-cols-2"><div><p class="mb-2 font-semibold">Hydro 题目包</p><pre class="overflow-auto rounded bg-sunken p-2">problem.yaml       # 标题等元数据
problem.md         # 题面
testdata/
  config.yaml      # 时空限制、子任务、checker
  1.in
  1.out            # 也支持 .ans</pre></div><div><p class="mb-2 font-semibold">NOJ OI 题目包</p><pre class="overflow-auto rounded bg-sunken p-2">problem.json       # judge_type: oi、runtime_config
statement.md       # 题面
config.yaml        # 可选 OI 配置
testdata/
  1.in
  1.out</pre></div></div><p class="mt-3">ZIP 可以直接包含这些文件，也可以套在唯一外层目录中。输入、答案和 checker 的路径相对于解析后的题目包根目录，不能填写本机绝对路径。仅数据文件请使用「上传数据文件」。</p><p class="mt-2">ZIP 上限 128 MiB；单文件 64 MiB；解压总量 512 MiB，最多 1000 个条目。原始 ZIP 不长期保存。</p></details>
      <input ref="uploadInput" type="file" accept=".zip" class="hidden" @change="previewPackage" /><input ref="dataInput" type="file" multiple class="hidden" @change="addData" />
      <UAlert v-if="previewError" color="warning" :description="previewError" />
      <div v-if="pendingImport" class="space-y-2 rounded border border-border p-3 text-sm"><p>导入预览：{{pendingImport.manifest.title}} · {{pendingImport.files.length}} 个文件。应用后仍需保存才会发布。</p><UButton size="sm" @click="applyImport">应用导入</UButton><UButton size="sm" variant="ghost" @click="pendingImport=null">取消</UButton></div>
      <div v-if="pairs.length" class="rounded border border-border p-3 text-xs"><p>将添加到当前子任务：</p><p v-for="item in pairs" :key="item.id">{{item.input}} → {{item.output}}</p><UButton size="sm" class="mt-2" @click="applyPairs">应用配对</UButton></div>
      <div class="grid gap-3 lg:grid-cols-[200px_1fr]"><div class="max-h-80 space-y-1 overflow-auto"><div v-for="file in visibleFiles" :key="file.path" class="flex items-center gap-1"><UButton size="xs" variant="ghost" class="min-w-0 flex-1 justify-start" @click="editFile(file.path)"><span class="truncate">{{file.path}}</span></UButton><UButton size="xs" variant="ghost" color="error" icon="i-lucide-trash-2" aria-label="删除数据文件" @click="removeFile(file.path)" /></div></div><div v-if="selectedPath" class="min-w-0 space-y-2"><p class="text-xs font-mono">{{selectedPath}}</p><MonacoEditor v-if="fileEditable" v-model="fileText" language="plaintext" :min-height="240" @update:model-value="recordEdit" /><UButton v-if="problemId && !packageFile" size="xs" variant="outline" :to="`/api/v1/problems/oi-author/${problemId}/file?download=1&path=${encodeURIComponent(selectedPath)}`" external>下载原文件</UButton></div></div>
    </section>
    <section class="space-y-3 border-t border-border pt-4">
      <h2 class="font-semibold">OI 评测配置</h2><p class="text-xs text-text-secondary">WASM 使用内置统一标准，参考毫秒表示固定工作量。</p>
      <div class="grid gap-3 sm:grid-cols-3"><UFormField label="后端"><USelect v-model="runtime.backend" :items="[{label:'oi-wasm（推荐）',value:'wasm'},{label:'oi-native',value:'native'}]" class="w-full" /></UFormField><UFormField label="时限（ms）"><UInput v-model.number="runtime.time_limit_ms" type="number" class="w-full" /></UFormField><UFormField label="内存（MiB）"><UInput v-model.number="runtime.memory_limit_mb" type="number" class="w-full" /></UFormField></div>
      <UFormField label="允许的语言"><USelectMenu v-model="runtime.languages" multiple :items="[{label:'C99',value:'c'},{label:'C++11',value:'cc'}]" value-key="value" class="w-full" /></UFormField>
      <div class="grid gap-3 sm:grid-cols-2"><UFormField label="比较器"><USelect v-model="runtime.checker.type" :items="[{label:'default · 忽略空白',value:'default'},{label:'strict · 逐字节比较',value:'strict'},{label:'testlib · 自定义比较器',value:'testlib'}]" class="w-full" @update:model-value="runtime.checker.type !== 'testlib' && delete runtime.checker.path" /></UFormField><UFormField v-if="runtime.checker.type==='testlib'" label="checker 路径"><UInput v-model="runtime.checker.path" class="w-full" /></UFormField><UFormField label="文件 IO 前缀（留空为标准 IO）"><UInput v-model="runtime.filename" class="w-full" @blur="!runtime.filename && delete runtime.filename" /></UFormField></div>
    </section>
    <div class="rounded-md bg-sunken p-3 text-xs text-text-secondary"><p><strong>default：</strong>按空白分隔的 token 比较，忽略空格数量、制表符及换行差异；token 内容仍须一致。</p><p class="mt-1"><strong>strict：</strong>逐字节比较，空格、换行及末尾换行不同都会判错。</p><p class="mt-1"><strong>testlib：</strong>运行题目提供的 checker，可处理多解、误差容忍及部分分，需要填写包内 checker 源码路径。</p><p class="mt-1">以上用于正式评测；自测始终使用忽略行末空白的文本比较。</p></div>
    <section class="space-y-3 border-t border-border pt-4">
      <div class="flex items-center justify-between"><h2 class="font-semibold">子任务与测试点</h2><UButton size="sm" variant="outline" icon="i-lucide-plus" @click="addSubtask">新增子任务</UButton></div>
      <p class="text-xs text-text-secondary">整题求和，声明满分 {{ total }}。min 零分和 max 满分可短路；依赖要求前置子任务 AC。</p>
      <div class="grid gap-4 lg:grid-cols-[180px_1fr]">
        <nav class="space-y-1" aria-label="子任务"><UButton v-for="(item,index) in runtime.subtasks" :key="item.id" :variant="index===activeSubtask?'soft':'ghost'" class="w-full justify-start" @click="activeSubtask=index">{{ item.id }} · {{ item.score }} 分</UButton></nav>
        <div v-if="current" class="min-w-0 space-y-3 rounded-md border border-border p-3">
          <div class="flex flex-wrap gap-2"><UButton size="xs" variant="ghost" :disabled="activeSubtask===0" @click="moveSubtask(-1)">上移</UButton><UButton size="xs" variant="ghost" :disabled="activeSubtask===runtime.subtasks.length-1" @click="moveSubtask(1)">下移</UButton><UButton size="xs" color="error" variant="ghost" :disabled="runtime.subtasks.length===1" @click="removeSubtask">删除子任务</UButton></div>
          <div class="grid gap-3 sm:grid-cols-3"><UFormField label="ID"><UInput v-model="current.id" class="w-full" /></UFormField><UFormField label="分数"><UInput v-model.number="current.score" type="number" class="w-full" /></UFormField><UFormField label="计分方式"><USelect v-model="current.scoring" :items="['min','max','sum']" class="w-full" /></UFormField></div>
          <div class="flex gap-2"><USelect v-model="moveTarget" :items="runtime.subtasks.filter(item=>item!==current).map(item=>item.id)" placeholder="移动到子任务" /><UButton size="sm" variant="outline" :disabled="!selectedCases.length || !moveTarget" @click="moveCases">移动选中测试点</UButton></div><UFormField label="依赖子任务"><USelectMenu v-model="current.depends_on" multiple :items="runtime.subtasks.filter(item=>item!==current).map(item=>item.id)" class="w-full" /></UFormField>
          <div class="grid gap-3 sm:grid-cols-2"><UFormField label="子任务时限覆盖（ms）"><UInput v-model.number="current.time_limit_ms" type="number" class="w-full" /></UFormField><UFormField label="子任务内存覆盖（MiB）"><UInput v-model.number="current.memory_limit_mb" type="number" class="w-full" /></UFormField></div>
          <p class="text-xs text-text-secondary">请输入测试数据包／题目包内的相对路径，例如 testdata/1.in 和 testdata/1.out。</p>
          <div class="overflow-x-auto"><table class="w-full text-left text-xs"><thead><tr><th class="p-2">选择</th><th class="p-2">输入文件</th><th class="p-2">答案文件</th><th class="p-2">分数</th><th class="p-2">操作</th></tr></thead><tbody><tr v-for="(test,index) in current.cases" :key="test.id" class="border-t border-border"><td class="p-2"><UCheckbox :model-value="selectedCases.includes(test.id)" aria-label="选择测试点" @update:model-value="$event?selectedCases.push(test.id):selectedCases=selectedCases.filter(id=>id!==test.id)" /></td><td class="p-2"><UInput v-model="test.input" size="xs" placeholder="请输入包内路径，如 testdata/1.in" /><UButton size="xs" variant="ghost" @click="editFile(test.input)">编辑</UButton></td><td class="p-2"><UInput v-model="test.output" size="xs" placeholder="请输入包内路径，如 testdata/1.out" /><UButton size="xs" variant="ghost" @click="editFile(test.output)">编辑</UButton></td><td class="p-2"><UInput v-model.number="test.score" type="number" size="xs" :placeholder="String(maximums[index])" @blur="(test.score as unknown)==='' && delete test.score" /></td><td class="p-2"><UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" :disabled="current.cases.length===1" aria-label="删除测试点" @click="current.cases.splice(index,1)" /></td></tr></tbody></table></div>
          <UButton size="sm" variant="outline" @click="current.cases.push(newCase())">添加测试点</UButton>
        </div>
      </div>
    </section>
    <div class="flex justify-end border-t border-border pt-4"><UButton :loading="saving" @click="save">保存题目</UButton></div>
  </div>
</template>
