/** 社区初始数据，保持幂等，供启动期和测试环境复用。 */

import { getDb } from "../../../../db/connection.ts";
import { communityBoards } from "../../../../db/schema.ts";

const DEFAULT_BOARDS = [
  {
    slug: "general",
    name: "综合讨论",
    description: "OJ 使用、学习与站务交流",
    sort_order: 0,
  },
  {
    slug: "learning",
    name: "算法学习",
    description: "算法与编程学习讨论",
    sort_order: 1,
  },
] as const;

export async function ensureCommunitySeeds(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  for (const board of DEFAULT_BOARDS) {
    await db.insert(communityBoards).values({
      id: crypto.randomUUID(),
      ...board,
      created_at: now,
      updated_at: now,
    }).onConflictDoNothing({ target: communityBoards.slug });
  }
}
