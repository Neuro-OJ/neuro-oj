/** 跨模块窄能力合同；只列出生产调用方实际需要的符号。 */
export {
  assertPermission,
  checkPermission,
  findPlatformRole,
  getAdminUserIds,
  getUserPermissions,
  isCurrentUserAdmin,
  isUserAdmin,
  requirePermission,
  resolvePermissions,
} from "../../identity/services/security/permissions.ts";
