<script setup lang="ts">
</script>
<template>
    <div class="layout">
        <Navbar />
        <div class="body-area">
            <main class="main">
                <slot />
            </main>
        </div>
        <FooterBar />
    </div>
</template>

<style>
.layout {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    width: 100%;
    overflow-x: hidden;
}

.body-area {
    display: flex;
    flex: 1;
    min-height: calc(100vh - 64px);
    width: 100%;
    padding-top: 64px;
}

.main {
    flex: 1;
    min-width: 0;
    width: 100%;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 24px;
}

.btn {
    border-radius: 8px;
    font-weight: 600;
    text-decoration: none;
    transition: all 0.2s;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.btn-primary {
    background: var(--c-primary);
    color: var(--c-white);
    border: 1.5px solid var(--c-primary);
}

.btn-primary:hover {
    background: var(--c-primary-dark);
    border-color: var(--c-primary-dark);
}
</style>

<style>
@keyframes gradientShift {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
}

@keyframes glow {
    from { text-shadow: 0 0 8px rgba(59, 130, 246, 0.3); }
    to { text-shadow: 0 0 20px rgba(59, 130, 246, 0.7); }
}

@keyframes fadeInUp {
    from {
        opacity: 0;
        transform: translateY(24px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-10px); }
}
</style>
