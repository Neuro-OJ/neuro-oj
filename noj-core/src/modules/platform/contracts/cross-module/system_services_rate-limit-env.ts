/** 跨模块窄能力合同；只列出生产调用方实际需要的符号。 */
export {
  getClientIp,
  hasDirectPeer,
  isRateLimitEnabled,
  settingBool,
  settingInt,
} from "../../system/services/rate-limit-env.ts";
