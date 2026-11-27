/**
 * 系统设置兼容入口（权威实现已迁入 `shared/config/system-settings.ts`）。
 */
export {
  _resetSystemSettingsForTest,
  cleanupBootstrapRow,
  getSetting,
  hashSecret,
  initSystemSettings,
  listOrphanedBootstrapRows,
  listRuntimeEnvConflicts,
  listSettings,
  maskSecret,
  notifySettingsChanged,
  refreshSettingsCache,
  registerSettingsInvalidationListener,
  reloadSingleKey,
  resetSetting,
  SECRET_MASK,
  updateSetting,
} from "../../../shared/config/system-settings.ts";
export type {
  RuntimeEnvConflict,
  SettingValue,
  SystemSettingListItem,
} from "../../../shared/config/system-settings.ts";
