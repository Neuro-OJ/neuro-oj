<script setup lang="ts">
import { NuxtLink } from '#components';
import { userAvatarSrc, userIdentityLabel } from '~/utils/user-identity';
import type { UserSummary } from '~/utils/user-identity';
import { userUrl } from '~/utils/publicIdentifiers';
const props = withDefaults(defineProps<{
    user: UserSummary;
    domain?: string | null;
    showUsername?: boolean;
    showAvatar?: boolean;
    size?: 'xs' | 'sm' | 'md' | 'lg';
    link?: boolean;
    to?: import('vue-router').RouteLocationRaw;
    loadAvatarWhenUnknown?: boolean;
}>(), {
    showUsername: true,
    showAvatar: true,
    size: 'md',
    link: true,
    loadAvatarWhenUnknown: false,
});

const workspace = useOptionalWorkspace();
const domainContext = computed(() => props.domain === undefined ? workspace?.slug.value : props.domain);
const label = computed(() => userIdentityLabel(props.user, domainContext.value));
const linked = computed(() => props.link && props.user.state !== 'deleted' && !!props.user.username);
const avatar = computed(() => userAvatarSrc(props.user, props.loadAvatarWhenUnknown));
const initial = computed(() => Array.from(props.user.state === 'deleted' ? '注销' : props.user.username || '?')[0]!.toLocaleUpperCase());
const sizes = { xs: 'size-4', sm: 'size-6', md: 'size-8', lg: 'size-16' } as const;
</script>

<template>
  <component :is="linked ? NuxtLink : 'span'" :to="linked ? to ?? userUrl(user.username) : undefined"
    :aria-label="!showUsername ? label : undefined" :title="label"
    class="inline-flex min-w-0 max-w-full items-center gap-2 rounded no-underline"
    :class="linked ? 'hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary' : ''">
    <UAvatar v-if="showAvatar" :key="`${user.id}:${avatar ?? ''}`" :src="avatar" :alt="showUsername ? '' : label"
      :text="initial" :aria-hidden="showUsername ? true : undefined" loading="lazy" color="primary"
      :class="['shrink-0', sizes[size]]" />
    <span v-if="showUsername" class="min-w-0 truncate text-sm text-inherit">{{ label }}</span>
  </component>
</template>
