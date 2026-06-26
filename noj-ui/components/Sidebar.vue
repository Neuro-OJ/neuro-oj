<template>
    <aside class="group fixed top-16 left-0 flex flex-col w-15 h-[calc(100vh-64px)] bg-white border-r border-border z-99 overflow-hidden whitespace-nowrap transition-[width] duration-250 ease-out hover:w-[200px]">
        <div class="flex-1 p-4 px-2">
            <nav class="flex flex-col gap-1">
                <NuxtLink to="/" class="flex items-center gap-3 p-2.5 rounded-lg no-underline text-text-secondary text-sm font-medium transition-colors hover:bg-primary-hover-bg hover:text-primary">
                    <House class="size-5 min-w-5" />
                    <span class="opacity-0 group-hover:opacity-100 transition-opacity duration-150">首页</span>
                </NuxtLink>
                <NuxtLink to="/problems" class="flex items-center gap-3 p-2.5 rounded-lg no-underline text-text-secondary text-sm font-medium transition-colors hover:bg-primary-hover-bg hover:text-primary">
                    <FileText class="size-5 min-w-5" />
                    <span class="opacity-0 group-hover:opacity-100 transition-opacity duration-150">题库</span>
                </NuxtLink>
            </nav>
        </div>
        <div class="p-2 border-t border-border">
            <nav class="flex flex-col gap-1">
                <NuxtLink to="/about" class="flex items-center gap-3 p-2.5 rounded-lg no-underline text-text-secondary text-sm font-medium transition-colors hover:bg-primary-hover-bg hover:text-primary">
                    <Info class="size-5 min-w-5" />
                    <span class="opacity-0 group-hover:opacity-100 transition-opacity duration-150">关于</span>
                </NuxtLink>
            </nav>
        </div>
    </aside>
</template>

<script setup lang="ts">
import { House, FileText, Info } from "@lucide/vue"
</script>
