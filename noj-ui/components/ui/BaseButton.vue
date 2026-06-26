<script setup lang="ts">
import { Loader2 } from "@lucide/vue"
type Variant = "primary" | "outline" | "ghost" | "danger"
type Size = "sm" | "md" | "lg"
const props = withDefaults(defineProps<{ variant?: Variant; size?: Size; loading?: boolean; disabled?: boolean; to?: string; href?: string }>(), { variant: "primary", size: "md" })
defineEmits<{ click: [e: MouseEvent] }>()
const vc: Record<Variant, string> = { primary: "bg-primary text-white border-primary hover:bg-primary-dark", outline: "bg-transparent text-primary border-primary hover:bg-primary hover:text-white", ghost: "bg-transparent text-text-secondary border-transparent hover:bg-gray-100", danger: "bg-error text-white border-error hover:bg-red-600" }
const sc: Record<Size, string> = { sm: "px-3 py-1.5 text-xs gap-1", md: "px-4 py-2 text-sm gap-1.5", lg: "px-6 py-2.5 text-base gap-2" }
const cls = computed(() => { const b = "inline-flex items-center justify-center font-semibold rounded-md border transition-all duration-150 cursor-pointer no-underline"; const s = (props.loading || props.disabled) ? "opacity-50 cursor-not-allowed pointer-events-none" : ""; return [b, vc[props.variant], sc[props.size], s].join(" ") })
</script>
<template>
  <NuxtLink v-if="to && !disabled && !loading" :to="to" :class="cls"><Loader2 v-if="loading" :size="16" class="animate-spin" /><slot /></NuxtLink>
  <a v-else-if="href && !disabled && !loading" :href="href" target="_blank" rel="noopener" :class="cls"><Loader2 v-if="loading" :size="16" class="animate-spin" /><slot /></a>
  <button v-else :class="cls" :disabled="disabled || loading"><Loader2 v-if="loading" :size="16" class="animate-spin" /><slot /></button>
</template>
