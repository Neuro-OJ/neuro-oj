import { eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../tests/helpers/db.ts";
import { domains, users } from "../../../shared/db/schema.ts";
import {
  addDomainMember,
  createDomain,
  setMemberRoles,
} from "../../access/workspace/index.ts";
import { updateSetting } from "../../platform/system/index.ts";
import { createClassroom } from "../index.ts";

/** 教学测试账号仅存在于隔离数据库，不走账号批量创建产品流程。 */
export async function account() {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 建立两个独立学校，教练只在第一个学校获得教学人员角色。 */
export async function educationFixture() {
  await resetDbForTest();
  const db = getDb();
  await updateSetting("domain_creation_policy", "open", "0");
  const owner = await account(),
    teacher = await account(),
    assistant = await account(),
    student = await account();
  const school = await createDomain({
    slug: "class-school",
    name: "学校",
    preset: "education",
  }, owner);
  const other = await createDomain({
    slug: "other-school",
    name: "另一学校",
    preset: "education",
  }, owner);
  for (const domain of [school, other]) {
    await db.transaction(async (tx) => {
      // 夹具无并发，按公开成员服务的前置条件持有账号及域锁。
      for (const user of [teacher, assistant, student].sort()) {
        await tx.select().from(users).where(eq(users.id, user)).for("update");
      }
      await tx.select().from(domains).where(eq(domains.id, domain.id)).for(
        "update",
      );
      for (const user of [teacher, assistant, student]) {
        await addDomainMember(tx, domain.id, user);
      }
    });
  }
  await setMemberRoles(school.slug, owner, teacher, ["educator"]);
  const classroom = await createClassroom(school.slug, teacher, {
    name: "一班",
    stage_tag: "基础",
  });
  return { db, owner, teacher, assistant, student, school, other, classroom };
}
