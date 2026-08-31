<template>
    <footer class="bg-bg-page border-t border-border px-0 py-12 pb-6">
        <div class="mx-auto w-full max-w-[1200px] px-6">
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10">
                <!-- 品牌 -->
                <div>
                    <div class="flex items-center gap-2 text-xl font-bold text-primary">
                        <UIcon name="i-lucide-brain" class="size-[22px]" />
                        <span>Neuro OJ</span>
                    </div>
                    <p class="mt-2 text-sm text-text-secondary leading-relaxed">面向 AI 领域认证与竞赛的在线评测平台</p>
                </div>

                <!-- 站内导航 -->
                <div>
                    <h4 class="text-text text-xs font-semibold mb-3 uppercase tracking-[0.5px]">站内导航</h4>
                    <NuxtLink to="/problems" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">题库</NuxtLink>
                    <NuxtLink to="/contests" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">竞赛</NuxtLink>
                    <NuxtLink to="/community" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">社区</NuxtLink>
                    <NuxtLink to="/about" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">关于</NuxtLink>
                </div>

                <!-- 开源 / 文档 -->
                <div>
                    <h4 class="text-text text-xs font-semibold mb-3 uppercase tracking-[0.5px]">开源 / 文档</h4>
                    <a href="https://docs.noj.xyber-nova.space" target="_blank" rel="noopener" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">文档站</a>
                    <a href="https://github.com/Neuro-OJ/neuro-oj" target="_blank" rel="noopener" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">GitHub</a>
                    <a href="https://github.com/Neuro-OJ/neuro-oj/issues" target="_blank" rel="noopener" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">Issues</a>
                    <a href="https://github.com/Neuro-OJ/neuro-oj/blob/main/LICENSE" target="_blank" rel="noopener" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">License</a>
                </div>

                <!-- 社区联系 -->
                <div>
                    <h4 class="text-text text-xs font-semibold mb-3 uppercase tracking-[0.5px]">社区联系</h4>
                    <a href="https://github.com/Neuro-OJ/neuro-oj/discussions" target="_blank" rel="noopener" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">GitHub Discussions</a>
                    <a href="https://github.com/Neuro-OJ/neuro-oj/issues" target="_blank" rel="noopener" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">GitHub Issues</a>
                    <a href="https://qm.qq.com/q/414014391" target="_blank" rel="noopener" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">QQ 群 414014391</a>
                </div>
            </div>

            <div class="mt-8 pt-4 border-t border-border text-xs text-text-muted text-center flex flex-col sm:flex-row items-center justify-center gap-1">
                <span>&copy; {{ year }} Neuro OJ. 独立社区项目，与 CCF 及 LMCC 无官方关系。</span>
                <a href="https://github.com/Neuro-OJ/neuro-oj/blob/main/LICENSE" target="_blank" rel="noopener" class="text-text-muted hover:text-primary no-underline">AGPL-3.0</a>
            </div>
        </div>
    </footer>
</template>

<script setup lang="ts">
const year = new Date().getFullYear()
</script>
