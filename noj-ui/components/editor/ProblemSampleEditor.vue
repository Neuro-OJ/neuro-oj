<script setup lang="ts">
import type { ProblemSample } from "~/utils/oiWorkspace"
import { extractStatementSamples } from "~/utils/oiWorkspace"
const samples = defineModel<ProblemSample[]>({ required: true })
const statement = defineModel<string>("statement", {default:""})
const extracted = ref<ReturnType<typeof extractStatementSamples> | null>(null)
function importSamples(remove:boolean) {
  if(!extracted.value)return
  for(const sample of extracted.value.samples)if(!samples.value.some(item=>item.input===sample.input && item.output===sample.output))samples.value.push({...sample,id:`sample_${crypto.randomUUID()}`})
  if(remove)statement.value=extracted.value.remaining
  extracted.value=null
}
function move(index: number, delta: number) { const target=index+delta; if(target<0 || target>=samples.value.length)return; [samples.value[index],samples.value[target]]=[samples.value[target]!,samples.value[index]!] }
function add() { samples.value = [...samples.value, { id: `sample_${crypto.randomUUID()}`, input: "", output: "" }] }
</script>

<template>
  <section class="space-y-3">
    <div class="flex items-center justify-between"><h2 class="font-semibold">公开样例</h2><UButton size="sm" variant="outline" icon="i-lucide-plus" @click="add">添加样例</UButton></div>
    <p class="text-xs text-text-secondary">样例在题目页面展示，并作为 OI 自测的默认用例。</p>
    <UButton size="xs" variant="ghost" :disabled="!statement" @click="extracted=extractStatementSamples(statement)">从旧题面提取样例（预览）</UButton>
    <div v-if="extracted" class="space-y-2 rounded border border-border p-3 text-xs"><p>识别到 {{extracted.samples.length}} 组明确配对的样例；其他题面内容保留。</p><div v-for="(sample,index) in extracted.samples" :key="index" class="grid gap-2 sm:grid-cols-2"><pre class="overflow-auto whitespace-pre-wrap rounded bg-sunken p-2">{{sample.input}}</pre><pre class="overflow-auto whitespace-pre-wrap rounded bg-sunken p-2">{{sample.output}}</pre></div><div class="flex flex-wrap gap-2"><UButton size="xs" :disabled="!extracted.samples.length" @click="importSamples(true)">导入并移除原样例段</UButton><UButton size="xs" variant="outline" :disabled="!extracted.samples.length" @click="importSamples(false)">仅添加，保留题面</UButton><UButton size="xs" variant="ghost" @click="extracted=null">取消</UButton></div></div>
    <div v-for="(sample, index) in samples" :key="sample.id" class="space-y-3 rounded-md border border-border p-3">
      <div class="flex items-center justify-between"><span class="text-sm font-medium">样例 {{ index + 1 }}</span><UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" aria-label="删除样例" @click="samples.splice(index, 1)" /></div>
      <div class="grid gap-3 sm:grid-cols-2"><UFormField label="输入"><UTextarea v-model="sample.input" class="w-full font-mono" :rows="4" /></UFormField><UFormField label="预期输出"><UTextarea v-model="sample.output" class="w-full font-mono" :rows="4" /></UFormField></div>
      <UFormField label="样例说明"><UTextarea v-model="sample.explanation" class="w-full" :rows="2" /></UFormField>
      <div class="flex gap-2"><UButton size="xs" variant="ghost" :disabled="index === 0" @click="move(index,-1)">上移</UButton><UButton size="xs" variant="ghost" :disabled="index === samples.length - 1" @click="move(index,1)">下移</UButton></div>
    </div>
  </section>
</template>
