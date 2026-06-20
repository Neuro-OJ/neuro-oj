<template>
    <div>
        <section class="hero">
            <div class="container">
                <div class="hero-content">
                    <h1 class="hero-title">
                        面向 <span class="highlight">LMCC</span> 的<br>在线评测系统
                    </h1>
                    <p class="hero-subtitle">
                        Neuro OJ 是一个专为 CCF 大语言模型能力认证（LMCC）设计的在线评测平台，
                        提供高效的代码评测服务和智能化的能力评估。
                    </p>
                    <div class="hero-actions">
                        <NuxtLink to="/register" class="btn btn-primary btn-lg">立即开始</NuxtLink>
                        <NuxtLink to="/problems" class="btn btn-outline btn-lg">浏览题库</NuxtLink>
                    </div>

                    <!-- TODO 考虑删除 -->
                    <div class="hero-stats">
                        <div class="stat">
                            <span class="stat-value">--</span>
                            <span class="stat-label">题目</span>
                        </div>
                        <div class="stat">
                            <span class="stat-value">--</span>
                            <span class="stat-label">用户</span>
                        </div>
                        <div class="stat">
                            <span class="stat-value">--</span>
                            <span class="stat-label">提交</span>
                        </div>
                    </div>
                </div>

                <div class="hero-visual">
                    <div class="code-block">
                        <div class="code-header">
                            <span class="dot red" />
                            <span class="dot yellow" />
                            <span class="dot green" />
                            <span class="code-title">solution.py</span>
                        </div>
                        <pre class="code-body">
                            <code>
<span class="cm"># -*- coding: utf-8 -*-</span>
<span class="sd">"""</span>
<span class="sd">T0（CSP）考生实现文件</span>
<span class="sd"></span>
<span class="sd">你只需要实现一个函数：</span>
<span class="sd">- normalize_gate_report_csp</span>
<span class="sd"></span>
<span class="sd">当前文件是赛后参考答案实现，用于对照考生实现区域中的关键逻辑。</span>
<span class="sd">"""</span>

<span class="kw">from</span> __future__ <span class="kw">import</span> annotations

<span class="kw">import</span> json


<span class="kw">def</span> <span class="fn">normalize_gate_report_csp</span>(text: <span class="builtin">str</span>) -> <span class="builtin">str</span>:
    <span class="sd">"""</span>
<span class="sd">    输入：自然语言舱门报码</span>
<span class="sd">    输出：一行 JSON 字符串，例如：</span>
<span class="sd">    {"gate_id":"E-07","status":"fault"}</span>
<span class="sd">    """</span>
    <span class="cm"># ======== 考生实现区域（可修改） ========</span>

    <span class="cm"># ======== 考生实现区域（可修改） ========</span>
                            </code>
                        </pre>
                    </div>
                </div>
            </div>
        </section>

        <!-- TODO 是否要增加内容 -->
    </div>
</template>

<style scoped>
/* Hero */
.hero {
    position: relative;
    min-height: calc(100vh - 64px);
    padding: 80px 0;
    background: linear-gradient(135deg, var(--c-bg-dark) 0%, #1a2a4a 50%, #1e3a6a 100%);
    background-size: 200% 200%;
    animation: gradientShift 12s ease infinite;
    color: var(--c-white);
    overflow: hidden;
    display: flex;
    align-items: center;
}

.hero::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
        radial-gradient(circle at 20% 50%, rgba(59, 130, 246, 0.08) 0%, transparent 50%),
        radial-gradient(circle at 80% 20%, rgba(59, 130, 246, 0.05) 0%, transparent 50%),
        radial-gradient(circle at 60% 80%, rgba(59, 130, 246, 0.06) 0%, transparent 50%);
    pointer-events: none;
}

.hero::after {
    content: "";
    position: absolute;
    inset: 0;
    background-image: linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
    background-size: 60px 60px;
    pointer-events: none;
}

.hero .container {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 64px;
}



.hero-content {
    flex: 1;
    min-width: 0;
    animation: fadeInUp 0.8s ease both;
}

.hero-title {
    font-size: 48px;
    font-weight: 800;
    line-height: 1.2;
    margin-bottom: 20px;
    animation: fadeInUp 0.6s ease 0.1s both;
}

.highlight {
    color: var(--c-primary-light);
    display: inline-block;
    animation: glow 2s ease-in-out infinite alternate;
}



.hero-subtitle {
    font-size: 18px;
    line-height: 1.7;
    color: var(--c-text-muted);
    margin-bottom: 32px;
    max-width: 520px;
    animation: fadeInUp 0.6s ease 0.2s both;
}

.hero-actions {
    display: flex;
    gap: 16px;
    margin-bottom: 48px;
    animation: fadeInUp 0.6s ease 0.3s both;
}



.btn-lg {
    padding: 14px 32px;
    font-size: 16px;
}

.btn-outline {
    color: var(--c-white);
    border: 1.5px solid rgba(255, 255, 255, 0.3);
    background: transparent;
}

.btn-outline:hover {
    border-color: var(--c-white);
}

.hero-stats {
    display: flex;
    gap: 48px;
    animation: fadeInUp 0.6s ease 0.5s both;
}

.stat {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.stat-value {
    font-size: 28px;
    font-weight: 700;
    color: var(--c-white);
}

.stat-label {
    font-size: 14px;
    color: var(--c-text-muted);
}

.hero-visual {
    flex: 1;
    min-width: 0;
    animation: fadeInUp 0.8s ease 0.4s both;
}

.code-block {
    background: #0d1117;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
    animation: float 4s ease-in-out infinite;
}

.code-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 16px;
    background: #161b22;
}

.dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
}

.dot.red { background: #ff5f56; }
.dot.yellow { background: #ffbd2e; }
.dot.green { background: #27c93f; }

.code-title {
    margin-left: 8px;
    font-size: 13px;
    color: #8b949e;
}

.code-body {
    padding: 16px;
    font-size: 12px;
    line-height: 1.5;
    overflow-x: auto;
}

.code-body code {
    font-family: "SF Mono", "Fira Code", "Fira Mono", monospace;
}

.kw { color: #ff7b72; }
.fn { color: #d2a8ff; }
.builtin { color: #79c0ff; }
.sd { color: #7ee787; }
.cm { color: #8b949e; }

/* CTA */
.cta {
    padding: 96px 0;
    background: linear-gradient(135deg, var(--c-primary) 0%, var(--c-primary-dark) 100%);
    color: var(--c-white);
    text-align: center;
}

.cta h2 {
    font-size: 40px;
    font-weight: 800;
    margin-bottom: 12px;
}

.cta p {
    font-size: 18px;
    opacity: 0.9;
    margin-bottom: 32px;
}

.cta .btn-primary {
    background: var(--c-white);
    color: var(--c-primary);
    border-color: var(--c-white);
}

.cta .btn-primary:hover {
    background: #f0f0f0;
}

/* Responsive */
@media (max-width: 768px) {
    .hero {
        padding: 48px 0;
    }

    .hero .container {
        flex-direction: column;
        gap: 40px;
    }

    .hero-title {
        font-size: 32px;
    }

    .hero-actions {
        flex-direction: column;
    }

    .hero-stats {
        gap: 24px;
    }

    .hero-visual {
        display: none;
    }
}
</style>
