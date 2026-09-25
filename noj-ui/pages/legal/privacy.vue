<script setup lang="ts">
// 隐私政策页（PIPL 合规）。
//
// 渲染当前已发布的隐私政策 Markdown；未发布时给出提示。
// 运营者在「法律与合规」后台发布内容。页尾展示个人信息处理者信息与第三方清单。

import { buildThirdPartyList, EMPTY_SITE_META } from "~/utils/siteMeta";

const { api } = useApi();

interface LegalDoc {
  kind: string;
  version: number;
  content: string;
  content_hash: string;
  is_material: boolean;
}

const { data, error } = await useAsyncData("legal-privacy", () =>
  api.get<{ data: { privacy: LegalDoc | null; terms: LegalDoc | null } }>(
    "/api/v1/legal/documents",
    { silent: true },
  ));

const { data: metaData } = await useAsyncData("legal-privacy-meta", () =>
  api.get<{ data: typeof EMPTY_SITE_META }>("/api/v1/site/meta", { silent: true }));

const privacy = computed(() => data.value?.data.privacy ?? null);
const failed = computed(() => !!error.value);
const operator = computed(() => metaData.value?.data ?? EMPTY_SITE_META);
const thirdParties = computed(() => buildThirdPartyList(operator.value.third_parties));

useSeoMeta({ title: "隐私政策" });
</script>

<template>
  <main class="mx-auto max-w-3xl space-y-6 px-6 py-10 text-text">
    <h1 class="text-2xl font-bold">隐私政策</h1>
    <p v-if="privacy" class="text-sm text-text-muted tabular-nums">版本 v{{ privacy.version }}</p>

    <div v-if="failed" class="text-warning-text">暂时无法加载隐私政策，请稍后重试。</div>

    <template v-else-if="privacy">
      <MarkdownRenderer :content="privacy.content" />
    </template>

    <p v-else class="text-text-secondary">
      运营者尚未发布隐私政策。请通过本部署已公布的渠道联系管理员。
    </p>

    <section class="rounded-lg border border-border p-4 text-sm space-y-2">
      <h2 class="font-semibold">个人信息处理者</h2>
      <p v-if="operator.operator_name" class="text-text-secondary">
        处理者：{{ operator.operator_name }}
      </p>
      <p v-if="operator.contact" class="text-text-secondary">
        联系方式：{{ operator.contact }}
      </p>
      <p v-if="!operator.operator_name && !operator.contact" class="text-text-muted">
        运营者尚未配置个人信息处理者信息。
      </p>
      <template v-if="operator.deployment_notes">
        <h3 class="font-semibold pt-2">部署与数据留存说明</h3>
        <p class="text-text-secondary whitespace-pre-wrap">{{ operator.deployment_notes }}</p>
      </template>
      <template v-if="thirdParties.length > 0">
        <h3 class="font-semibold pt-2">第三方服务</h3>
        <ul class="list-disc pl-5 text-text-secondary">
          <li v-for="(p, idx) in thirdParties" :key="`${p.name}-${idx}`">
            {{ p.name }}<span v-if="p.purpose">（{{ p.purpose }}）</span>
          </li>
        </ul>
      </template>
    </section>

    <div class="border-t border-border pt-4 text-sm text-text-secondary">
      <NuxtLink to="/legal/terms" class="text-primary no-underline hover:underline">查看服务条款</NuxtLink>
      <span class="mx-2">·</span>
      <NuxtLink to="/data-policy" class="text-primary no-underline hover:underline">数据使用与注销说明</NuxtLink>
    </div>
  </main>
</template>
