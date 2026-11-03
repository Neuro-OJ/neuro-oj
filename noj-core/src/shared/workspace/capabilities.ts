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

/** 访问与加入政策可修改；能力和首页由类型确定，旧 custom 等待人工转换。 */
export function effectiveDomainConfiguration(
  preset: StoredDomainPreset,
  stored: StoredDomainConfiguration,
): DomainConfiguration {
  if (preset === "custom") {
    // 旧 custom 行可能仍带派生字段；保留它们，缺失时给出安全默认。
    const legacy = stored as Partial<DomainConfiguration>;
    return {
      ...stored,
      features: legacy.features ?? {
        community: false,
        classroom: false,
        assignment: false,
        analytics: false,
      },
      homepage: legacy.homepage ?? "overview",
    };
  }
  const fixed = domainTypeConfiguration(preset);
  return { ...stored, features: fixed.features, homepage: fixed.homepage };
}
