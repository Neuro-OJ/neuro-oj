<script setup lang="ts">
// 服务条款页（PIPL 合规）。
//
// 渲染当前已发布的服务条款 Markdown；未发布时给出提示。
// 页尾展示个人信息处理者信息。

import { EMPTY_SITE_META } from "~/utils/siteMeta";

const { api } = useApi();

interface LegalDoc {
  kind: string;
  version: number;
  content: string;
  content_hash: string;
  is_material: boolean;
}

const { data, error } = await useAsyncData("legal-terms", () =>
  api.get<{ data: { privacy: LegalDoc | null; terms: LegalDoc | null } }>(
    "/api/v1/legal/documents",
    { silent: true },
  ));

const { data: metaData } = await useAsyncData("legal-terms-meta", () =>
  api.get<{ data: typeof EMPTY_SITE_META }>("/api/v1/site/meta", { silent: true }));

const terms = computed(() => data.value?.data.terms ?? null);
const failed = computed(() => !!error.value);
const operator = computed(() => metaData.value?.data ?? EMPTY_SITE_META);

useSeoMeta({ title: "服务条款" });
</script>

<template>
  <main class="mx-auto max-w-3xl space-y-6 px-6 py-10 text-text">
    <h1 class="text-2xl font-bold">服务条款</h1>
    <p v-if="terms" class="text-sm text-text-muted tabular-nums">版本 v{{ terms.version }}</p>

    <div v-if="failed" class="text-warning-text">暂时无法加载服务条款，请稍后重试。</div>

    <template v-else-if="terms">
      <MarkdownRenderer :content="terms.content" />
    </template>

    <p v-else class="text-text-secondary">
      运营者尚未发布服务条款。请通过本部署已公布的渠道联系管理员。
    </p>

    <section class="rounded-lg border border-border p-4 text-sm space-y-2">
      <h2 class="font-semibold">个人信息处理者</h2>
      <p v-if="operator.operator_name" class="text-text-secondary">处理者：{{ operator.operator_name }}</p>
      <p v-if="operator.contact" class="text-text-secondary">联系方式：{{ operator.contact }}</p>
      <p v-if="!operator.operator_name && !operator.contact" class="text-text-muted">
        运营者尚未配置个人信息处理者信息。
      </p>
    </section>

    <div class="border-t border-border pt-4 text-sm text-text-secondary">
      <NuxtLink to="/legal/privacy" class="text-primary no-underline hover:underline">查看隐私政策</NuxtLink>
      <span class="mx-2">·</span>
      <NuxtLink to="/data-policy" class="text-primary no-underline hover:underline">数据使用与注销说明</NuxtLink>
    </div>
  </main>
</template>
