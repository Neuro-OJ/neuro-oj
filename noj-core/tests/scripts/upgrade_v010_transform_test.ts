/**
 * `v0.10.6 → v0.11` 逻辑迁移纯转换与 CLI 参数解析单元测试（零外部依赖）。
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1";
import {
  assignReceiptSequences,
  computeTrainingState,
  DEFAULT_DOMAIN_ID,
  normalizeAuditAction,
  normalizeUtcMillisIso,
  ORPHAN_JOB_ITEM_REASON_CODE,
  planAccessDecisions,
  planProblemNumbers,
  resolveAdminUserIds,
  resolveAnswerVersionId,
  resolveModerationActionDomainId,
  resolveNotificationDomainId,
  selectDefaultDomainOwner,
  topoSortSelfFk,
  transformOrphanJobItem,
  UpgradeV010Error,
} from "../../scripts/upgrade-v010/index.ts";
import { deterministicUuid } from "../../scripts/upgrade-v010/copy-helpers.ts";
import {
  executeUpgradeCli,
  formatUpgradeReport,
  parseUpgradeCliArgs,
} from "../../scripts/upgrade-from-v010.ts";

Deno.test("planProblemNumbers: P 题保号，U 题从 max(1000, maxP)+1 顺序重排并避让碰撞", () => {
  const plan = planProblemNumbers([
    {
      id: "p1",
      type: "P",
      number: 1001,
      title: "公开题 A",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "p2",
      type: "P",
      number: 1003,
      title: "公开题 B",
      created_at: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "u2",
      type: "U",
      number: 1002,
      title: "个人题 2",
      created_at: "2026-01-03T00:00:00.000Z",
    },
    {
      id: "u1",
      type: "U",
      number: 1001,
      title: "个人题 1",
      created_at: "2026-01-04T00:00:00.000Z",
    },
  ]);

  assertEquals(plan.numberById.get("p1"), 1001);
  assertEquals(plan.numberById.get("p2"), 1003);
  assertEquals(plan.numberById.get("u1"), 1004);
  assertEquals(plan.numberById.get("u2"), 1005);
  assertEquals(plan.nextProblemNumber, 1006);
  assertEquals(
    plan.renumbered.map((r) => ({
      id: r.id,
      old: r.oldNumber,
      now: r.newNumber,
    })),
    [
      { id: "u1", old: 1001, now: 1004 },
      { id: "u2", old: 1002, now: 1005 },
    ],
  );
});

Deno.test("planProblemNumbers: 拒绝非法 type 或重复 P 题号", () => {
  assertThrows(
    () =>
      planProblemNumbers([
        {
          id: "bad-p1",
          type: "P",
          number: 1001,
          title: "A",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "bad-p2",
          type: "P",
          number: 1001,
          title: "B",
          created_at: "2026-01-01T00:00:01.000Z",
        },
      ]),
    UpgradeV010Error,
    "重复的 P 题号",
  );
  assertThrows(
    () =>
      planProblemNumbers([
        {
          id: "bad-type",
          type: "X",
          number: 1001,
          title: "X",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ]),
    UpgradeV010Error,
    "不受支持",
  );
});

Deno.test("resolveAdminUserIds & selectDefaultDomainOwner: 识别继承角色并防环、正确回退 root", () => {
  const users = [
    { id: "0", deleted_at: null },
    { id: "u-z", deleted_at: null },
    { id: "u-a", deleted_at: null },
    { id: "u-del", deleted_at: "2026-02-01T00:00:00.000Z" },
    { id: "u-normal", deleted_at: null },
  ];
  const roles = [
    { id: "r-root", parent_id: null },
    { id: "r-sub", parent_id: "r-root" },
    { id: "r-cyc-a", parent_id: "r-cyc-b" },
    { id: "r-cyc-b", parent_id: "r-cyc-a" },
  ];
  const permissions = [
    { id: "perm-admin", resource: "admin", action: "full_access" },
    { id: "perm-read", resource: "problem", action: "read" },
  ];
  const rolePermissions = [
    { role_id: "r-root", permission_id: "perm-admin" },
    { role_id: "r-cyc-a", permission_id: "perm-read" },
  ];
  const userRoles = [
    { user_id: "u-z", role_id: "r-sub" },
    { user_id: "u-a", role_id: "r-root" },
    { user_id: "u-del", role_id: "r-root" },
    { user_id: "u-normal", role_id: "r-cyc-b" },
  ];

  const admins = resolveAdminUserIds(
    users,
    roles,
    rolePermissions,
    permissions,
    userRoles,
  );
  assert(admins.has("0"));
  assert(admins.has("u-z"));
  assert(admins.has("u-a"));
  assert(!admins.has("u-del"));
  assert(!admins.has("u-normal"));

  assertEquals(selectDefaultDomainOwner(users, admins), "u-a");
  assertEquals(
    selectDefaultDomainOwner(
      [{ id: "0", deleted_at: null }, { id: "u-normal", deleted_at: null }],
      new Set(["0"]),
    ),
    "0",
  );
});

Deno.test("topoSortSelfFk: 父节点始终先于子节点，环与悬空引用立即抛错", () => {
  const sorted = topoSortSelfFk(
    [
      { id: "c2", parent_id: "c1" },
      { id: "c1", parent_id: "root" },
      { id: "root", parent_id: null },
    ],
    (r) => r.id,
    (r) => r.parent_id,
    "community_comments",
  );
  assertEquals(sorted.map((r) => r.id), ["root", "c1", "c2"]);

  assertThrows(
    () =>
      topoSortSelfFk(
        [
          { id: "a", parent_id: "b" },
          { id: "b", parent_id: "a" },
        ],
        (r) => r.id,
        (r) => r.parent_id,
        "community_comments",
      ),
    UpgradeV010Error,
    "自引用环",
  );

  assertThrows(
    () =>
      topoSortSelfFk(
        [{ id: "a", parent_id: "missing" }],
        (r) => r.id,
        (r) => r.parent_id,
        "submissions",
      ),
    UpgradeV010Error,
    "不存在的父记录",
  );
});

Deno.test("状态、域归属、审计动作与回执序号映射规则", () => {
  assertEquals(computeTrainingState("public"), "published");
  assertEquals(computeTrainingState("unlisted"), "published");
  assertEquals(computeTrainingState("private"), "draft");

  assertEquals(resolveNotificationDomainId("follow"), null);
  assertEquals(resolveNotificationDomainId("ban"), null);
  assertEquals(resolveNotificationDomainId("reply"), DEFAULT_DOMAIN_ID);
  assertEquals(resolveNotificationDomainId("moderation"), DEFAULT_DOMAIN_ID);

  assertEquals(resolveModerationActionDomainId("message"), null);
  assertEquals(resolveModerationActionDomainId("user_ban"), null);
  assertEquals(resolveModerationActionDomainId("post"), DEFAULT_DOMAIN_ID);

  assertEquals(
    normalizeAuditAction("domain.member_roles"),
    "domain.member_role",
  );
  assertEquals(normalizeAuditAction("roles.create"), null);
  assertEquals(
    normalizeAuditAction("community.board_role_grant_delete"),
    null,
  );
  assertEquals(normalizeAuditAction("users.ban"), "users.ban");

  const seq = assignReceiptSequences(
    [
      { id: "s2", created_at: "2026-01-01T00:00:03.000Z" },
      { id: "s1", created_at: "2026-01-01T00:00:01.000Z" },
    ],
    [{ id: "o1", created_at: "2026-01-01T00:00:02.000Z" }],
  );
  assertEquals(seq.submissionSeqById.get("s1"), 1);
  assertEquals(seq.objectiveSeqById.get("o1"), 2);
  assertEquals(seq.submissionSeqById.get("s2"), 3);
  assertEquals(seq.maxSequence, 3);

  assertEquals(
    normalizeUtcMillisIso("2026-05-01T12:00:00Z", "t"),
    "2026-05-01T12:00:00.000Z",
  );
});

Deno.test("deterministicUuid、CLI 参数解析与凭证脱敏报告", async () => {
  const u1 = await deterministicUuid("binding", DEFAULT_DOMAIN_ID, "prob-1");
  const u2 = await deterministicUuid("binding", DEFAULT_DOMAIN_ID, "prob-1");
  const u3 = await deterministicUuid("binding", DEFAULT_DOMAIN_ID, "prob-2");
  assertEquals(u1, u2);
  assert(u1 !== u3);
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(u1),
  );

  const parsed = parseUpgradeCliArgs(
    ["--source-url", "postgres://user:secret@host/src", "--dry-run", "--json"],
    { NOJ_UPGRADE_TARGET_URL: "postgres://user:secret@host/dst" },
  );
  assertEquals(parsed.sourceUrl, "postgres://user:secret@host/src");
  assertEquals(parsed.targetUrl, "postgres://user:secret@host/dst");
  assertEquals(parsed.dryRun, true);
  assertEquals(parsed.json, true);

  const missingCode = await executeUpgradeCli({}, {});
  assertEquals(missingCode, 1);

  const rendered = formatUpgradeReport({
    dryRun: true,
    executedAt: "2026-11-20T00:00:00.000Z",
    defaultDomainId: DEFAULT_DOMAIN_ID,
    defaultDomainSlug: "main",
    defaultDomainOwnerId: "u-a",
    sourceMigrationCount: 115,
    targetMigrationCount: 144,
    tableCounts: { users: 5, problems: 3 },
    archivedSummary: {
      renumberedProblems: [],
      skippedMomentPosts: [],
      skippedMomentComments: 0,
      skippedMessageReports: 1,
      skippedMomentReports: 0,
      skippedMessageSearchEntries: 1,
      skippedMomentSearchEntries: 0,
      skippedAuditLogs: 1,
      droppedSystemSettings: ["tsa_provider"],
      droppedLegacyTables: { roles: 2 },
      privateProblems: [],
      restrictedContests: [],
      orphanJobItems: [],
    },
    gateway: {
      detected: true,
      copiedProviders: 1,
      copiedUsage: 2,
      copiedQuotas: 1,
      backfilledDomainSettings: 1,
      backfilledModelAliases: 1,
      standalone: null,
    },
  });
  assert(rendered.includes("DRY-RUN"));
  assert(!rendered.includes("postgres://"));
  assert(!rendered.includes("secret"));

  await assertRejects(
    () => Promise.reject(new UpgradeV010Error("INVALID_OPTIONS", "bad url")),
    UpgradeV010Error,
    "bad url",
  );
});

Deno.test("planAccessDecisions: 已发布私有题与受限比赛未指定处置时阻断，指定后按策略落地", () => {
  const problems = [
    {
      id: "pub",
      title: "公开题",
      owner_id: "u1",
      visibility: "public",
      latest_version_id: "v1",
    },
    {
      id: "priv-draft",
      title: "未发布私有题",
      owner_id: "u1",
      visibility: "private",
      latest_version_id: null,
    },
    {
      id: "priv-pub",
      title: "已发布私有题",
      owner_id: "u2",
      visibility: "private",
      latest_version_id: "v2",
    },
  ];
  const contests = [
    {
      id: "c-open",
      title: "公开赛",
      is_public: true,
      kind: "public",
      password: null,
    },
    {
      id: "c-hidden",
      title: "非公开赛",
      is_public: false,
      kind: "public",
      password: null,
    },
    {
      id: "c-invite",
      title: "邀请赛",
      is_public: true,
      kind: "invite",
      password: null,
    },
    {
      id: "c-pass",
      title: "口令赛",
      is_public: true,
      kind: "public",
      password: "secret-pass",
    },
  ];

  const err = assertThrows(
    () => planAccessDecisions(problems, contests, {}),
    UpgradeV010Error,
  );
  assertEquals(err.code, "ACCESS_DECISION_REQUIRED");
  assertEquals(err.details?.privateProblemIds, ["priv-pub"]);
  assertEquals(err.details?.restrictedContestIds, [
    "c-hidden",
    "c-invite",
    "c-pass",
  ]);
  assert(!err.message.includes("secret-pass"));

  // 只处置一类仍阻断
  assertThrows(
    () =>
      planAccessDecisions(problems, contests, {
        privateProblemPolicy: "disable",
      }),
    UpgradeV010Error,
    "--restricted-contests",
  );

  const disabled = planAccessDecisions(problems, contests, {
    privateProblemPolicy: "disable",
    restrictedContestPolicy: "expose",
  });
  assertEquals([...disabled.disabledProblemIds], ["priv-pub"]);
  assertEquals(disabled.privateProblems, [{
    id: "priv-pub",
    title: "已发布私有题",
    ownerId: "u2",
    action: "disable",
  }]);
  assertEquals([...disabled.exposedContestIds], [
    "c-hidden",
    "c-invite",
    "c-pass",
  ]);
  assertEquals(
    disabled.restrictedContests.map((c) => [c.id, c.wasPublic, c.hadPassword]),
    [["c-hidden", false, false], ["c-invite", true, false], [
      "c-pass",
      true,
      true,
    ]],
  );
  assert(!JSON.stringify(disabled.restrictedContests).includes("secret-pass"));

  const exposed = planAccessDecisions(problems, [], {
    privateProblemPolicy: "expose",
  });
  assertEquals(exposed.disabledProblemIds.size, 0);
  assertEquals(exposed.privateProblems[0]?.action, "expose");

  // 无受限数据时无需任何处置参数
  const clean = planAccessDecisions([problems[0]!, problems[1]!], [
    contests[0]!,
  ], {});
  assertEquals(clean.privateProblems, []);
  assertEquals(clean.restrictedContests, []);
});

Deno.test("transformOrphanJobItem: failed/skipped 保留空绑定，其余状态转 skipped 并记录原因", () => {
  const executedAt = "2026-11-20T00:00:00.000Z";
  for (const status of ["failed", "skipped"]) {
    const kept = transformOrphanJobItem(
      { id: "i1", job_id: "j1", problem_id: "gone", status },
      executedAt,
      "2026-01-01T00:00:00.000Z",
    );
    assertEquals(kept.overrides, null);
    assertEquals(kept.entry.importedStatus, status);
  }
  for (const status of ["pending", "preparing", "dispatched", "succeeded"]) {
    const converted = transformOrphanJobItem(
      { id: "i2", job_id: "j1", problem_id: "gone", status },
      executedAt,
      null,
    );
    assertEquals(converted.overrides?.status, "skipped");
    assertEquals(
      converted.overrides?.reason_code,
      ORPHAN_JOB_ITEM_REASON_CODE,
    );
    assertEquals(converted.overrides?.finished_at, executedAt);
    assertEquals(converted.overrides?.lease_owner, null);
    assert(String(converted.overrides?.reason_message).includes(status));
    assertEquals(converted.entry, {
      id: "i2",
      jobId: "j1",
      problemId: "gone",
      originalStatus: status,
      importedStatus: "skipped",
    });
  }
  const finished = transformOrphanJobItem(
    { id: "i3", job_id: "j1", problem_id: "gone", status: "succeeded" },
    executedAt,
    "2026-01-02T00:00:00.000Z",
  );
  assertEquals(finished.overrides?.finished_at, "2026-01-02T00:00:00.000Z");
});

Deno.test("resolveAnswerVersionId: exact 策略锁定版本优先于最新版本", () => {
  assertEquals(resolveAnswerVersionId("v1", "v3"), "v1");
  assertEquals(resolveAnswerVersionId(null, "v3"), "v3");
  assertEquals(resolveAnswerVersionId(null, null), null);
});

Deno.test("CLI: 文档化的纯环境变量写法、处置参数与非法取值", async () => {
  // 文档写法：连接串只走环境变量，参数里没有任何 URL，也不带字面量 `--`
  const envOnly = parseUpgradeCliArgs(
    ["--dry-run", "--json", "--private-problems=disable"],
    {
      NOJ_UPGRADE_SOURCE_URL: "postgres://u:pw@db/src",
      NOJ_UPGRADE_TARGET_URL: "postgres://u:pw@db/dst",
      NOJ_UPGRADE_GATEWAY_URL: "postgres://u:pw@gw/gateway",
    },
  );
  assertEquals(envOnly.sourceUrl, "postgres://u:pw@db/src");
  assertEquals(envOnly.targetUrl, "postgres://u:pw@db/dst");
  assertEquals(envOnly.gatewayUrl, "postgres://u:pw@gw/gateway");
  assertEquals(envOnly.privateProblems, "disable");
  assertEquals(envOnly.restrictedContests, undefined);
  assertEquals(envOnly.dryRun, true);

  // 正式执行同样只靠环境变量
  const realRun = parseUpgradeCliArgs(
    ["--restricted-contests", "expose"],
    {
      NOJ_UPGRADE_SOURCE_URL: "postgres://u:pw@db/src",
      NOJ_UPGRADE_TARGET_URL: "postgres://u:pw@db/dst",
    },
  );
  assertEquals(realRun.dryRun, false);
  assertEquals(realRun.restrictedContests, "expose");

  // 旧文档里 `deno task ... -- --flags` 的字面量 `--` 会被严格解析器拒绝
  assertThrows(() => parseUpgradeCliArgs(["--", "--dry-run"], {}));
  assertThrows(
    () => parseUpgradeCliArgs(["--private-problems=hide"], {}),
    UpgradeV010Error,
    "disable 或 expose",
  );
  assertThrows(
    () => parseUpgradeCliArgs(["--restricted-contests=disable"], {}),
    UpgradeV010Error,
    "仅支持 expose",
  );

  // 非法处置值在连接数据库前即失败，且错误输出不含连接串
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    const code = await executeUpgradeCli({
      privateProblems: "hide",
      json: true,
    }, {
      NOJ_UPGRADE_SOURCE_URL: "postgres://u:pw@127.0.0.1:1/src",
      NOJ_UPGRADE_TARGET_URL: "postgres://u:pw@127.0.0.1:1/dst",
    });
    assertEquals(code, 1);
  } finally {
    console.error = originalError;
  }
  const output = errors.join("\n");
  assert(output.includes("INVALID_OPTIONS"));
  assert(!output.includes("pw@"));
});
