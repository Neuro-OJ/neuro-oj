<template>
    <component
        :is="link ? resolveComponent('NuxtLink') : 'span'"
        :to="link ? (to ?? `/users/${user.id}`) : undefined"
        class="inline-flex items-center gap-2 no-underline"
        :class="{ 'cursor-pointer hover:opacity-80': link }"
    >
        <span
            v-if="showAvatar"
            class="relative inline-block shrink-0 rounded-full overflow-hidden"
            :style="{ width: `${sizePx}px`, height: `${sizePx}px` }"
        >
            <img
                v-if="(user.avatar_url || (loadAvatarWhenUnknown && user.avatar_url === undefined)) && !imgFailed"
                :src="`/api/v1/users/${user.id}/avatar`"
                :alt="user.username"
                class="size-full object-cover"
                loading="lazy"
                @error="imgFailed = true"
            />
            <svg v-else viewBox="0 0 40 40" class="size-full" :style="{ backgroundColor: bgColor }" aria-hidden="true">
                <text
                    x="50%" y="54%" text-anchor="middle" dominant-baseline="middle"
                    :fill="fgColor" font-size="18" font-weight="600"
                >{{ initial }}</text>
            </svg>
        </span>
        <span v-if="showUsername" class="truncate text-sm text-text-secondary">{{ user.username }}</span>
    </component>
</template>

<script setup lang="ts">
interface IdentityUser {
    id: string;
    username: string;
    avatar_url?: string | null;
}

const props = withDefaults(defineProps<{
    user: IdentityUser;
    showUsername?: boolean;
    showAvatar?: boolean;
    size?: 'sm' | 'md' | 'lg';
    link?: boolean;
    to?: string;
    loadAvatarWhenUnknown?: boolean;
}>(), {
    showUsername: true,
    showAvatar: true,
    size: 'md',
    link: true,
    loadAvatarWhenUnknown: false,
});

// 图片加载失败 → 兜底切回首字母占位
const imgFailed = ref(false);
watch(
    () => [props.user.id, props.user.avatar_url ?? ""],
    () => { imgFailed.value = false; },
);

const SIZE_MAP = { sm: 24, md: 32, lg: 64 } as const;
const sizePx = computed(() => SIZE_MAP[props.size]);

// 首字母（中文用户名取首个字符，其他取大写首字母）
const initial = computed(() => {
    const name = props.user.username ?? "?";
    return name.charAt(0).toUpperCase();
});

// 按 username 哈希稳定配色（同一用户全站一致）
const hue = computed(() => {
    const name = props.user.username ?? "";
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
});
const bgColor = computed(() => `hsl(${hue.value} 60% 45%)`);
const fgColor = computed(() => `hsl(${hue.value} 60% 95%)`);
</script>
