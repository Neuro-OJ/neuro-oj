<template>
    <NuxtLink to="/" class="flex items-center gap-2 no-underline text-xl font-bold text-primary shrink-0">
        <img
            :src="logoSrc"
            :alt="brandName"
            :class="['rounded-md', sizeClass]"
        >
        <span>{{ brandName }}</span>
    </NuxtLink>
</template>

<script setup lang="ts">
import { computed } from "vue"
import defaultLogo from "~/assets/img/logo.jpg"

interface Props {
    /** 品牌名称 */
    brandName?: string
    /** Logo 图片地址 */
    logoSrc?: string
    /** Logo 尺寸（Tailwind size-N，对应 size-N 类） */
    size?: number
}

const props = withDefaults(defineProps<Props>(), {
    brandName: "Neuro OJ",
    logoSrc: defaultLogo,
    size: 7,
})

const sizeClass = computed(() => `size-${props.size}`)
</script>