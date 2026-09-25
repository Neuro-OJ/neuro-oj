/**
 * legal 配置项与 data-policy 端点测试。
 *
 * 覆盖：legal 分类配置项注册；`/api/v1/data-policy` 改读 legal_* 键
 * （响应结构保持 { contact, deployment } 兼容）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { createApp } from "../../../../app.ts";

Deno.test({
  name: "legal settings: 配置项已注册且分类为 legal",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { CONFIG_DEFINITIONS } = await import(
      "../../../../shared/config/settings-registry.ts"
    );
    const legal = CONFIG_DEFINITIONS.filter((d) => d.category === "legal");
    const keys = legal.map((d) => d.key).sort();
    assertEquals(
      keys.includes("legal_operator_name"),
      true,
    );
    assertEquals(keys.includes("legal_contact"), true);
    assertEquals(keys.includes("legal_deployment_notes"), true);
    assertEquals(keys.includes("legal_icp_number"), true);
    assertEquals(keys.includes("legal_police_number"), true);
    assertEquals(keys.includes("legal_third_parties"), true);
    assertEquals(keys.includes("tsa_provider"), true);
    assertEquals(keys.includes("tsa_url"), true);
  },
});

Deno.test({
  name:
    "legal settings: /data-policy 读 legal_contact 与 legal_deployment_notes",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 经 settings 服务写入（会刷新缓存）；直接插表不会命中 getSetting 的缓存。
    const { updateSetting } = await import(
      "../../../system/services/system-settings.ts"
    );
    await updateSetting("legal_contact", "ops@example.test", "0");
    await updateSetting("legal_operator_name", "示例社团", "0");
    await updateSetting(
      "legal_deployment_notes",
      "数据存储于境内，保留期限 180 天。",
      "0",
    );

    const app = createApp();
    const res = await app.request("/api/v1/data-policy");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.contact, "ops@example.test");
    // 2026-09-25 评审：deployment 必须是"部署补充说明"，不是处理者名称
    assertEquals(body.data.deployment, "数据存储于境内，保留期限 180 天。");
  },
});

Deno.test({
  name: "legal settings: 旧 env 键别名仍被读取（DATA_POLICY_*）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    // 模拟"升级后 .env.prod 仍配旧名"的部署：新键为空、旧键别名有值。
    const originalContact = Deno.env.get("DATA_POLICY_CONTACT");
    const originalDeployment = Deno.env.get("DATA_POLICY_DEPLOYMENT");
    Deno.env.set("DATA_POLICY_CONTACT", "legacy-ops@example.test");
    Deno.env.set("DATA_POLICY_DEPLOYMENT", "旧版部署说明");
    try {
      const app = createApp();
      const res = await app.request("/api/v1/data-policy");
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data.contact, "legacy-ops@example.test");
      assertEquals(body.data.deployment, "旧版部署说明");
    } finally {
      if (originalContact === undefined) Deno.env.delete("DATA_POLICY_CONTACT");
      else Deno.env.set("DATA_POLICY_CONTACT", originalContact);
      if (originalDeployment === undefined) {
        Deno.env.delete("DATA_POLICY_DEPLOYMENT");
      } else Deno.env.set("DATA_POLICY_DEPLOYMENT", originalDeployment);
    }
  },
});

Deno.test({
  name: "legal settings: /site/meta 返回备案与第三方清单",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const { updateSetting } = await import(
      "../../../system/services/system-settings.ts"
    );
    await updateSetting("legal_icp_number", "京ICP备00000000号", "0");
    await updateSetting("legal_icp_url", "https://beian.miit.gov.cn/", "0");
    await updateSetting("legal_operator_name", "示例社团", "0");
    await updateSetting("legal_contact", "privacy@example.test", "0");
    await updateSetting(
      "legal_third_parties",
      JSON.stringify([{ name: "LLM Provider", purpose: "评测" }]),
      "0",
    );

    const app = createApp();
    const res = await app.request("/api/v1/site/meta");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.icp_number, "京ICP备00000000号");
    assertEquals(body.data.icp_url, "https://beian.miit.gov.cn/");
    assertEquals(body.data.police_number, "");
    assertEquals(body.data.operator_name, "示例社团");
    assertEquals(body.data.contact, "privacy@example.test");
    assertEquals(JSON.parse(body.data.third_parties).length, 1);
    // secret 项（tsa_root_cert）绝不出现
    assertEquals("tsa_root_cert" in body.data, false);
  },
});
