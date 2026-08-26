<template>
    <footer class="bg-bg-dark text-text-on-dark px-0 py-12 pb-6">
        <div class="mx-auto w-full max-w-[1200px] px-6">
            <div class="flex justify-between gap-12 flex-wrap">
                <div class="max-w-[280px]">
                    <div class="flex items-center gap-2 text-xl font-bold text-white">
                        <UIcon name="i-lucide-brain" class="size-[22px] size-4" />
                        <span>Neuro OJ</span>
                    </div>
                    <p class="mt-2 text-sm leading-relaxed">面向 AI 领域认证与竞赛的在线评测平台</p>
                </div>
                <div class="flex gap-12">
                    <div class="footer-section">
                        <h4 class="text-white text-xs font-semibold mb-3 uppercase tracking-[0.5px]">了解我们</h4>
                        <NuxtLink to="/about" class="block text-text-on-dark no-underline text-sm mb-2 transition-colors hover:text-primary-light">关于</NuxtLink>
                        <a href="https://github.com/Neuro-OJ/neuro-oj" target="_blank" rel="noopener" class="block text-text-on-dark no-underline text-sm mb-2 transition-colors hover:text-primary-light">GitHub</a>
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
const year = new Date().getFullYear()
</script>
