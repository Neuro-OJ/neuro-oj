import {
  getBuiltinOiCostProfile,
  getOiMeteringStandard,
} from "../../catalog/index.ts";
/** 历史键仅用于拒绝旧写入口，数据库中的值不参与计量。 */
export const OI_COST_PROFILE_SETTING_KEY = "oi_cost_profile_active";
/** 每个实例使用同一内置标准，不读取历史成本表。 */
export function getActiveOiCostProfile() {
  return getBuiltinOiCostProfile();
}
/** 管理端查询统一标准，仅支持读取。 */
export function getOiCostProfileStatus() {
  return {
    active: true,
    profile: getBuiltinOiCostProfile(),
    standard: getOiMeteringStandard(),
  };
}
