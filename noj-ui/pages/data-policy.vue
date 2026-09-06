<script setup lang="ts">
useSeoMeta({ title: '数据使用、注销保留与反馈' });
const { api } = useApi();
const { data, error } = await useAsyncData('data-policy', () =>
  api.get<{ data: { contact: string; deployment: string } }>('/api/v1/data-policy', { silent: true }));
</script>

<template>
  <main class="mx-auto max-w-3xl space-y-6 px-6 py-10 text-text">
    <h1 class="text-2xl font-bold">数据使用、注销保留与反馈</h1>
    <UAlert color="warning" variant="subtle" title="部署信息说明"
      description="本页提供平台默认说明。运营者需补充实际部署、备份、第三方服务与保留期限；默认模板不代表自动满足所有法律要求。" />
    <section class="space-y-2">
      <h2 class="text-lg font-semibold">代码、产物和内容的用途与可见范围</h2>
      <p>平台处理账户信息以提供登录、认证和通知，处理代码、上传产物及答卷以执行评测、生成成绩和维护比赛记录。</p>
      <p>提交记录与成绩可能在题目、提交列表、个人主页或赛事排名中展示。代码和产物下载受服务端权限控制，通常仅提交者及获授权的管理人员可访问；不因提交而向所有访客开放源代码或产物。</p>
      <p>帖子、评论、题解及个人资料按各功能的发布状态和访问权限展示。请勿在内容或代码中放入凭据、他人隐私或不应公开的信息。私信按参与者和管理权限访问。</p>
      <p>启用 LLM 评测时，评测请求可能经网关发送给配置的模型服务商。实际服务商、处理区域及额外用途由运营者在下方补充。</p>
    </section>
    <section class="space-y-2">
      <h2 class="text-lg font-semibold">注销清除或替换的信息</h2>
      <p>注销是不可恢复登录的软删除。用户名替换为“已注销用户”，邮箱替换为系统占位地址；清除本地密码哈希、简介、头像引用、邮箱验证令牌、双因素密钥及恢复码、密码重置令牌、第三方登录关联和角色关联。已有封禁标记为解除。</p>
      <p>已有头像会执行存储清理。账户标记注销后，原有登录凭据不能继续访问账户。</p>
    </section>
    <section class="space-y-2">
      <h2 class="text-lg font-semibold">注销后仍保留的信息</h2>
      <p>账户内部标识、注销时间和历史关联继续保留。帖子、评论、题解、题目、代码提交、产物、自测、答卷、评测结果、参赛及成绩记录、私信和审计关联不会随注销自动删除；公共内容的作者名称显示为“已注销用户”。</p>
      <p>正文、代码、历史审计内容或比赛快照中自行填写或先前记录的身份信息不会自动逐项清洗。审计日志按站点配置定期清理；备份及外部服务中的数据不会由账户注销立即清除。需要进一步处理时，请联系运营者。</p>
    </section>
    <section class="space-y-2">
      <h2 class="text-lg font-semibold">本部署的补充说明</h2>
      <p v-if="error" class="text-warning-text">暂时无法加载运营者配置，请稍后重试。</p>
      <p class="whitespace-pre-wrap">{{ data?.data.deployment || '运营者尚未补充实际运营主体、存储区域、保留期限、备份与第三方服务信息。' }}</p>
      <h2 class="text-lg font-semibold">反馈渠道</h2>
      <p class="whitespace-pre-wrap">{{ data?.data.contact || '运营者尚未配置联系渠道，请通过本部署已公布的客服或管理员渠道反馈。' }}</p>
    </section>
  </main>
</template>
