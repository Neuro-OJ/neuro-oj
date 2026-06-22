export const meta = {
  name: 'noj-judge-audit',
  description: '全面审查 noj-judge，15 个 finder + 10 个 adversarial verifier + 聚合',
  phases: [
    { title: '审查', detail: '15 个 agents 从不同维度发现问题和意见' },
    { title: '验证', detail: '10 个 agents 对抗性验证排除假阳性' },
    { title: '聚合', detail: '合并验证后的结果形成最终报告' },
  ],
};

const ROOT = '/home/xyber-nova/Github/neuro-oj/noj-judge';

// ── Phase 1: 15 个审查维度 ──────────────────────────────────────
phase('审查');

const FINDERS = [
  {
    key: 'unsafe',
    label: 'unsafe 代码与内存安全',
    prompt: `在 ${ROOT} 中搜索所有 unsafe 代码块、裸指针操作、FFI 调用、以及可能导致内存不安全的模式。检查：
1. 所有 \`unsafe\` 关键字的使用是否必要且安全
2. 是否有未检查的索引访问（特别是容器 ID、路径拼接）
3. 是否有潜在的缓冲区溢出或未初始化内存
4. 是否有 Send/Sync 的 unsafe impl 且未验证线程安全
5. 是否有 \`transmute\` 或指针算术

列出每个发现的位置、代码片段、风险等级（高/中/低）和修复建议。`,
  },
  {
    key: 'concurrency',
    label: '并发与数据竞争',
    prompt: `在 ${ROOT} 中审查所有并发模式。检查：
1. Atomic 操作是否正确（特别是 fetch_sub/fetch_add 的溢出处理）
2. Mutex/RwLock 的使用范围是否合理，是否有死锁风险
3. tokio::spawn 的任务是否有合理的错误处理和取消
4. mpsc channel 的发送/接收是否匹配，是否有 channel 满导致阻塞
5. 共享状态（Arc<>）的修改是否有适当的同步
6. 是否有潜在的 ABA 问题或 relaxed ordering 误用
7. async Drop 的实现是否安全（特别是 ContainerGuard）

列出每个发现的位置、代码片段、风险等级和修复建议。`,
  },
  {
    key: 'error_handling',
    label: '错误处理与 panic 安全',
    prompt: `在 ${ROOT} 中审查所有错误处理模式。检查：
1. unwrap()/expect() 的使用是否合理，是否有在不安全位置使用
2. 是否有被忽略的 Result（let _ = ... 但错误很重要）
3. panic 边界是否清晰，是否有 panic 会跨任务传播
4. 错误类型是否足够表达性（anyhow vs 自定义错误）
5. 是否有错误导致资源泄漏（容器未清理、文件描述符未关闭）
6. 超时处理是否完善（docker exec 超时后容器状态）

列出每个发现的位置、代码片段、风险等级和修复建议。`,
  },
  {
    key: 'resource_leak',
    label: '资源泄漏（容器、文件、内存）',
    prompt: `在 ${ROOT} 中审查所有资源管理路径。检查：
1. 容器创建后是否在所有退出路径上都执行了 docker rm
2. ContainerGuard 的 Drop 实现是否可靠，panic 时是否仍执行 cleanup
3. 临时目录（work_dir）是否在所有路径上被删除
4. tokio::fs 操作是否有错误导致文件泄漏
5. 是否有内存泄漏（循环引用、Arc 循环、全局状态不断增长）
6. leaked_containers 跟踪是否准确
7. 网络连接（Redis、Docker socket）是否在错误时正确关闭

列出每个发现的位置、代码片段、风险等级和修复建议。`,
  },
  {
    key: 'docker_api',
    label: 'Docker API 交互正确性',
    prompt: `在 ${ROOT} 中审查所有 Docker API 调用（bollard）。检查：
1. 容器创建参数是否正确（memory limit、CPU、cap_drop、security_opt）
2. docker exec 的超时和 kill 逻辑是否正确
3. tar pipe 的流式传输是否有死锁风险（pipe buffer 满）
4. cgroup 路径读取是否正确（v1 vs v2 兼容性）
5. 镜像拉取是否有超时和重试
6. 容器标签是否正确设置和用于查找
7. 是否有 Docker socket 路径硬编码问题
8. 容器名冲突处理

列出每个发现的位置、代码片段、风险等级和修复建议。`,
  },
  {
    key: 'config_security',
    label: '配置与安全',
    prompt: `在 ${ROOT} 中审查配置和安全相关代码。检查：
1. 敏感信息（Redis URL、Docker socket）是否可能泄漏
2. 环境变量注入是否有安全风险
3. 容器安全配置（cap_drop、seccomp、readonly_rootfs、no_new_privs）
4. 用户代码执行隔离是否充分
5. 是否有路径遍历风险（support_package_path、work_dir）
6. 是否有命令注入风险（judge_command 解析）
7. 临时文件权限是否安全
8. 是否有 DoS 风险（zip bomb、超大 archive）

列出每个发现的位置、代码片段、风险等级和修复建议。`,
  },
  {
    key: 'network_redis',
    label: '网络与 Redis MQ 交互',
    prompt: `在 ${ROOT} 中审查 Redis 消息队列交互。检查：
1. 连接断开重连逻辑是否完善
2. 消息确认（ACK）是否正确，是否有消息丢失风险
3. 消息反序列化是否有错误处理
4. 是否有消息处理超时导致队列堆积
5. 消费者组（consumer group）使用是否正确
6. 是否有优雅关闭（处理 SIGTERM 时完成当前任务）
7. 是否有心跳/健康检查机制

列出每个发现的位置、代码片段、风险等级和修复建议。`,
  },
  {
    key: 'pool_logic',
    label: '容器池逻辑正确性',
    prompt: `在 ${ROOT}/src/pool/ 中审查容器池核心逻辑。检查：
1. acquire/release 的计数是否一致（in_flight、idle 的加减）
2. 池的初始化（warm-up）是否有竞态条件
3. 健康检查逻辑是否正确（容器是否真的存活）
4. 回补（replenish）逻辑是否在正确时机触发
5. 池的缩容是否安全（不会销毁正在使用的容器）
6. 多镜像池的隔离是否正确
7. 池状态快照（snapshot）是否一致
8. ContainerGuard 的 release() 是否幂等

列出每个发现的位置、代码片段、风险等级和修复建议。`,
  },
  {
    key: 'scaler_logic',
    label: '自动扩缩容逻辑',
    prompt: `在 ${ROOT}/src/pool/scaler.rs 中审查自动扩缩容逻辑。检查：
1. QPS 计算是否正确（滑动窗口实现）
2. 扩缩容决策阈值是否合理
3. 是否有震荡（频繁扩缩）风险
4. 事件驱动 vs 轮询的混合是否正确
5. 指标重置时机是否正确
6. 多池场景下 scaler 是否正确隔离
7. 是否有极端情况（0 任务、突发高峰）的处理

列出每个发现的位置、代码片段、风险等级和修复建议。`,
  },
  {
    key: 'metrics_observability',
    label: '指标与可观测性',
    prompt: `在 ${ROOT} 中审查指标和日志。检查：
1. Prometheus 指标是否正确暴露（counter vs gauge 使用）
2. 是否有指标重复或遗漏
3. 结构化日志的字段是否一致（tracing 的 key-value）
4. 是否有敏感信息被记录到日志
5. 日志级别是否合理（error vs warn vs info vs debug）
6. 是否有足够的上下文用于问题排查
7. metrics HTTP 服务是否有安全防护（无认证暴露）

列出每个发现的位置、代码片段、风险等级和修复建议。`,
  },
  {
    key: 'judge_orch',
    label: '评测编排流程',
    prompt: `在 ${ROOT}/src/judge/ 中审查评测编排流程。检查：
1. evaluate_with_pool 的流程是否正确（获取容器→注入代码→执行→清理）
2. 支持包解压和用户代码写入的顺序是否正确
3. archive_and_copy 的 tar 注入是否可靠
4. 结果解析（---RESULT--- 标记）是否健壮
5. 超时/OOM 检测是否正确
6. 旧路径（evaluate_legacy）与新路径的一致性
7. 是否有评测结果丢失的风险
8. 内存峰值读取的时机是否正确

列出每个发现的位置、代码片段、风险等级和修复建议。`,
  },
  {
    key: 'testing',
    label: '测试覆盖',
    prompt: `在 ${ROOT} 中审查测试覆盖。检查：
1. 单元测试是否覆盖了核心逻辑（特别是边界情况）
2. 集成测试是否覆盖了 Docker 交互路径
3. 是否有并发测试
4. 测试是否有泄漏（容器、文件、环境变量）
5. mock/stub 的使用是否合理
6. 是否有测试环境隔离问题
7. 测试是否可重复执行（非幂等测试）

列出每个发现的位置、代码片段、风险等级和修复建议。`,
  },
  {
    key: 'noj_core_interop',
    label: '与 noj-core 的交互',
    prompt: `审查 noj-judge 与 noj-core 的交互协议。检查：
1. JudgeTask 和 JudgeResult 的序列化格式是否匹配 noj-core 的期望
2. 消息队列 topic/queue 命名是否一致
3. 支持包格式（zip）是否兼容
4. 状态码映射是否正确（Accepted, TLE, MLE, RE, WA 等）
5. 是否有协议版本协商机制
6. 错误结果是否包含足够信息供 noj-core 处理

在 ${ROOT}/src/types.rs 和 ${ROOT}/src/main.rs 中查找相关代码。`,
  },
  {
    key: 'noj_ui_interop',
    label: '与 noj-ui 的交互',
    prompt: `审查 noj-judge 与 noj-ui 的间接交互（通过 noj-core）。检查：
1. 评测结果格式是否满足前端展示需求
2. 错误信息是否对用户友好
3. 是否有大结果集导致前端渲染问题
4. 实时状态更新机制是否完善
5. 是否有前后端状态不一致的风险

在 ${ROOT}/src/types.rs 中查找 JudgeResult 定义。`,
  },
  {
    key: 'build_deploy',
    label: '构建与部署',
    prompt: `在 ${ROOT} 中审查构建和部署配置。检查：
1. Cargo.toml 依赖是否正确（版本、feature flags）
2. Dockerfile 是否有多阶段构建优化
3. 是否有不必要的依赖增加构建时间
4. 环境变量文档是否完整
5. 是否有版本信息嵌入（--version 或构建时注入）
6. CI/CD 配置是否完善
7. 是否有开发/生产环境配置分离

列出每个发现的位置、代码片段、风险等级和修复建议。`,
  },
];

