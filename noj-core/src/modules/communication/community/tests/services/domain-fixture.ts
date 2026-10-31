import { eq } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import {
  domainProblemBindings,
  domains,
  problems,
  problemShareSettings,
  problemVersions,
  users,
} from "../../../../../shared/db/schema.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
  setMemberRoles,
} from "../../../../access/workspace/index.ts";
import {
  ensureRbacSeeds,
  initSystemSettings,
  updateSetting,
} from "../../../../platform/system/index.ts";
import { importDomainProblem } from "../../../../problems/index.ts";
import { createBoard, createPost, withDomainCommunity } from "../../index.ts";

export async function domainFixture(prefix: string) {
  await resetDbForTest();
  await ensureRbacSeeds();
  await initSystemSettings();
  for (
    const [key, value] of [
      ["community_enabled", true],
      ["community_moments_enabled", true],
      ["community_new_user_review_hours", 0],
      ["community_post_interval_seconds", 0],
    ] as const
  ) await updateSetting(key, value, "0");
  const db = getDb(),
    now = new Date().toISOString(),
    a = crypto.randomUUID(),
    b = crypto.randomUUID(),
    student = crypto.randomUUID();
  await db.insert(users).values(
    [a, b, student].map((id) => ({
      id,
      username: id,
      email: `${id}@example.com`,
      created_at: now,
      updated_at: now,
    })),
  );
  const source = await createDomain(
    { slug: `${prefix}-source`, name: "source", preset: "community" },
    a,
    { approved: true },
  );
  const target = await createDomain(
    { slug: `${prefix}-target`, name: "target", preset: "community" },
    b,
    { approved: true },
  );
  await db.update(domains).set({
    configuration: { ...target.configuration, access: "members" },
  }).where(eq(domains.id, target.id));
  const invite = await createDomainInvitation(
    target.slug,
    b,
    `${student}@example.com`,
  );
  await consumeDomainInvitation(invite.token, student);
  const boardA = await withDomainCommunity(source.slug, a, {
    write: true,
    permission: "community:moderate",
  }, (s) => createBoard({ slug: "general", name: "public board" }, s));
  const boardB = await withDomainCommunity(target.slug, b, {
    write: true,
    permission: "community:moderate",
  }, (s) => createBoard({ slug: "general", name: "private board" }, s));
  const postA = await withDomainCommunity(
    source.slug,
    a,
    { write: true, permission: "community:create" },
    (s) =>
      createPost(
        a,
        {
          type: "discussion",
          board_id: boardA.id,
          title: "public discussion",
          content: "public body",
        },
        s.moderator,
        s,
      ),
  );
  const postB = await withDomainCommunity(
    target.slug,
    b,
    { write: true, permission: "community:create" },
    (s) =>
      createPost(
        b,
        {
          type: "discussion",
          board_id: boardB.id,
          title: "private discussion",
          content: "private body",
        },
        s.moderator,
        s,
      ),
  );
  return {
    db,
    now,
    a,
    b,
    student,
    source,
    target,
    boardA,
    boardB,
    postA,
    postB,
  };
}

export async function sharedItem(f: Awaited<ReturnType<typeof domainFixture>>) {
  const id = crypto.randomUUID(),
    version = crypto.randomUUID(),
    binding = crypto.randomUUID();
  await f.db.insert(problems).values({
    id,
    domain_id: f.source.id,
    owner_id: f.a,
    number: 1001,
    title: "source problem",
    description: "source body",
    visibility: "public",
    judge_type: "oi",
    created_at: f.now,
    updated_at: f.now,
  });
  await f.db.insert(problemVersions).values({
    id: version,
    problem_id: id,
    version: 1,
    content: {
      kind: "oi",
      title: "source problem",
      description: "source body",
      samples: [],
      runtime_config: { languages: ["cpp20"] },
    },
    published_at: f.now,
  });
  await f.db.update(problems).set({ latest_version_id: version }).where(
    eq(problems.id, id),
  );
  await f.db.insert(domainProblemBindings).values({
    id: binding,
    domain_id: f.source.id,
    problem_id: id,
    kind: "owned",
    visibility: "public",
    created_by: f.a,
    created_at: f.now,
    updated_at: f.now,
  });
  await f.db.insert(problemShareSettings).values({
    problem_id: id,
    enabled: true,
    scope: "all",
    updated_by: f.a,
    updated_at: f.now,
  });
  const sourceInvite = await createDomainInvitation(
    f.source.slug,
    f.a,
    `${f.b}@example.com`,
  );
  await consumeDomainInvitation(sourceInvite.token, f.b);
  await setMemberRoles(f.source.slug, f.a, f.b, ["editor"]);
  const imported = await importDomainProblem(
    f.target.slug,
    `${f.source.slug}:1001`,
    f.b,
  );
  return {
    id: imported.binding.problem_id,
    sourceId: id,
    version: imported.version_id,
    sourceVersion: version,
    binding,
    targetBinding: imported.binding.id,
  };
}
