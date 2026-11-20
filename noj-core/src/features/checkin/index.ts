/**
 * 每日签到功能对外出口（见 README.md）。
 *
 * 其他功能与旧模块只能从这里引用签到能力；本目录内部文件互相直接引用。
 * 表 `check_ins` 定义保留在 `src/shared/db/schema/identity.ts`。
 */
import { defineFeature } from "../../shared/feature.ts";
import { checkinRouter } from "./routes.ts";

export const feature = defineFeature({
  name: "checkin",
  router: checkinRouter,
});

export {
  checkIn,
  type CheckinHistory,
  type CheckinLeaderboard,
  type CheckinLeaderboardRow,
  type CheckInResponse,
  type CheckinStats,
  getCheckinHistory,
  getCheckinLeaderboard,
  getCheckinStats,
  getTodayCheckIn,
} from "./service.ts";
