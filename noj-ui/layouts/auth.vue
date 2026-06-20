<template>
    <div class="layout">
        <Navbar />
        <main class="main">
            <slot />
        </main>
        <FooterBar />
    </div>
</template>

<style scoped>
.layout {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
}

.main {
    flex: 1;
    min-height: calc(100vh - 64px);
    padding: 48px 24px;
    display: flex;
    align-items: center;
    justify-content: center;
}
</style>
