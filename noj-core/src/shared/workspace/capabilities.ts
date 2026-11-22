import type {
  DomainConfiguration,
  DomainPreset,
  StoredDomainConfiguration,
  StoredDomainPreset,
} from "./types.ts";

/** 三种域均支持社区和域排行，教学域额外提供班级、作业与学情。 */
export function domainTypeConfiguration(
  preset: DomainPreset,
): DomainConfiguration {
  const education = preset === "education";
  const community = preset === "community";
  return {
    access: community ? "public" : "members",
    discoverable: community,
    join_policy: community ? "open" : "invite",
    features: {
      community: true,
      classroom: education,
      assignment: education,
      analytics: true,
    },
    homepage: community ? "community" : education ? "teaching" : "training",
  };
}

/** 只保留数据库应持久化的可变事实，派生能力不落库。 */
export function storedDomainConfiguration(
  config: DomainConfiguration,
): StoredDomainConfiguration {
  return {
    access: config.access,
    discoverable: config.discoverable,
    join_policy: config.join_policy,
  };
}

/**
 * 访问与加入政策可修改；能力和首页只由域类型推导。
 *
 * 数据库只保存三个存储字段，读取路径不接受客户端或旧行提供的派生能力。
 */
export function effectiveDomainConfiguration(
  preset: StoredDomainPreset,
  stored: StoredDomainConfiguration,
): DomainConfiguration {
  const fixed = domainTypeConfiguration(preset);
  return { ...stored, features: fixed.features, homepage: fixed.homepage };
}
