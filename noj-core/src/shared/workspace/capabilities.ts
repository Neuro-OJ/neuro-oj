import type {
  DomainConfiguration,
  DomainPreset,
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

/** 访问与加入政策可修改；能力和首页由类型确定，旧 custom 等待人工转换。 */
export function effectiveDomainConfiguration(
  preset: StoredDomainPreset,
  stored: DomainConfiguration,
): DomainConfiguration {
  if (preset === "custom") return stored;
  const fixed = domainTypeConfiguration(preset);
  return { ...stored, features: fixed.features, homepage: fixed.homepage };
}
