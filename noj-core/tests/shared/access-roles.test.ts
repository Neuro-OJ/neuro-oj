/**
 * 固定角色与静态能力映射的表驱动测试。
 *
 * 断言的是“某类操作允许/拒绝”，而不是“数组里有几个字符串”：能力集合是
 * 授权事实的唯一来源，创建者特权、共享能力与旧 RBAC 通行证都不得被授予。
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  CAPABILITIES,
  DOMAIN_MEMBER_ROLES,
  DOMAIN_ROLES,
  type DomainRole,
  domainRoleCapabilities,
  isDomainMemberRole,
  isDomainRole,
  isPlatformRole,
  LEGACY_CAPABILITIES,
  parseDomainMemberRole,
  parsePlatformRole,
  PLATFORM_ROLES,
  platformRoleCapabilities,
  resolveEffectiveDomainRole,
} from "../../src/shared/access/roles.ts";
import { BadRequestError } from "../../src/shared/base/errors.ts";

const MEMBER_ONLY = [
  "problem:read",
  "submission:create",
  "submission:read_own",
  "contest:participate",
  "training:read",
  "community:read",
  "community:create_discussion",
  "community:create_solution",
  "community:comment",
  "community:report",
] as const;

const EDUCATOR_ONLY = [
  "problem:create",
  "problem:publish",
  "problem:import",
  "problem:write_any",
  "problem:delete_any",
  "problem:policy",
  "submission:read_all",
  "submission:rejudge",
  "contest:create",
  "contest:manage",
  "contest:anti_cheat_read",
  "training:create",
  "training:write_any",
  "training:delete_any",
  "training:import",
  "classroom:create",
  "classroom:manage_any",
  "community:moderate",
  "community_board:manage",
] as const;

const ADMIN_ONLY = [
  "domain:settings",
  "domain:members",
  "domain:invitations",
  "domain:archive",
  "domain:limits",
  "llm:manage",
] as const;

const PLATFORM_ONLY = [
  "admin:full_access",
  "user:manage",
  "tag:manage",
  "announcement:manage",
  "legal:manage",
  "system:settings",
  "system:judge_images",
  "system:audit_logs",
  "system:ip_bans",
  "problem:field_evaluator_command",
  "problem:field_evaluator_network",
] as const;

function allowed(
  capabilities: ReadonlySet<string>,
  capability: string,
): boolean {
  return capabilities.has(capability);
}

Deno.test("access roles: 有效域角色由 owner_id 与成员单值角色推导", () => {
  const domain = { owner_id: "owner-1" };
  assertEquals(
    resolveEffectiveDomainRole("owner-1", domain, { role: "admin" }),
    "owner",
    "负责人优先于成员角色列",
  );
  assertEquals(
    resolveEffectiveDomainRole("member-1", domain, { role: "member" }),
    "member",
  );
  assertEquals(
    resolveEffectiveDomainRole("educator-1", domain, { role: "educator" }),
    "educator",
  );
  assertEquals(
    resolveEffectiveDomainRole("outsider", domain, null),
    null,
    "无成员关系不能默认解释成 member",
  );
  assertEquals(
    resolveEffectiveDomainRole("outsider", { owner_id: "owner-1" }, null),
    null,
    "负责人也必须有有效成员记录",
  );
});

Deno.test("access roles: member 只有参与能力，没有管理或创建者特权", () => {
  const member = domainRoleCapabilities("member");
  for (const capability of MEMBER_ONLY) {
    assert(allowed(member, capability), `member 应具备 ${capability}`);
  }
  for (
    const capability of [
      ...EDUCATOR_ONLY,
      ...ADMIN_ONLY,
      ...PLATFORM_ONLY,
      "problem:write_own",
      "problem:delete_own",
      "training:write_own",
      "training:delete_own",
    ]
  ) {
    assert(
      !allowed(member, capability),
      `member 不得具备 ${capability}（创建者特权已删除）`,
    );
  }
});

Deno.test("access roles: educator 管理全域业务但不管理成员、限额与 Provider", () => {
  const educator = domainRoleCapabilities("educator");
  for (const capability of [...MEMBER_ONLY, ...EDUCATOR_ONLY]) {
    assert(allowed(educator, capability), `educator 应具备 ${capability}`);
  }
  for (const capability of [...ADMIN_ONLY, ...PLATFORM_ONLY]) {
    assert(!allowed(educator, capability), `educator 不得具备 ${capability}`);
  }
});

Deno.test("access roles: admin 具备 educator 全部能力并增加域治理", () => {
  const admin = domainRoleCapabilities("admin");
  for (
    const capability of [...MEMBER_ONLY, ...EDUCATOR_ONLY, ...ADMIN_ONLY]
  ) {
    assert(allowed(admin, capability), `admin 应具备 ${capability}`);
  }
  assertEquals(allowed(admin, "domain:transfer"), false, "交接只属于负责人");
  for (const capability of PLATFORM_ONLY) {
    assert(
      !allowed(admin, capability),
      `域管理员不得具备平台能力 ${capability}`,
    );
  }
});

Deno.test("access roles: owner 只增加负责人交接能力", () => {
  const owner = domainRoleCapabilities("owner");
  const admin = domainRoleCapabilities("admin");
  assertEquals(allowed(owner, "domain:transfer"), true);
  for (const capability of admin) {
    assert(allowed(owner, capability), `owner 应继承 admin 能力 ${capability}`);
  }
  for (const capability of PLATFORM_ONLY) {
    assert(!allowed(owner, capability), `owner 不得具备平台能力 ${capability}`);
  }
});

Deno.test("access roles: 平台 user 只有参与能力，平台 admin 拥有全部能力", () => {
  const user = platformRoleCapabilities("user");
  const admin = platformRoleCapabilities("admin");
  for (const capability of MEMBER_ONLY) {
    assert(allowed(user, capability), `平台用户应具备 ${capability}`);
  }
  for (
    const capability of [...EDUCATOR_ONLY, ...ADMIN_ONLY, ...PLATFORM_ONLY]
  ) {
    assert(!allowed(user, capability), `平台用户不得具备 ${capability}`);
  }
  for (const capability of CAPABILITIES) {
    assert(allowed(admin, capability), `平台管理员应具备 ${capability}`);
  }
  assertEquals(allowed(admin, "domain:transfer"), true);
});

Deno.test("access roles: 域角色永远不获得平台管理员标识", () => {
  for (const role of DOMAIN_ROLES) {
    assertEquals(
      allowed(domainRoleCapabilities(role), "admin:full_access"),
      false,
      `域角色 ${role} 不得伪装成平台管理员`,
    );
  }
});

Deno.test("access roles: 过渡期旧能力永不被授予任何角色", () => {
  const bundles: Array<[string, ReadonlySet<string>]> = [
    ...DOMAIN_ROLES.map((role): [string, ReadonlySet<string>] => [
      `domain:${role}`,
      domainRoleCapabilities(role),
    ]),
    ...PLATFORM_ROLES.map((role): [string, ReadonlySet<string>] => [
      `platform:${role}`,
      platformRoleCapabilities(role),
    ]),
  ];
  for (const [label, capabilities] of bundles) {
    for (const legacy of LEGACY_CAPABILITIES) {
      assertEquals(
        allowed(capabilities, legacy),
        false,
        `${label} 不得具备已删除能力 ${legacy}`,
      );
    }
  }
});

Deno.test("access roles: 角色写入只接受单值并拒绝 owner 与数组", () => {
  assertEquals(parsePlatformRole("user"), "user");
  assertEquals(parsePlatformRole("admin"), "admin");
  for (
    const invalid of ["owner", "editor", ["admin"], null, undefined, 1, {}]
  ) {
    assertThrows(() => parsePlatformRole(invalid), BadRequestError);
  }

  assertEquals(parseDomainMemberRole("member"), "member");
  assertEquals(parseDomainMemberRole("educator"), "educator");
  assertEquals(parseDomainMemberRole("admin"), "admin");
  for (
    const invalid of [
      "owner",
      "editor",
      "moderator",
      ["member"],
      null,
      undefined,
    ]
  ) {
    assertThrows(() => parseDomainMemberRole(invalid), BadRequestError);
  }
});

Deno.test("access roles: 运行时角色集合与类型守卫一致", () => {
  assertEquals([...DOMAIN_ROLES], ["owner", "admin", "educator", "member"]);
  assertEquals([...DOMAIN_MEMBER_ROLES], ["member", "educator", "admin"]);
  assertEquals([...PLATFORM_ROLES], ["user", "admin"]);
  assert(isDomainRole("owner"));
  assert(!isDomainRole("editor"));
  assert(!isDomainRole("moderator"));
  assert(isDomainMemberRole("educator"));
  assert(!isDomainMemberRole("owner"));
  assert(isPlatformRole("admin"));
  assert(!isPlatformRole("root"));
  // 类型层面同样拒绝已删除角色：编译期即可发现残留调用。
  const role: DomainRole = "educator";
  assertEquals(domainRoleCapabilities(role).size > 0, true);
});
