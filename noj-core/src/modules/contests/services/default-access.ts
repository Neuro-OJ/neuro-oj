import { getDb } from "../../../shared/db/connection.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
} from "../../../shared/workspace/types.ts";
import { ensureDefaultWorkspace } from "../../access/contracts/cross-module/workspace_services_domains.ts";
import { loadWorkspace } from "../../access/contracts/cross-module/workspace_services_access.ts";
import { findContestRow } from "./contest-row.ts";
import { resolveContestId } from "./contests.ts";

/** 无域前缀入口固定默认域，不能用其他域比赛 ID 进入读题、榜单或执行链。 */
export async function resolveDefaultContestAccess(
  reference: string,
  actorId: string | null,
) {
  const db = getDb();
  await ensureDefaultWorkspace(db);
  await loadWorkspace(DEFAULT_DOMAIN_SLUG, actorId);
  const id = await resolveContestId(reference);
  const row = await findContestRow(id);
  if (row.domain_id !== null && row.domain_id !== DEFAULT_DOMAIN_ID) {
    throw new NotFoundError("默认域不存在此比赛");
  }
  return id;
}
