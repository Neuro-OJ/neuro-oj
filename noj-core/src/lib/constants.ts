/**
 * 全仓库共享常量。
 */

/** root 系统用户 ID（UID=0，admin 角色，随机密码不可登录） */
export const ROOT_USER_ID = "0";

/** 题目满分阈值（得分字段为满分 × 100 后的整数） */
export const FULL_SCORE = 10000;

/** 一天的秒数 */
export const SECONDS_PER_DAY = 24 * 60 * 60;

/** JWT 密钥最短长度（HS256 安全下限，main.ts 启动校验） */
export const MIN_JWT_SECRET_LENGTH = 32;

/** TFA TOTP secret 加密密钥最短长度（AES-256-GCM，main.ts 启动校验） */
export const MIN_TFA_ENCRYPTION_KEY_LENGTH = 32;

/** Redis BRPOP/BLPOP 拉取超时（秒） */
export const DEFAULT_BLPOP_TIMEOUT = 10;
