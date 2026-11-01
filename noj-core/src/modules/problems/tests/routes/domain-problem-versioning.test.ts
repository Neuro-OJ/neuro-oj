import { assertEquals } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { problemVersions } from "../../../../shared/db/schema.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { ensureDefaultWorkspace } from "../../../access/workspace/index.ts";

/**
 * 域出题的草稿/发布契约（补齐无域版本测试删除后的覆盖）。
 *
 * 0.11 删除了无域 `/api/v1/problems/**` 写路由；草稿与发布只存在于
 * `/api/v1/domains/:slug/problems/:reference/{draft,publish}`。这里覆盖删掉的那批断言里
 * 最关键的几条：乐观锁 428/409、发布幂等（相同内容不产生新版本）、非编辑者 403。
 */
const prefix = "/api/v1/domains/main/problems";

const runtimeConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
};

function content(title: string) {
  return {
    kind: "ai",
    title,
    description: "题面",
    samples: [],
    submission_mode: "code",
    runtime_config: runtimeConfig,
    template_content: "",
    artifact_max_size_mb: null,
    llm_config: null,
  };
}

async function fixture() {
  await resetDbForTest();
  await initRedisForTest();
  const app = createApp();
  await ensureDefaultWorkspace();
  const admin = await createUserToken("admin");
  const member = await createUserToken("user");
  return { app, admin, member };
}

Deno.test({
  name: "域出题: 草稿与发布只认 If-Match，428/409 与发布幂等",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { app, admin, member } = await fixture();
    const title = `域草稿题 ${Date.now()}`;
    const created = await jsonRequest(app, prefix, {
      method: "POST",
      token: admin,
      body: { title, description: "初始题面", runtime_config: runtimeConfig },
    });
    assertEquals(created.status, 201);
    // 域创建端点返回**扁平**结构（problem_id / number / draft_revision）
    const body = (await created.json()) as {
      problem_id: string;
      number: number;
      draft_revision: number;
    };
    const problemPrefix = `${prefix}/${body.number}`;
    assertEquals(typeof body.number, "number");

    // 缺 If-Match → 428
    const missing = await jsonRequest(app, `${problemPrefix}/draft`, {
      method: "PUT",
      token: admin,
      body: { content: content(title) },
    });
    assertEquals(missing.status, 428);

    // 过时 revision → 409
    const stale = await jsonRequest(app, `${problemPrefix}/draft`, {
      method: "PUT",
      token: admin,
      headers: { "If-Match": "999" },
      body: { content: content(title) },
    });
    assertEquals(stale.status, 409);

    // 正确 revision → 200，并推进到下一版
    const saved = await jsonRequest(app, `${problemPrefix}/draft`, {
      method: "PUT",
      token: admin,
      headers: { "If-Match": String(body.draft_revision) },
      body: { content: content(`${title} v1`) },
    });
    assertEquals(saved.status, 200);
    const savedJson = (await saved.json()) as {
      revision?: number;
      draft_revision?: number;
      data?: { revision?: number; draft_revision?: number };
    };
    const savedRevision = savedJson.draft_revision ??
      savedJson.revision ??
      savedJson.data?.draft_revision ??
      savedJson.data?.revision;
    assertEquals(typeof savedRevision, "number");
    assertEquals(savedRevision! > body.draft_revision, true);

    // 普通成员写草稿 → 403
    const forbidden = await jsonRequest(app, `${problemPrefix}/draft`, {
      method: "PUT",
      token: member,
      headers: { "If-Match": String(savedRevision) },
      body: { content: content(`${title} hacked`) },
    });
    assertEquals(forbidden.status, 403);

    // 发布缺 If-Match → 428；带正确 revision → 200
    const publishMissing = await jsonRequest(
      app,
      `${problemPrefix}/publish`,
      { method: "POST", token: admin, body: {} },
    );
    assertEquals(publishMissing.status, 428);
    const published = await jsonRequest(app, `${problemPrefix}/publish`, {
      method: "POST",
      token: admin,
      headers: { "If-Match": String(savedRevision) },
      body: { change_note: "首次发布" },
    });
    assertEquals(published.status, 200);

    const db = getDb();
    const countVersions = async () => {
      const [row] = await db.select({ count: sql<number>`count(*)::int` })
        .from(problemVersions).where(
          eq(problemVersions.problem_id, body.problem_id),
        );
      return row!.count;
    };
    assertEquals(await countVersions(), 1);

    // 相同内容重复发布：读取当前草稿 revision 后再发布，版本数必须保持不变
    const draftNow = await jsonRequest(app, `${problemPrefix}/draft`, {
      token: admin,
    });
    const draftJson = (await draftNow.json()) as {
      revision?: number;
      draft_revision?: number;
      data?: { revision?: number; draft_revision?: number };
    };
    const revisionNow = draftJson.revision ?? draftJson.draft_revision ??
      draftJson.data?.revision ?? draftJson.data?.draft_revision;
    assertEquals(typeof revisionNow, "number");
    const repeated = await jsonRequest(app, `${problemPrefix}/publish`, {
      method: "POST",
      token: admin,
      headers: { "If-Match": String(revisionNow) },
      body: { change_note: "重复发布" },
    });
    assertEquals(repeated.status, 200);
    assertEquals(await countVersions(), 1);
  },
});

Deno.test({
  name: "域出题: 自定义 evaluator.command 对普通成员被拒（NOJ-062）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { app, admin, member } = await fixture();
    const title = `域敏感字段题 ${Date.now()}`;
    const rejected = await jsonRequest(app, prefix, {
      method: "POST",
      token: member,
      body: {
        title,
        description: "题面",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "curl http://evil.example",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },
          solution: {
            image: "noj-solution-python",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      },
    });
    assertEquals(rejected.status, 403);

    // 管理员用默认 command 可以创建
    const ok = await jsonRequest(app, prefix, {
      method: "POST",
      token: admin,
      body: {
        title: `${title} admin`,
        description: "题面",
        runtime_config: runtimeConfig,
      },
    });
    assertEquals(ok.status, 201);
  },
});
