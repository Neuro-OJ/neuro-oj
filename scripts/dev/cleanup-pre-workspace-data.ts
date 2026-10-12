/**
 * 本地开发库的 P/U 升级前清理；默认仅盘点。
 * --apply 必须同时提供已验证备份、SHA-256 和准确的旧数据数量。
 * 不删除对象存储字节、账号或 P 题，不支持远程数据库或生产环境。
 */
import postgres from "postgres";

function option(name: string) {
  return Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(
    name.length + 3,
  );
}

const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) throw new Error("请显式指定本地开发数据库 DATABASE_URL");
const target = new URL(databaseUrl);
if (
  Deno.env.get("NOJ_ENV") !== "development" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
  !(target.pathname === "/noj" ||
    /^\/noj_upgrade_[a-z0-9_]+$/.test(target.pathname))
) {
  throw new Error(
    "仅允许 development 模式下的本地 noj 或 noj_upgrade_* 开发库",
  );
}

const apply = Deno.args.includes("--apply");
if (apply) {
  const backup = option("backup");
  const expectedHash = option("sha256");
  if (!backup || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error("执行清理必须提供 --backup 和 --sha256");
  }
  const bytes = await Deno.readFile(backup);
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "PGDMP") {
    throw new Error("备份不是 PostgreSQL custom archive");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = [...new Uint8Array(digest)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  if (actual !== expectedHash) throw new Error("备份 SHA-256 不匹配");
}

const database = postgres(databaseUrl, { max: 1 });
try {
  await database.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    if (apply) {
      await tx`LOCK TABLE public.problems, public.contests IN SHARE ROW EXCLUSIVE MODE`;
    }
    const [before] = await tx<
      Array<
        {
          u: number;
          p: number;
          contests: number;
          users: number;
          affected_submissions: number;
          affected_objective: number;
        }
      >
    >`
      SELECT
        (SELECT count(*)::int FROM public.problems WHERE type = 'U') AS u,
        (SELECT count(*)::int FROM public.problems WHERE type = 'P') AS p,
        (SELECT count(*)::int FROM public.contests) AS contests,
        (SELECT count(*)::int FROM public.users) AS users,
        (SELECT count(*)::int FROM public.submissions s WHERE s.contest_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.problems p WHERE p.id = s.problem_id AND p.type = 'U')) AS affected_submissions,
        (SELECT count(*)::int FROM public.objective_submissions s WHERE s.contest_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.problems p WHERE p.id = s.paper_id AND p.type = 'U')) AS affected_objective
    `;
    console.log(JSON.stringify({ mode: apply ? "apply" : "preview", before }));
    if (!apply) return;
    const expectedU = Number(option("expect-u"));
    const expectedContests = Number(option("expect-contests"));
    if (
      !Number.isInteger(expectedU) || !Number.isInteger(expectedContests) ||
      before.u !== expectedU || before.contests !== expectedContests
    ) throw new Error("开发数据数量已变化，清理已取消；请重新盘点");

    // 先移除无外键的搜索引用，再删除提交及拥有删除限制的自测。
    await tx`DELETE FROM public.search_entries e WHERE
      (e.entity_type = 'problem' AND e.entity_id IN (SELECT id FROM public.problems WHERE type = 'U'))
      OR (e.entity_type = 'contest' AND e.entity_id IN (SELECT id FROM public.contests))
      OR (e.entity_type = 'submission' AND e.entity_id IN (SELECT s.id FROM public.submissions s WHERE s.contest_id IS NOT NULL OR s.problem_id IN (SELECT id FROM public.problems WHERE type = 'U')))
      OR (e.entity_type = 'community_post' AND e.entity_id IN (SELECT id FROM public.community_posts WHERE problem_id IN (SELECT id FROM public.problems WHERE type = 'U')))
      OR (e.entity_type = 'community_comment' AND e.entity_id IN (SELECT c.id FROM public.community_comments c JOIN public.community_posts p ON p.id = c.post_id WHERE p.problem_id IN (SELECT id FROM public.problems WHERE type = 'U')))
      OR e.metadata->>'problem_id' IN (SELECT id FROM public.problems WHERE type = 'U')`;
    await tx`DELETE FROM public.self_tests WHERE problem_id IN (SELECT id FROM public.problems WHERE type = 'U')`;
    await tx`DELETE FROM public.objective_submissions WHERE contest_id IS NOT NULL OR paper_id IN (SELECT id FROM public.problems WHERE type = 'U')`;
    await tx`DELETE FROM public.submissions WHERE contest_id IS NOT NULL OR problem_id IN (SELECT id FROM public.problems WHERE type = 'U')`;
    await tx`DELETE FROM public.contests`;
    await tx`DELETE FROM public.problems WHERE type = 'U'`;
    await tx`REFRESH MATERIALIZED VIEW public.user_rankings`;
    const [after] = await tx<
      Array<{ u: number; p: number; contests: number; users: number }>
    >`
      SELECT
        (SELECT count(*)::int FROM public.problems WHERE type = 'U') AS u,
        (SELECT count(*)::int FROM public.problems WHERE type = 'P') AS p,
        (SELECT count(*)::int FROM public.contests) AS contests,
        (SELECT count(*)::int FROM public.users) AS users
    `;
    if (
      after.u !== 0 || after.contests !== 0 || after.p !== before.p ||
      after.users !== before.users
    ) throw new Error("清理后计数不符合约束，事务回滚");
    console.log(JSON.stringify({ after }));
  });
} finally {
  await database.end();
}
