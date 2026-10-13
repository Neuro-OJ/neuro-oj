<script setup lang="ts">
import type { OwnSubmissionHistory } from '~/utils/own-submissions';
import { originalAnswerText, ownHistoryProblemLink } from '~/utils/own-submissions';
import { formatDateTime } from '~/utils/submissionFormat';
import { workspacePath } from '~/utils/workspace';
defineProps<{ entry: OwnSubmissionHistory; offerDomainActions?: boolean }>();
</script>
<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <h2
        class="text-xl font-semibold"><span class="mr-2 font-mono">{{ entry.reference.display_ref }}</span>{{ entry.problem.title }}</h2>
      <UButton v-if="ownHistoryProblemLink(entry)" :to="ownHistoryProblemLink(entry)"
        variant="outline">返回使用域题目</UButton>
    </div>
    <p
      class="text-sm text-text-muted">使用域 {{ entry.domain.name }} · {{ entry.domain.slug }} · {{ formatDateTime(entry.created_at) }} · {{ entry.kind === 'objective' ? '客观题' : entry.language }}{{ entry.contest_id ? ' · 比赛提交' : '' }}</p>
    <UAlert v-if="!entry.domain.accessible" color="info" title="当前无法进入此域，保留本人原提交与获授权成绩摘要" />
    <UAlert v-else-if="!entry.resource_available" color="info" title="源资源已不可用，保留本人原提交与获授权成绩摘要" />
    <UButton v-if="offerDomainActions && entry.domain.accessible && entry.resource_available"
      :to="workspacePath(entry.domain.slug, `${entry.kind === 'objective' ? 'objective-submissions' : 'submissions'}/${entry.id}`)"
      variant="outline">进入所属空间提交详情</UButton>
    <UButton v-if="entry.domain.accessible && entry.assignment_origin"
      :to="workspacePath(entry.domain.slug, `assignments/${entry.assignment_origin.assignment_id}`)"
      variant="outline">来源作业</UButton>
    <UCard>
      <h3 class="mb-3 font-semibold">结果摘要</h3>
      <OwnSubmissionSummary :entry="entry" />
    </UCard>
    <UCard v-if="entry.code">
      <h3 class="mb-3 font-semibold">原提交代码</h3>
      <pre class="max-h-[32rem] overflow-auto whitespace-pre font-mono text-xs">{{ entry.code }}</pre>
    </UCard>
    <UCard v-if="entry.file_name">
      <p class="text-sm">原提交文件：{{ entry.file_name }}</p>
    </UCard>
    <ArtifactDownload v-if="entry.kind === 'submission' && entry.has_artifact" :key="entry.id"
      :endpoint="`/api/v1/me/submissions/submission/${encodeURIComponent(entry.id)}/artifact`"
      :file-name="entry.file_name ?? `submission-${entry.id}.zip`" />
    <UCard v-if="entry.kind === 'objective' && entry.answers">
      <h3 class="mb-3 font-semibold">本人原回答</h3>
      <p v-for="(answer, key, index) in entry.answers" :key="key"
        class="mb-2 text-sm"><span class="text-text-muted">答案条目 {{ index + 1 }}：</span>{{ originalAnswerText(answer) }}</p>
      <p class="text-xs text-text-muted">这里保留原提交选择，不展示标准答案、解析或逐题正确性。</p>
    </UCard>
  </div>
</template>
