<template>
    <footer class="footer">
        <div class="container">
            <div class="footer-content">
                <div class="footer-brand">
                      <div class="footer-logo">
                        <Brain class="footer-logo-icon" />
                        <span>Neuro OJ</span>
                      </div>
                      <p class="footer-desc">面向 LMCC 的在线评测系统</p>
                </div>
                <div class="footer-links">
                    <div class="footer-section">
                        <h4>了解我们</h4>
                        <NuxtLink to="/about">关于</NuxtLink>
                        <a href="https://github.com/Neuro-OJ/neuro-oj" target="_blank" rel="noopener">GitHub</a>
                    </div>
                </div>
            </div>
            <div class="footer-bottom">
                <p>&copy; {{ year }} Neuro OJ. 独立社区项目，与 CCF 及 LMCC 无官方关系。</p> <!-- TODO 是否修改 -->
            </div>
        </div>
    </footer>
</template>

<script setup lang="ts">
import { Brain } from "@lucide/vue"

// TODO 666
const year = new Date().getFullYear()
</script>

<style scoped>
.footer {
    background: var(--c-bg-dark);
    color: var(--c-text-muted);
    padding: 48px 0 24px;
}

.footer-content {
    display: flex;
    justify-content: space-between;
    gap: 48px;
    flex-wrap: wrap;
}

.footer-brand {
    max-width: 280px;
}

.footer-logo {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 20px;
    font-weight: 700;
    color: var(--c-white);
}

.footer-logo-icon {
    width: 22px;
    height: 22px;
}

.footer-desc {
    margin-top: 8px;
    font-size: 14px;
    line-height: 1.6;
}

.footer-links {
    display: flex;
    gap: 48px;
}

.footer-section h4 {
    color: var(--c-white);
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.footer-section a {
    display: block;
    color: var(--c-text-muted);
    text-decoration: none;
    font-size: 14px;
    margin-bottom: 8px;
    transition: color 0.2s;
}

.footer-section a:hover {
    color: var(--c-primary-light);
}

.footer-bottom {
    margin-top: 32px;
    padding-top: 16px;
    border-top: 1px solid var(--c-bg-dark-2);
    font-size: 13px;
    text-align: center;
}
</style>