const findings = await pipeline(
  FINDERS,
  f => agent(f.prompt, { label: `审查:${f.key}`, phase: '审查', schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '问题标题' },
            file: { type: 'string', description: '文件路径' },
            line: { type: 'string', description: '行号或范围' },
            severity: { type: 'string', enum: ['高', '中', '低'] },
            description: { type: 'string', description: '问题描述' },
            suggestion: { type: 'string', description: '修复建议' },
          },
          required: ['title', 'file', 'line', 'severity', 'description', 'suggestion'],
        },
      },
    },
    required: ['findings'],
  }}),
);

// ── Phase 2: 对抗性验证 ─────────────────────────────────────────
phase('验证');

const allFindings = findings.flat().filter(Boolean).flatMap(r => r.findings);
log(`共发现 ${allFindings.length} 个问题，开始对抗性验证...`);

const VERIFIERS = Array.from({ length: 10 }, (_, i) => ({
  key: `verifier_${i + 1}`,
  label: `验证:agent-${i + 1}`,
}));

// 将 findings 分片给 10 个 verifier
const chunkSize = Math.ceil(allFindings.length / 10);
const chunks = [];
for (let i = 0; i < allFindings.length; i += chunkSize) {
  chunks.push(allFindings.slice(i, i + chunkSize));
}

