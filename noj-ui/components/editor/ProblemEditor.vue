<script setup lang="ts">
import type { ProblemAuthorFields } from "~/composables/useProblemAuthorFields"
const props = withDefaults(defineProps<{mode: "create" | "edit"; problemId?: string; initialType?: "U" | "P"; initialJudgeType?: "oi" | "dual"}>(), {initialType: "U", initialJudgeType: "dual"})
const emit = defineEmits<{saved: [id: string]}>()
const selected = ref(props.initialJudgeType)
const fields: ProblemAuthorFields = { title: ref(""), description: ref(""), difficulty: ref("medium"), samples: ref([]), tagIds: ref([]), visibility: ref(props.initialType === "P" ? "public" : "private") }
provide("problem-author-fields", fields)
const tabs = computed(() => [{label: "OI 题", value: "oi", icon: "i-lucide-code"}, {label: "AI 题", value: "dual", icon: "i-lucide-brain"}].map((item) => ({...item, disabled: props.mode === "edit" && item.value !== props.initialJudgeType})))
</script>

<template>
  <div class="space-y-4">
    <UTabs v-model="selected" :items="tabs" :content="false" />
    <KeepAlive>
      <OiProblemEditor v-if="selected === 'oi'" :mode="mode" :problem-id="problemId" :initial-type="initialType" @saved="emit('saved', $event)" />
      <CodingProblemEditor v-else :mode="mode" :problem-id="problemId" :initial-type="initialType" @saved="emit('saved', $event)" />
    </KeepAlive>
  </div>
</template>
