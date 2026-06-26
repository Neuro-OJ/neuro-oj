<template>
    <footer class="bg-bg-dark text-text-muted px-0 py-12 pb-6">
        <div class="mx-auto w-full" style="max-width:1200px;padding:0 24px">
            <div class="flex justify-between gap-12 flex-wrap">
                <div class="max-w-[280px]">
                    <div class="flex items-center gap-2 text-xl font-bold text-white">
                        <Brain class="size-[22px]" />
                        <span>Neuro OJ</span>
                    </div>
                    <p class="mt-2 text-sm leading-relaxed">面向 LMCC 的在线评测系统</p>
                </div>
                <div class="flex gap-12">
                    <div class="footer-section">
                        <h4 class="text-white text-xs font-semibold mb-3 uppercase tracking-[0.5px]">了解我们</h4>
                        <NuxtLink to="/about" class="block text-text-muted no-underline text-sm mb-2 transition-colors hover:text-primary-light">关于</NuxtLink>
                        <a href="https://github.com/Neuro-OJ/neuro-oj" target="_blank" rel="noopener" class="block text-text-muted no-underline text-sm mb-2 transition-colors hover:text-primary-light">GitHub</a>
                    </div>
                </div>
            </div>
            <div class="mt-8 pt-4 border-t border-bg-dark-2 text-xs text-center">
                <p>&copy; {{ year }} Neuro OJ. 独立社区项目，与 CCF 及 LMCC 无官方关系。</p>
            </div>
        </div>
    </footer>
</template>

<script setup lang="ts">
import { Brain } from "@lucide/vue"

const year = new Date().getFullYear()
</script>