const verifiedChunks = await parallel(
  chunks.map((chunk, i) => () => {
    const v = VERIFIERS[i];
    const findingsJson = JSON.stringify(chunk, null, 2);
    return agent(
      `你是一个对抗性验证者。对以下每个发现，严格审查其是否为真阳性。对于每个发现：
1. 阅读代码确认问题是否真实存在
2. 考虑是否有缓解因素使问题不那么严重
3. 判断是否为误报（false positive）
4. 如果为真，确认或调整严重等级

返回每个发现的验证结果。

发现列表：
${findingsJson}`,
      { label: v.label, phase: '验证', schema: {
        type: 'object',
        properties: {
          verdicts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                is_real: { type: 'boolean', description: '是否为真阳性' },
                adjusted_severity: { type: 'string', enum: ['高', '中', '低', '信息'] },
                reasoning: { type: 'string', description: '验证推理过程' },
                improved_suggestion: { type: 'string', description: '改进后的修复建议（如适用）' },
              },
              required: ['title', 'is_real', 'adjusted_severity', 'reasoning'],
            },
          },
        },
        required: ['verdicts'],
      }},
    );
  }),
);

// ── Phase 3: 聚合 ────────────────────────────────────────────────
phase('聚合');

const allVerdicts = verifiedChunks.flat().filter(Boolean).flatMap(r => r.verdicts);
const realIssues = allVerdicts.filter(v => v.is_real);
const falsePositives = allVerdicts.filter(v => !v.is_real);

log(`验证完成: ${realIssues.length} 个真阳性, ${falsePositives.length} 个假阳性`);

const bySeverity = { '高': [], '中': [], '低': [], '信息': [] };
for (const issue of realIssues) {
  const sev = issue.adjusted_severity || '低';
  if (bySeverity[sev]) bySeverity[sev].push(issue);
  else bySeverity['低'].push(issue);
}

const report = {
  summary: {
    total_findings: allFindings.length,
    real_issues: realIssues.length,
    false_positives: falsePositives.length,
    by_severity: {
      high: bySeverity['高'].length,
      medium: bySeverity['中'].length,
      low: bySeverity['低'].length,
      info: bySeverity['信息'].length,
    },
  },
  high_severity: bySeverity['高'].map(i => ({
    title: i.title,
    reasoning: i.reasoning,
    suggestion: i.improved_suggestion,
  })),
  medium_severity: bySeverity['中'].map(i => ({
    title: i.title,
    reasoning: i.reasoning,
    suggestion: i.improved_suggestion,
  })),
  low_severity: bySeverity['低'].map(i => ({
    title: i.title,
    reasoning: i.reasoning,
    suggestion: i.improved_suggestion,
  })),
  info: bySeverity['信息'].map(i => ({
    title: i.title,
    reasoning: i.reasoning,
  })),
  false_positives: falsePositives.map(i => ({
    title: i.title,
    reasoning: i.reasoning,
  })),
};

return report;
