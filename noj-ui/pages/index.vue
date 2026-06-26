<template>
    <div>
        <section class="hero-section relative min-h-[calc(100vh-64px)] py-12 md:py-20 bg-gradient-to-br from-bg-dark via-[#1a2a4a] to-[#1e3a6a] bg-[length:200%_200%] text-white overflow-hidden flex items-center animate-[gradientShift_12s_ease_infinite]">
            <!-- 伪元素背景由 style scoped 实现 -->
            <div class="relative z-[1] flex-col md:flex-row items-center gap-10 md:gap-16 w-full" style="max-width:1200px;margin:0 auto;padding:0 24px">
                <div class="flex-1 min-w-0 animate-[fadeInUp_0.8s_ease_both]">
                    <h1 class="text-[32px] md:text-5xl font-extrabold leading-tight mb-5 animate-[fadeInUp_0.6s_ease_0.1s_both]">
                        面向 <span class="text-primary-light inline-block animate-[glow_2s_ease-in-out_infinite_alternate]">LMCC</span> 的<br>在线评测系统
                    </h1>
                    <p class="text-lg leading-relaxed text-text-muted mb-8 max-w-[520px] animate-[fadeInUp_0.6s_ease_0.2s_both]">
                        Neuro OJ 是一个专为 CCF 大语言模型能力认证（LMCC）设计的在线评测平台，
                        提供高效的代码评测服务和智能化的能力评估。
                    </p>
                    <div class="flex flex-col md:flex-row gap-4 mb-12 animate-[fadeInUp_0.6s_ease_0.3s_both]">
                        <NuxtLink to="/register" class="inline-flex items-center justify-center font-semibold no-underline cursor-pointer rounded-lg transition-all duration-200 px-8 py-3.5 text-base bg-primary text-white border border-primary hover:bg-primary-dark hover:border-primary-dark">立即开始</NuxtLink>
                        <NuxtLink to="/problems" class="inline-flex items-center justify-center font-semibold no-underline cursor-pointer rounded-lg transition-all duration-200 px-8 py-3.5 text-base text-white bg-transparent border border-white/30 hover:border-white">浏览题库</NuxtLink>
                    </div>

                    <div class="flex gap-6 md:gap-12 animate-[fadeInUp_0.6s_ease_0.5s_both]">
                        <div class="flex flex-col gap-1">
                            <span class="text-[28px] font-bold text-white">--</span>
                            <span class="text-sm text-text-muted">题目</span>
                        </div>
                        <div class="flex flex-col gap-1">
                            <span class="text-[28px] font-bold text-white">--</span>
                            <span class="text-sm text-text-muted">用户</span>
                        </div>
                        <div class="flex flex-col gap-1">
                            <span class="text-[28px] font-bold text-white">--</span>
                            <span class="text-sm text-text-muted">提交</span>
                        </div>
                    </div>
                </div>

                <div class="flex-1 min-w-0 animate-[fadeInUp_0.8s_ease_0.4s_both] max-md:hidden">
                    <div class="bg-[#0d1117] rounded-xl overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.4)] animate-[float_4s_ease-in-out_infinite]">
                        <div class="flex items-center gap-1.5 px-4 py-3 bg-[#161b22]">
                            <span class="size-2.5 rounded-full bg-[#ff5f56]" />
                            <span class="size-2.5 rounded-full bg-[#ffbd2e]" />
                            <span class="size-2.5 rounded-full bg-[#27c93f]" />
                            <span class="ml-2 text-xs text-[#8b949e]">solution.py</span>
                        </div>
                        <pre class="p-4 text-xs leading-relaxed overflow-x-auto"><code class="font-mono">
<span class="text-[#ff7b72]">from</span> __future__ <span class="text-[#ff7b72]">import</span> annotations

<span class="text-[#ff7b72]">import</span> json


<span class="text-[#ff7b72]">def</span> <span class="text-[#d2a8ff]">normalize_gate_report_csp</span>(text: <span class="text-[#79c0ff]">str</span>) -> <span class="text-[#79c0ff]">str</span>:
    <span class="text-[#7ee787]">"""</span>
<span class="text-[#7ee787]">    输入：自然语言舱门报码</span>
<span class="text-[#7ee787]">    输出：一行 JSON 字符串</span>
<span class="text-[#7ee787]">    """</span>
    <span class="text-[#8b949e]"># ======== 考生实现区域 ========</span>

    <span class="text-[#8b949e]"># ======== 考生实现区域 ========</span>
                        </code></pre>
                    </div>
                </div>
            </div>
        </section>
    </div>
</template>

<style scoped>
/* 伪元素：径向光晕和网格 */
.hero-section::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
        radial-gradient(circle at 20% 50%, rgba(59, 130, 246, 0.08) 0%, transparent 50%),
        radial-gradient(circle at 80% 20%, rgba(59, 130, 246, 0.05) 0%, transparent 50%),
        radial-gradient(circle at 60% 80%, rgba(59, 130, 246, 0.06) 0%, transparent 50%);
    pointer-events: none;
}

.hero-section::after {
    content: "";
    position: absolute;
    inset: 0;
    background-image: linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
    background-size: 60px 60px;
    pointer-events: none;
}
</style>
