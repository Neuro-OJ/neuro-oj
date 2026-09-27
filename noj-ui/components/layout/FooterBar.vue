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

                    <!-- 构建身份：前端（编译进产物）与后端（/site/meta）各三要素。
                         品牌列较窄，故按「标签 | 值」两列排布，值内固定分两行
                         （版本·commit / 构建时间）——断行由我们控制，避免在 `·`
                         之后折行留下孤立的间隔符。
                         三要素均为纯文本（不挂外链），完整 SHA 与 ISO 时间放在 `title`。
                         时间用 ClientOnly 渲染访问者本地时区、SSR 回退 UTC：服务端与
                         浏览器时区不同，直接渲染会造成水合不一致。 -->
                    <dl
                        aria-label="构建信息"
                        class="mt-3 grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1 text-xs text-text-muted"
                    >
                        <template v-for="row in buildRows" :key="row.label">
                            <dt>{{ row.label }}</dt>
                            <dd class="flex flex-col gap-0.5">
                                <div class="flex items-center gap-1.5 tabular-nums">
                                    <span>{{ row.version }}</span>
                                    <span aria-hidden="true">·</span>
                                    <span :title="row.commitFull ?? undefined">{{ row.commit }}</span>
                                </div>
                                <ClientOnly :fallback="row.builtAtUtc">
                                    <span :title="row.builtAtIso ?? undefined" class="tabular-nums">{{ row.builtAtLocal }}</span>
                                </ClientOnly>
                            </dd>
                        </template>
                    </dl>
                </div>

                <!-- 站内导航 -->
                <div>
                    <h4 class="text-text text-xs font-semibold mb-3 uppercase tracking-[0.5px]">站内导航</h4>
                    <NuxtLink to="/problems" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">题库</NuxtLink>
                    <NuxtLink to="/contests" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">竞赛</NuxtLink>
                    <NuxtLink to="/community" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">社区</NuxtLink>
                    <NuxtLink to="/data-policy" class="block text-text-secondary text-sm mb-2 hover:text-primary">数据使用与注销说明</NuxtLink>
                    <NuxtLink to="/legal/privacy" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">隐私政策</NuxtLink>
                    <NuxtLink to="/legal/terms" class="block text-text-secondary no-underline text-sm mb-2 transition-colors hover:text-primary">服务条款</NuxtLink>
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
                <!-- 备案信息：未配置时不渲染（见 buildFilingLinks） -->
                <template v-if="filingLinks.length > 0">
                    <span class="hidden sm:inline">·</span>
                    <a
                        v-for="link in filingLinks"
                        :key="link.label"
                        :href="link.url"
                        target="_blank"
                        rel="noopener"
                        class="text-text-muted hover:text-primary no-underline"
                    >{{ link.label }}</a>
                </template>
            </div>
        </div>
    </footer>
</template>

<script setup lang="ts">
import { buildFilingLinks, EMPTY_SITE_META } from "~/utils/siteMeta";
import {
    type BuildInfo,
    commitDisplay,
    commitFull,
    formatBuiltAt,
    normalizeVersion,
} from "~/utils/buildInfo";

const year = new Date().getFullYear();

// 备案信息（公开端点，失败静默降级为不展示）
const { api } = useApi();
const { data: metaData } = await useAsyncData("site-meta", () =>
    api.get<{ data: typeof EMPTY_SITE_META }>(
        "/api/v1/site/meta",
        { silent: true },
    ));
const filingLinks = computed(() => buildFilingLinks(metaData.value?.data ?? EMPTY_SITE_META));

/** 空构建身份：字段缺失时统一渲染 `unknown`，而不是整行消失。 */
const EMPTY_BUILD: BuildInfo = { version: "", commit: null, builtAt: null };

/** 前端构建身份：构建期写进 runtimeConfig.public，随产物一起编译。 */
const uiBuild = computed<BuildInfo>(() =>
    (useRuntimeConfig().public.buildInfo as BuildInfo | undefined) ?? EMPTY_BUILD
);

/** 后端构建身份：来自同一份 /site/meta 响应（镜像构建期注入的 ENV）。 */
const coreBuild = computed<BuildInfo>(() => metaData.value?.data.build ?? EMPTY_BUILD);

/**
 * 每行（前端 / 后端）的展示数据。
 *
 * 三要素均为纯文本：版本号与 commit 不挂外链，完整 SHA 与原始 ISO 时间通过 `title`
 * 提供，需要精确核对时仍可取用。
 */
const buildRows = computed(() =>
    ([
        { label: "前端", info: uiBuild.value },
        { label: "后端", info: coreBuild.value },
    ]).map(({ label, info }) => ({
        label,
        version: normalizeVersion(info.version),
        commit: commitDisplay(info.commit),
        commitFull: commitFull(info.commit),
        builtAtLocal: formatBuiltAt(info.builtAt),
        builtAtUtc: formatBuiltAt(info.builtAt, "UTC"),
        builtAtIso: info.builtAt,
    }))
);
</script>
