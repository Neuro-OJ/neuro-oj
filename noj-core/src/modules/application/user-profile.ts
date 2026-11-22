/** 用户主页页面组合：读模型聚合与榜单排名在 application 统一编排。 */
import { getMyRanking } from "../read-models/queries/services/rankings.ts";
import {
  getUserProfileAggregate,
  type UserProfileResponse,
} from "../read-models/queries/services/user-profile.ts";

export type { UserProfileResponse };

export async function getUserProfilePage(
  userId: string,
  moderator = false,
  viewer: { viewerId?: string; isAdmin?: boolean } = {},
): Promise<UserProfileResponse & { rank: number | null }> {
  const [profile, ranking] = await Promise.all([
    getUserProfileAggregate(userId, moderator, viewer),
    getMyRanking(userId),
  ]);
  return { ...profile, rank: ranking?.rank ?? null };
}
