<template>
  <!-- Dense Workbench：页脚压成状态栏式两行，链接与构建信息全部保留 -->
  <footer class="border-t border-border bg-bg-panel text-xs text-text-muted">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5">
      <span class="font-semibold text-text">Neuro OJ</span>
      <nav aria-label="页脚导航" class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <NuxtLink :to="workspacePath(domainSlug, 'problems')"
          class="text-text-secondary no-underline hover:text-primary">题库</NuxtLink>
        <NuxtLink :to="workspacePath(domainSlug, 'contests')"
          class="text-text-secondary no-underline hover:text-primary">竞赛</NuxtLink>
        <NuxtLink :to="workspacePath(domainSlug, 'community')"
          class="text-text-secondary no-underline hover:text-primary">社区</NuxtLink>
        <NuxtLink to="/about" class="text-text-secondary no-underline hover:text-primary">关于</NuxtLink>
        <a href="https://docs.noj.xyber-nova.space" target="_blank" rel="noopener"
          class="text-text-secondary no-underline hover:text-primary">文档站</a>
        <a href="https://github.com/Neuro-OJ/neuro-oj" target="_blank" rel="noopener"
          class="text-text-secondary no-underline hover:text-primary">GitHub</a>
        <a href="https://github.com/Neuro-OJ/neuro-oj/discussions" target="_blank" rel="noopener"
          class="text-text-secondary no-underline hover:text-primary">GitHub Discussions</a>
        <a href="https://github.com/Neuro-OJ/neuro-oj/issues" target="_blank" rel="noopener"
          class="text-text-secondary no-underline hover:text-primary">GitHub Issues</a>
        <span class="select-all tabular-nums text-text-secondary">QQ 群 414014391</span>
      </nav>
      <dl aria-label="构建信息" class="ml-auto flex flex-wrap items-center gap-x-3 font-mono text-[11px]">
        <div v-for="row in buildRows" :key="row.label" class="flex items-center gap-1.5">
          <dt>{{ row.label }}</dt>
          <dd class="flex items-center gap-1.5 tabular-nums">
            <span>{{ row.version }}</span>
            <span :title="row.commitFull ?? undefined">{{ row.commit }}</span>
            <ClientOnly :fallback="row.builtAtUtc">
              <span :title="row.builtAtIso ?? undefined">{{ row.builtAtLocal }}</span>
            </ClientOnly>
          </dd>
        </div>
      </dl>
    </div>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-subtle px-4 py-2">
      <span>&copy; {{ year }} Neuro OJ. 独立社区项目，与 CCF 及 LMCC 无官方关系。</span>
      <a href="https://github.com/Neuro-OJ/neuro-oj/blob/main/LICENSE" target="_blank" rel="noopener"
        class="text-text-muted no-underline hover:text-primary">AGPL-3.0</a>
      <NuxtLink to="/data-policy" class="text-text-muted no-underline hover:text-primary">数据使用与注销说明</NuxtLink>
      <NuxtLink to="/legal/privacy" class="text-text-muted no-underline hover:text-primary">隐私政策</NuxtLink>
      <NuxtLink to="/legal/terms" class="text-text-muted no-underline hover:text-primary">服务条款</NuxtLink>
      <!-- 备案信息：未配置时不渲染（见 buildFilingLinks） -->
      <a
        v-for="link in filingLinks"
        :key="link.label"
        :href="link.url"
        target="_blank"
        rel="noopener"
        class="text-text-muted no-underline hover:text-primary"
      >{{ link.label }}</a>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { workspacePath } from '~/utils/domain/workspace/workspace';
const domainSlug = useNavigationDomain();
import { buildFilingLinks, EMPTY_SITE_META } from '~/utils/server/siteMeta';
import { type BuildInfo, commitDisplay, commitFull, formatBuiltAt, normalizeVersion } from '~/utils/buildInfo';

const year = new Date().getFullYear();

// 备案信息（公开端点，失败静默降级为不展示）
const { api } = useApi();
const { data: metaData } = await useAsyncData('site-meta', () =>
  api.get<{ data: typeof EMPTY_SITE_META }>(
    '/api/v1/site/meta',
    { silent: true },
  ));
const filingLinks = computed(() => buildFilingLinks(metaData.value?.data ?? EMPTY_SITE_META));

/** 空构建身份：字段缺失时统一渲染 `unknown`，而不是整行消失。 */
const EMPTY_BUILD: BuildInfo = { version: '', commit: null, builtAt: null };

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
  [
    { label: '前端', info: uiBuild.value },
    { label: '后端', info: coreBuild.value },
  ].map(({ label, info }) => ({
    label,
    version: normalizeVersion(info.version),
    commit: commitDisplay(info.commit),
    commitFull: commitFull(info.commit),
    builtAtLocal: formatBuiltAt(info.builtAt),
    builtAtUtc: formatBuiltAt(info.builtAt, 'UTC'),
    builtAtIso: info.builtAt,
  }))
);
</script>
