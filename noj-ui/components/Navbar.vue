<template>
    <header class="navbar">
        <div class="container">
            <NuxtLink to="/" class="logo">
                <img :src="logoSrc" alt="Neuro OJ" class="logo-img" />
                <span class="logo-text">Neuro OJ</span>
            </NuxtLink>
            <nav class="nav-links">
                <NuxtLink to="/" class="nav-link">首页</NuxtLink>
            </nav>
            <div class="nav-actions">
                <NuxtLink to="/login" class="btn btn-outline">登录</NuxtLink>
                <NuxtLink to="/register" class="btn btn-primary">注册</NuxtLink>
            </div>
        </div>
    </header>
</template>

<script setup lang="ts">
import logoSrc from "~/assets/img/logo.jpg"
</script>

<style scoped>
.navbar {
    background: var(--c-white);
    border-bottom: 1px solid var(--c-border);
    position: sticky;
    top: 0;
    z-index: 100;
}

.container {
    padding: 0 24px 0 0;
    margin-left: 60px;
    height: 64px;
    display: flex;
    align-items: center;
}

.logo {
    display: flex;
    align-items: center;
    gap: 8px;
    text-decoration: none;
    font-size: 20px;
    font-weight: 700;
    color: var(--c-primary);
}

.logo-img {
    width: 28px;
    height: 28px;
    border-radius: 6px;
}

.nav-links {
    display: flex;
    align-items: center;
    gap: 32px;
}

.nav-link {
    text-decoration: none;
    color: var(--c-text-secondary);
    font-size: 15px;
    font-weight: 500;
    transition: color 0.2s;
}

.nav-link:hover {
    color: var(--c-primary);
}

.nav-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-left: auto;
}

.btn {
    padding: 8px 20px;
    font-size: 14px;
}

.btn-outline {
    color: var(--c-primary);
    border: 1.5px solid var(--c-primary);
    background: transparent;
}

.btn-outline:hover {
    background: var(--c-primary);
    color: var(--c-white);
}


</style>
